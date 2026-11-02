import type { PrismaClient } from "@prisma/client";
import { planCatalog } from "../catalog/plan.ts";
import type { PlanResult } from "../catalog/plan.ts";
import { loadExisting, writePlan } from "../catalog/sync.server.ts";
import { finishRows, toProductInput, wooProductGid } from "./map.ts";
import type { WooListing } from "./map.ts";

// One catalog run for a Woo store: Woo products -> planner -> the same catalog
// tables Shopify brands use. It calls the shared planner and writer without
// changing them, and it can only touch this store's rows: everything is keyed
// on `shop`. Skips runCatalogSync on purpose: that detects the brand by
// matching handles (a slug like "flora" could match another brand) and needs a
// Shopify session.

export const KNIT_DOMAIN = {
  shop: "knitdomain.com",
  brand: { id: "4c1f1c76-6900-4b31-852b-fa702fe7c592", name: "Knit Domain" },
  // Not confirmed by the brand yet.
  gender: "unisex",
};

const KNOWN_CATEGORIES = new Set(["T-Shirts"]);

export type WooSyncOptions = {
  catalogDb: PrismaClient;
  listings: WooListing[];
  /** Keep rows off the site (is_active false) until checkout works for this store. */
  hidden: boolean;
  dryRun?: boolean;
};

export async function syncWooCatalog({ catalogDb, listings, hidden, dryRun }: WooSyncOptions): Promise<PlanResult> {
  const { shop, brand, gender } = KNIT_DOMAIN;
  const existing = await loadExisting(catalogDb, shop);

  // A row whose product is gone from Woo altogether. Woo only returns what
  // exists, so unlike Shopify's mirror its absence does mean it's gone.
  const inWoo = new Set(listings.map((listing) => wooProductGid(listing.product.id)));
  const removedProductIds = new Set(
    existing.rows.map((row) => row.shopify_product_id as string).filter((id) => id && !inWoo.has(id)),
  );

  const plan = planCatalog({
    shop,
    brand,
    shopifyProducts: listings.map(toProductInput),
    legacyRows: [],
    existingRows: existing.rows,
    existingLinks: existing.links,
    metaobjects: new Map(),
    knownCategories: KNOWN_CATEGORIES,
    removedProductIds,
  });
  finishRows(plan.rows, listings, { gender });

  if (hidden) {
    for (const row of plan.rows) {
      row.is_active = false;
      row.live_on_aeza = false;
    }
  }

  if (!dryRun) await writePlan(catalogDb, shop, plan);
  return plan;
}
