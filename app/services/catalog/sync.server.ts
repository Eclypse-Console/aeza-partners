// Loads one brand's inputs for planCatalog (Shopify mirror in aeza-ops, the
// legacy products table in the main products database, metaobject values)
// and writes the plan back to the ops catalog tables.
//
// Both Prisma clients are passed in: `ops` is the app's database
// (DATABASE_URL), `legacy` points at PRODUCTS_DB and is only read here.

import type { PrismaClient } from "@prisma/client";
import { CATALOG_COLUMNS, PRODUCT_COLUMNS, selectList, upsertSql } from "./columns.ts";
import type { LinkInput, MetaobjectInput, PlanResult, ProductRow, ShopifyProductInput } from "./plan.ts";

const BATCH = 50;
// Links / jobs per statement (small rows, so bigger batches).
const BULK_BATCH = 500;

// Vector type in the main products database (PRODUCTS_DB), where pgvector lives in public.
export const OPS_VECTOR_TYPE = "vector";

/** Prisma returns numeric as Decimal; the planner works with strings. */
function plain(row: Record<string, unknown>): ProductRow {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value !== null && typeof value === "object" && "toFixed" in value && typeof (value as { toFixed: unknown }).toFixed === "function" && !(value instanceof Date)
      ? String(value)
      : value;
  }
  return out as ProductRow;
}

// ------------------------------------------------------------ Shopify side ---

/**
 * The brand's products from the full Shopify mirror (all, or just
 * `productIds`), with the brand's publish choice. Price, MRP and stock come
 * from ShopifyVariant when it has the variant: stock webhooks update that
 * table, not the mirror.
 */
export async function loadShopifyProducts(
  ops: PrismaClient,
  shop: string,
  productIds?: string[],
): Promise<ShopifyProductInput[]> {
  // Raw mirror rows: JSON columns read by name below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await ops.$queryRawUnsafe<Array<Record<string, any>>>(
    `SELECT f."productId", f.handle, f.title, f.description, f."productType", f.vendor, f.tags, f.status,
            f."categoryName", f.options, f."onlineStoreUrl", f.media, f.metafields, f.collections, f.variants,
            COALESCE(p.published, false) AS published, p."deletedAt"
       FROM shopify_connector."full_ShopifyProducts" f
       LEFT JOIN shopify_connector."ShopifyProduct" p ON p.shop = f.shop AND p."productId" = f."productId"
      WHERE f.shop = $1 ${productIds ? `AND f."productId" = ANY($2::text[])` : ""}
      ORDER BY f.handle`,
    ...(productIds ? [shop, productIds] : [shop]),
  );
  const live = new Map(
    (
      await ops.shopifyVariant.findMany({
        where: { shop, ...(productIds ? { productId: { in: productIds } } : {}) },
        select: { variantId: true, price: true, compareAtPrice: true, availableQty: true },
      })
    ).map((v) => [v.variantId, v]),
  );
  return rows.map((r) => ({
    productId: r.productId,
    handle: r.handle,
    title: r.title,
    description: r.description,
    productType: r.productType || null,
    vendor: r.vendor,
    tags: r.tags ?? [],
    status: r.status,
    categoryName: r.categoryName,
    options: r.options ?? [],
    onlineStoreUrl: r.onlineStoreUrl,
    media: r.media ?? [],
    metafields: r.metafields ?? [],
    collections: r.collections ?? [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    variants: (r.variants ?? []).map((v: Record<string, any>) => {
      const current = live.get(v.id);
      const compareAt = current ? current.compareAtPrice : v.compareAtPrice;
      return {
      id: v.id,
      title: v.title,
      sku: v.sku || null,
      position: v.position ?? null,
      price: String(current ? current.price : v.price),
      compareAtPrice: compareAt === null || compareAt === undefined ? null : String(compareAt),
      inventoryQuantity: current ? current.availableQty : v.inventoryQuantity ?? null,
      inventoryPolicy: v.inventoryPolicy ?? null,
      taxable: v.taxable ?? null,
      selectedOptions: v.selectedOptions ?? [],
      images: v.images ?? [],
      inventoryItem: v.inventoryItem ? { tracked: v.inventoryItem.tracked ?? null } : null,
      };
    }),
    published: Boolean(r.published),
    deletedAt: r.deletedAt ?? null,
  }));
}

/** Metaobject IDs referenced by the products' shopify.* attribute metafields. */
export function metaobjectIds(products: ShopifyProductInput[]): string[] {
  const ids = new Set<string>();
  for (const product of products) {
    for (const m of product.metafields) {
      if (m.namespace !== "shopify" || !m.type.includes("metaobject_reference")) continue;
      for (const id of Array.isArray(m.value) ? m.value : [m.value]) if (typeof id === "string") ids.add(id);
    }
  }
  return [...ids];
}

