// One catalog run for one store: Shopify mirror + legacy products -> plan ->
// CatalogProduct / CatalogVariant / CatalogProductLink.
//
// Only published products (active or draft) get catalog rows; legacy rows only lend their
// id and AI work to a matching Shopify product.
//
// Full run (no productIds): every product in the mirror, matched against
// every legacy row of the brand. Done after each full Shopify sync.
// Incremental run (productIds): just those products, for webhooks and
// publish choices. Products already in the catalog keep their link; legacy
// rows are only loaded for products that aren't in the catalog yet.
// Either way a row is removed only when the live sync (ShopifyProduct) says
// its product is deleted or unpublished, never because the mirror lacks it.

import type { PrismaClient } from "@prisma/client";
import { inCatalog, planCatalog } from "./plan.ts";
import type { PlanResult } from "./plan.ts";
import {
  METAOBJECT_NODES_QUERY,
  detectLegacyBrand,
  loadExisting,
  loadKnownCategories,
  loadLegacyRows,
  loadLegacyUsage,
  loadShopifyProducts,
  metaobjectIds,
  resolveMetaobjects,
  writePlan,
} from "./sync.server.ts";
import type { LegacyBrand, MetaobjectNode } from "./sync.server.ts";
import type { GraphqlRequest } from "./full-products.server.ts";

export type CatalogRunOptions = {
  ops: PrismaClient;
  /** The main products database (PRODUCTS_DB); only read. */
  legacy: PrismaClient;
  shop: string;
  graphql: GraphqlRequest;
  /** Limit the run to these Shopify products (webhooks); omit for a full run. */
  productIds?: string[];
  /** Brand name in the legacy table, when handle matching can't find it. */
  legacyBrandName?: string;
  dryRun?: boolean;
};

export type CatalogRunResult = {
  plan: PlanResult;
  brand: LegacyBrand | null;
  legacyRows: number;
  products: number;
  /** Published products the mirror doesn't have yet (full runs only). */
  missingFromMirror: number;
  metaobjects: { total: number; unresolved: number };
};

export async function runCatalogSync(options: CatalogRunOptions): Promise<CatalogRunResult> {
  const { ops, legacy, shop, graphql, productIds, dryRun } = options;
  const full = !productIds;

  const shopifyProducts = await loadShopifyProducts(ops, shop, productIds);
  const existing = await loadExisting(legacy, shop, productIds);
  const store = await ops.shopifyStore.findUnique({ where: { shop }, include: { brandProfile: true } });

  // The legacy brand: found by handle on a full run and remembered on the
  // store, so incremental runs (a few handles) can't pick a different one.
  let brand: LegacyBrand | null =
    !full && store?.legacyBrandName ? { id: store.legacyBrandId, name: store.legacyBrandName, matchedHandles: 0 } : null;
  if (!brand) {
    brand = await detectLegacyBrand(legacy, shopifyProducts.map((p) => p.handle), options.legacyBrandName ?? store?.legacyBrandName ?? undefined);
  }
  if (brand && full && !dryRun) {
    await ops.shopifyStore.update({ where: { shop }, data: { legacyBrandId: brand.id, legacyBrandName: brand.name } });
  }

  // Incremental runs only need legacy rows for products not yet in the catalog.
  const alreadyInCatalog = new Set(existing.rows.map((r) => r.shopify_product_id));
  const newHandles = full ? undefined : shopifyProducts.filter((p) => !alreadyInCatalog.has(p.productId)).map((p) => p.handle);
  const legacyRows = brand ? await loadLegacyRows(legacy, brand, newHandles) : [];
  const usage = await loadLegacyUsage(legacy, legacyRows.map((r) => r.id));

  const ids = metaobjectIds(shopifyProducts);
  const { values: metaobjects, unresolved } = await resolveMetaobjects(legacy, shop, ids, async (batch) =>
    (await graphql<{ nodes: MetaobjectNode[] }>(METAOBJECT_NODES_QUERY, { ids: batch })).nodes,
  );

  // Catalog rows whose product isn't in the mirror: the live sync
  // (ShopifyProduct) decides whether it's really gone or unpublished.
  const inMirror = new Set(shopifyProducts.map((p) => p.productId));
  const outside = [...new Set(existing.rows.map((r) => r.shopify_product_id as string | null).filter((id): id is string => !!id && !inMirror.has(id)))];
  const known = await ops.shopifyProduct.findMany({
    where: { shop, productId: { in: outside } },
    select: { productId: true, published: true, status: true, deletedAt: true },
  });
  const stillInCatalog = new Set(known.filter((p) => inCatalog(p)).map((p) => p.productId));
  const removedProductIds = new Set(outside.filter((id) => !stillInCatalog.has(id)));

  // Published products the mirror doesn't have yet can't be built; a full
  // Shopify sync fills the mirror.
  const missingFromMirror = full
    ? await ops.shopifyProduct.count({
        where: { shop, published: true, status: "ACTIVE", deletedAt: null, productId: { notIn: [...inMirror] } },
      })
    : 0;

  const plan = planCatalog({
    shop,
    brand: { id: brand?.id ?? null, name: brand?.name ?? store?.brandProfile?.brandName ?? null },
    shopifyProducts,
    legacyRows,
    existingRows: existing.rows,
    existingLinks: existing.links,
    metaobjects,
    knownCategories: await loadKnownCategories(legacy),
    legacyUsage: usage,
    removedProductIds,
  });

  if (!dryRun) await writePlan(legacy, shop, plan);
  return {
    plan,
    brand,
    legacyRows: legacyRows.length,
    products: shopifyProducts.length,
    missingFromMirror,
    metaobjects: { total: ids.length, unresolved },
  };
}
