// One catalog run for one store: Shopify mirror -> plan ->
// shopify_connector."Products" / CatalogVariant / CatalogProductLink
// (all in PRODUCTS_DB).
//
// Only published products (active or draft) get catalog rows. Products
// already in the catalog keep their id and AI work; new ones get a new id.
// The old products table (now public.old_products, a backup) isn't read.
//
// Full run (no productIds): every product in the mirror. Done after each
// full Shopify sync. Incremental run (productIds): just those products, for
// webhooks and publish choices.
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
  loadShopifyProducts,
  metaobjectIds,
  resolveMetaobjects,
  writePlan,
} from "./sync.server.ts";
import type { LegacyBrand, MetaobjectNode } from "./sync.server.ts";
import type { GraphqlRequest } from "./full-products.server.ts";

export type CatalogRunOptions = {
  ops: PrismaClient;
  /** The main products database (PRODUCTS_DB), where shopify_connector."Products" lives. */
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

  // The brand: what the shop's catalog rows already carry (or the CLI
  // override), else the brand saved on the store at onboarding.
  let brand: LegacyBrand | null = await detectLegacyBrand(legacy, shop, options.legacyBrandName);
  if (!brand && store?.legacyBrandId) {
    brand = { id: store.legacyBrandId, name: store.legacyBrandName, matchedHandles: 0 };
  }
  if (brand?.id && full && !dryRun && (store?.legacyBrandId !== brand.id || store?.legacyBrandName !== brand.name)) {
    await ops.shopifyStore.update({ where: { shop }, data: { legacyBrandId: brand.id, legacyBrandName: brand.name } });
  }

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
    // The old products table is retired (public.old_products, a backup).
    legacyRows: [],
    existingRows: existing.rows,
    existingLinks: existing.links,
    metaobjects,
    knownCategories: await loadKnownCategories(legacy),
    removedProductIds,
    allowedSizes: store?.allowedSizes ?? [],
  });

  if (!dryRun) await writePlan(legacy, shop, plan);
  return {
    plan,
    brand,
    legacyRows: 0,
    products: shopifyProducts.length,
    missingFromMirror,
    metaobjects: { total: ids.length, unresolved },
  };
}
