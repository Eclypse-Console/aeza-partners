// Publishes catalog rows one way, aeza-ops -> main products database, into
// catalog_products: the products table's shape (same columns, defaults and
// indexes, so apps can switch to it by table name) plus a few catalog
// columns. Nothing else writes catalog_products, and the legacy products
// table is never touched.

import type { PrismaClient } from "@prisma/client";
import { PRODUCT_COLUMNS, PUBLISHED_EXTRA_COLUMNS, selectList, upsertSql } from "./columns.ts";

const PUBLISHED_COLUMNS = { ...PRODUCT_COLUMNS, ...PUBLISHED_EXTRA_COLUMNS };
const SQL_TYPES: Record<string, string> = { "text[]": "text[]", numeric: "numeric(12,2)", int: "integer", bool: "boolean", timestamp: "timestamp", text: "text" };
const BATCH = 50;

export async function ensurePublishedTable(legacy: PrismaClient): Promise<void> {
  await legacy.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS catalog_products (LIKE products INCLUDING DEFAULTS INCLUDING INDEXES)`,
  );
  for (const [name, type] of Object.entries(PUBLISHED_EXTRA_COLUMNS)) {
    await legacy.$executeRawUnsafe(
      `ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS "${name}" ${SQL_TYPES[type] ?? type}`,
    );
  }
  await legacy.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS catalog_products_shop_idx ON catalog_products (shop)`);
  await legacy.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_catalog_products_handle ON catalog_products (handle)`);
}

/**
 * If the shop's brand has 0 products in the legacy products table (i.e. it's a new brand),
 * ensures the brand exists in public.brands and syncs all their normalized products into public.products.
 */
export async function syncNewBrandToLegacy(
  ops: PrismaClient,
  legacy: PrismaClient,
  shop: string,
  rows: Array<Record<string, unknown>>,
): Promise<number> {
  if (rows.length === 0) return 0;

  // 1. Get store & brand profile details from Ops DB
  const store = await ops.shopifyStore.findUnique({
    where: { shop },
    include: { brandProfile: true },
  });

  const brandName = store?.brandProfile?.brandName || store?.legacyBrandName || (rows[0]?.brand as string) || "Brand";
  let brandId = store?.legacyBrandId || store?.brandProfile?.id || null;

  // 2. Ensure brand exists in public.brands (Prod DB)
  const existingBrands = await legacy.$queryRawUnsafe<Array<{ id: string; brand_name: string }>>(
    `SELECT id::text, brand_name FROM public.brands WHERE id = $1::uuid OR brand_name ILIKE $2 LIMIT 1`,
    brandId,
    brandName,
  );

  if (existingBrands.length > 0) {
    brandId = existingBrands[0].id;
    await legacy.$executeRawUnsafe(
      `UPDATE public.brands SET
         brand_name = $2,
         contact_email = COALESCE(contact_email, $3),
         contact_phone = COALESCE(contact_phone, $4),
         website = COALESCE(website, $5),
         clerk_user_id = COALESCE(clerk_user_id, $6),
         is_aeza_catalog = true,
         is_onboarded = true,
         updated_at = now()
       WHERE id = $1::uuid`,
      brandId,
      brandName,
      store?.brandProfile?.contactEmail ?? null,
      store?.brandProfile?.contactPhone ?? null,
      store?.brandProfile?.websiteUrl ?? null,
      store?.brandProfile?.clerkId ?? null,
    );
  } else {
    const inserted = await legacy.$queryRawUnsafe<Array<{ id: string; brand_name: string }>>(
      `INSERT INTO public.brands (
         id, clerk_user_id, brand_name, contact_email, contact_phone,
         website, slug, is_onboarded, is_aeza_catalog, created_at, updated_at
       ) VALUES (
         COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, true, true, now(), now()
       )
       RETURNING id::text, brand_name`,
      brandId,
      store?.brandProfile?.clerkId ?? null,
      brandName,
      store?.brandProfile?.contactEmail ?? null,
      store?.brandProfile?.contactPhone ?? null,
      store?.brandProfile?.websiteUrl ?? null,
      brandName.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    );
    brandId = inserted[0].id;
  }

  // Update store in Ops DB and catalog product brand_id in main DB if missing
  if (brandId) {
    await legacy.$executeRawUnsafe(
      `UPDATE shopify_connector."CatalogProduct" SET brand_id = $1::uuid, brand = $2 WHERE shop = $3 AND (brand_id IS NULL OR brand != $2)`,
      brandId,
      brandName,
      shop,
    );
    if (store && (!store.legacyBrandId || store.legacyBrandName !== brandName)) {
      await ops.shopifyStore.update({
        where: { shop },
        data: { legacyBrandId: brandId, legacyBrandName: brandName },
      });
    }
  }

  // 3. Check if products for this brand exist in legacy public.products
  const countRes = await legacy.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT count(*) FROM public.products WHERE brand_id = $1 OR brand ILIKE $2`,
    brandId,
    brandName,
  );
  const existingCount = Number(countRes[0]?.count ?? 0);

  // If this brand is new to public.products (0 products currently in public.products):
  if (existingCount === 0) {
    console.log(`[publish] New brand "${brandName}" detected with 0 products in legacy products table. Syncing ${rows.length} normalized products to public.products...`);

    const legacyProductRows = rows.map((r) => {
      const copy: Record<string, unknown> = { ...r };
      copy.brand_id = brandId;
      copy.brand = brandName;
      copy.is_active = true;
      return copy;
    });

    for (let start = 0; start < legacyProductRows.length; start += BATCH) {
      const { sql, params } = upsertSql("products", PRODUCT_COLUMNS, legacyProductRows.slice(start, start + BATCH), {
        applyDefaults: true,
      });
      await legacy.$executeRawUnsafe(sql, ...params);
    }

    console.log(`[publish] Successfully added ${legacyProductRows.length} normalized products for "${brandName}" to public.products.`);
    return legacyProductRows.length;
  }

  return 0;
}

/**
 * Makes catalog_products match the shop's catalog: copies every row and
 * removes rows the catalog no longer has. Returns how many were copied.
 * If this is a new brand not yet in the legacy products table, also syncs
 * the brand to public.brands and copies its normalized products to public.products.
 */
export async function publishShop(ops: PrismaClient, legacy: PrismaClient, shop: string): Promise<number> {
  await ensurePublishedTable(legacy);
  const rows = await legacy.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT ${selectList(PUBLISHED_COLUMNS)} FROM shopify_connector."CatalogProduct" WHERE shop = $1 AND shopify_status = 'ACTIVE' AND is_active = true`,
    shop,
  );
  for (let start = 0; start < rows.length; start += BATCH) {
    const { sql, params } = upsertSql("catalog_products", PUBLISHED_COLUMNS, rows.slice(start, start + BATCH), { applyDefaults: false });
    await legacy.$executeRawUnsafe(sql, ...params);
  }
  await legacy.$executeRawUnsafe(
    `DELETE FROM catalog_products WHERE shop = $1 AND NOT (id = ANY($2::uuid[]))`,
    shop,
    rows.map((row) => row.id as string),
  );

  // Automatically sync new brand and its products to legacy products & brands if not already present
  await syncNewBrandToLegacy(ops, legacy, shop, rows);

  return rows.length;
}