export type MetaobjectNode = {
  id: string;
  type: string;
  handle: string;
  displayName: string | null;
  fields: Array<{ key: string; value: string | null }>;
} | null;

/**
 * Metaobject values for these IDs: from the cache, fetching the rest from
 * Shopify. A store without read_metaobjects returns nulls; those IDs stay
 * unresolved (not cached) and the planner keeps the existing values.
 */
export async function resolveMetaobjects(
  catalogDb: PrismaClient,
  shop: string,
  ids: string[],
  fetchNodes: (ids: string[]) => Promise<MetaobjectNode[]>,
): Promise<{ values: Map<string, MetaobjectInput>; unresolved: number }> {
  const cached = await catalogDb.metaobjectValue.findMany({ where: { shop, id: { in: ids } } });
  const values = new Map<string, MetaobjectInput>(cached.map((m) => [m.id, { id: m.id, type: m.type, label: m.label, hex: m.hex }]));
  const missing = ids.filter((id) => !values.has(id));
  let unresolved = 0;
  for (let start = 0; start < missing.length; start += 250) {
    const batch = missing.slice(start, start + 250);
    const nodes = await fetchNodes(batch);
    unresolved += nodes.filter((n) => !n).length;
    const entries = nodes.flatMap((node) => {
      if (!node) return [];
      const fields = Object.fromEntries(node.fields.map((f) => [f.key, f.value]));
      const taxonomy = fields.taxonomy_reference ?? fields.pattern_taxonomy_reference ?? null;
      return [{
        id: node.id,
        shop,
        type: node.type,
        handle: node.handle,
        label: fields.label ?? node.displayName,
        hex: fields.color ?? null,
        taxonomyId: typeof taxonomy === "string" ? taxonomy.replace(/^\["?|"?\]$/g, "") : null,
        fields,
      }];
    });
    await catalogDb.metaobjectValue.createMany({ data: entries, skipDuplicates: true });
    for (const entry of entries) values.set(entry.id, { id: entry.id, type: entry.type, label: entry.label, hex: entry.hex });
  }
  return { values, unresolved };
}

export const METAOBJECT_NODES_QUERY = `#graphql
  query MetaobjectValues($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Metaobject { id type handle displayName fields { key value } }
    }
  }`;

// ------------------------------------------------------------- legacy side ---

export type LegacyBrand = { id: string | null; name: string | null; matchedHandles: number };

/**
 * The legacy brand a store corresponds to: the brand whose rows share the
 * most handles with the store's products. `override` (a brand name) wins.
 */
export async function detectLegacyBrand(
  legacy: PrismaClient,
  handles: string[],
  override?: string,
): Promise<LegacyBrand | null> {
  if (override) {
    const rows = await legacy.$queryRawUnsafe<Array<{ brand_id: string | null; brand: string; n: bigint }>>(
      `SELECT brand_id, brand, count(*) AS n FROM products WHERE lower(trim(brand)) = lower(trim($1)) GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 1`,
      override,
    );
    return rows[0] ? { id: rows[0].brand_id, name: rows[0].brand, matchedHandles: 0 } : null;
  }
  if (!handles.length) return null;
  const rows = await legacy.$queryRawUnsafe<Array<{ brand_id: string | null; brand: string; n: bigint }>>(
    `SELECT brand_id, brand, count(DISTINCT handle) AS n FROM products WHERE handle = ANY($1::text[]) GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 1`,
    handles,
  );
  return rows[0] ? { id: rows[0].brand_id, name: rows[0].brand, matchedHandles: Number(rows[0].n) } : null;
}

