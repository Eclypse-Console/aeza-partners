// One catalog run for one store: Shopify mirror + legacy products -> plan ->
// CatalogProduct / CatalogVariant / CatalogProductLink / EnrichmentJob.
//
// Full run (no productIds): every product of the store, and every legacy row
// of its brand (unmatched ones are kept as legacy_only). Done after each full
// Shopify sync.
// Incremental run (productIds): just those products, for webhooks and
// publish choices. Products already in the catalog keep their link; legacy
// rows are only loaded for products that aren't in the catalog yet.

import type { PrismaClient } from "@prisma/client";
import { planCatalog } from "./plan.ts";
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
  metaobjects: { total: number; unresolved: number };
};

export async function runCatalogSync(options: CatalogRunOptions): Promise<CatalogRunResult> {
  const { ops, legacy, shop, graphql, productIds, dryRun } = options;
  const full = !productIds;

  const shopifyProducts = await loadShopifyProducts(ops, shop, productIds);
  const existing = await loadExisting(ops, shop, productIds);
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
  const inCatalog = new Set(existing.rows.map((r) => r.shopify_product_id));
  const newHandles = full ? undefined : shopifyProducts.filter((p) => !inCatalog.has(p.productId)).map((p) => p.handle);
  const legacyRows = brand ? await loadLegacyRows(legacy, brand, newHandles) : [];
  const usage = await loadLegacyUsage(legacy, legacyRows.map((r) => r.id));

  const ids = metaobjectIds(shopifyProducts);
  const { values: metaobjects, unresolved } = await resolveMetaobjects(ops, shop, ids, async (batch) =>
    (await graphql<{ nodes: MetaobjectNode[] }>(METAOBJECT_NODES_QUERY, { ids: batch })).nodes,
  );

  const plan = planCatalog({
    shop,
    brand: { id: brand?.id ?? null, name: brand?.name ?? store?.brandProfile?.brandName ?? null },
    shopifyProducts,
    legacyRows,
    existingRows: existing.rows,
    existingLinks: existing.links,
    existingJobs: existing.jobs,
    metaobjects,
    knownCategories: await loadKnownCategories(legacy),
    legacyUsage: usage,
  });

  if (!dryRun) await writePlan(ops, shop, plan);
  return { plan, brand, legacyRows: legacyRows.length, products: shopifyProducts.length, metaobjects: { total: ids.length, unresolved } };
}