/** The brand's legacy rows (all, or only those with these handles). */
export async function loadLegacyRows(legacy: PrismaClient, brand: LegacyBrand, handles?: string[]): Promise<ProductRow[]> {
  if (handles && !handles.length) return [];
  const rows = await legacy.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT ${selectList(PRODUCT_COLUMNS)} FROM products
      WHERE ${brand.id ? "brand_id = $1" : "brand = $1"} ${handles ? "AND handle = ANY($2::text[])" : ""}`,
    ...(handles ? [brand.id ?? brand.name, handles] : [brand.id ?? brand.name]),
  );
  return rows.map(plain);
}

/** How much points at each legacy row (interactions, ghost images, creator picks, size charts). */
export async function loadLegacyUsage(legacy: PrismaClient, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await legacy.$queryRawUnsafe<Array<{ id: string; n: bigint }>>(
    `SELECT id::text AS id, sum(n)::bigint AS n FROM (
        SELECT product_id::text AS id, count(*) AS n FROM user_interactions WHERE product_id::text = ANY($1) GROUP BY 1
        UNION ALL SELECT product_id::text, count(*) FROM ghost_mannequin_pipeline WHERE product_id::text = ANY($1) GROUP BY 1
        UNION ALL SELECT product_id::text, count(*) FROM creator_picks WHERE product_id::text = ANY($1) GROUP BY 1
        UNION ALL SELECT product_id::text, count(*) FROM size_chart_products WHERE product_id::text = ANY($1) GROUP BY 1
      ) t GROUP BY 1`,
    ids,
  );
  return new Map(rows.map((r) => [r.id, Number(r.n)]));
}

export async function loadKnownCategories(legacy: PrismaClient): Promise<Set<string>> {
  const rows = await legacy.$queryRawUnsafe<Array<{ c: string }>>(
    `SELECT DISTINCT product_category AS c FROM products WHERE product_category IS NOT NULL`,
  );
  return new Set(rows.map((r) => r.c));
}

// --------------------------------------------------------------- catalog side ---

/** The shop's catalog rows and links (all, or for just these Shopify products). */
export async function loadExisting(catalogDb: PrismaClient, shop: string, productIds?: string[]) {
  const rows = await catalogDb.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT ${selectList(CATALOG_COLUMNS)} FROM shopify_connector."CatalogProduct"
      WHERE shop = $1 ${productIds ? "AND shopify_product_id = ANY($2::text[])" : ""}`,
    ...(productIds ? [shop, productIds] : [shop]),
  );
  const links = await catalogDb.catalogProductLink.findMany({
    where: { shop, ...(productIds ? { shopifyProductId: { in: productIds } } : {}) },
  });
  return {
    rows: rows.map(plain),
    links: links.map<LinkInput>((l) => ({ ...l, reviewedAt: l.reviewedAt })),
  };
}

/** Writes rows, sizes, and links, and deletes removed rows. */
export async function writePlan(catalogDb: PrismaClient, shop: string, plan: PlanResult): Promise<void> {
  if (plan.deletes.length) {
    // Sizes go with the row (ON DELETE CASCADE).
    await catalogDb.catalogProduct.deleteMany({ where: { shop, id: { in: plan.deletes } } });
  }
  for (let start = 0; start < plan.rows.length; start += BATCH) {
    const { sql, params } = upsertSql(`shopify_connector."CatalogProduct"`, CATALOG_COLUMNS, plan.rows.slice(start, start + BATCH), {
      vectorType: OPS_VECTOR_TYPE,
    });
    await catalogDb.$executeRawUnsafe(sql, ...params);
  }

  const productIds = [...new Set(plan.variants.map((v) => v.catalogProductId))];
  await catalogDb.$transaction([
    catalogDb.catalogVariant.deleteMany({ where: { OR: [{ catalogProductId: { in: productIds } }, { variantId: { in: plan.variants.map((v) => v.variantId) } }] } }),
    catalogDb.catalogVariant.createMany({ data: plan.variants }),
  ]);

  // Links in one statement per batch: one round trip per row made a
  // big store's first run outlast the serverless time limit.
  const links = plan.links.filter((link) => !link.reviewed && !link.unchanged);
  for (let start = 0; start < links.length; start += BULK_BATCH) {
    const batch = links.slice(start, start + BULK_BATCH).map((link) => ({ ...link, shop }));
    await catalogDb.$executeRaw`
      INSERT INTO shopify_connector."CatalogProductLink" (
        shop, "shopifyProductId", "colorKey", "legacyProductId", "duplicateLegacyIds",
        status, method, confidence, reason, candidates, "createdAt", "updatedAt"
      )
      SELECT r.shop, r."shopifyProductId", r."colorKey", r."legacyProductId"::uuid,
             ARRAY(SELECT jsonb_array_elements_text(r."duplicateLegacyIds"))::uuid[],
             r.status, r.method, r.confidence, r.reason, r.candidates, now(), now()
        FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) AS r(
          shop text, "shopifyProductId" text, "colorKey" text, "legacyProductId" text,
          "duplicateLegacyIds" jsonb, status text, method text, confidence float8,
          reason text, candidates jsonb
        )
      ON CONFLICT (shop, "shopifyProductId", "colorKey") DO UPDATE SET
        "legacyProductId" = EXCLUDED."legacyProductId",
        "duplicateLegacyIds" = EXCLUDED."duplicateLegacyIds",
        status = EXCLUDED.status,
        method = EXCLUDED.method,
        confidence = EXCLUDED.confidence,
        reason = EXCLUDED.reason,
        candidates = EXCLUDED.candidates,
        "updatedAt" = now()
      WHERE "CatalogProductLink"."reviewedAt" IS NULL
    `;
  }
}
