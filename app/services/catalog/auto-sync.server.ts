import { PrismaClient } from "@prisma/client";
import prisma from "../../db.server";
import type { AdminGraphqlClient } from "../../models/products.server";
import { runAdminQuery } from "../../models/products.server";
import { unauthenticated } from "../../shopify.server";
import type { GraphqlRequest } from "./full-products.server";
import { runCatalogSync } from "./run.server";

// Runs the catalog pipeline by itself, so a brand's products reach
// CatalogProduct as soon as it connects and stay current afterwards:
//   * after every full Shopify sync (install, nightly): a full run,
//   * after product webhooks, stock changes and publish choices: an
//     incremental run for just those products.
// Off unless CATALOG_SYNC=on, and it needs PRODUCTS_DB (the legacy products
// table: without it every product would look new and get a new id).
//
// One run per store at a time: catalogSyncingSince is a lock. A request
// that finds the store busy is noted in catalogSyncRequestedAt, and the
// running one then does one more full run, which covers it. A run never
// throws: the Shopify data is already saved, so a catalog failure is
// recorded on the store (catalogSyncError) and repaired by the next run.

// A run older than this is assumed dead (the function was killed).
const LOCK_TIMEOUT_MS = 15 * 60 * 1000;
// Full re-runs after requests that arrived during a run, at most.
const MAX_ROUNDS = 3;

declare global {
  // eslint-disable-next-line no-var
  var legacyProductsDb: PrismaClient | undefined;
}

function legacyDb(): PrismaClient {
  global.legacyProductsDb ??= new PrismaClient({ datasourceUrl: process.env.PRODUCTS_DB });
  return global.legacyProductsDb;
}

export function catalogSyncEnabled(): boolean {
  return process.env.CATALOG_SYNC === "on" && Boolean(process.env.PRODUCTS_DB);
}

export function adminGraphql(admin: AdminGraphqlClient): GraphqlRequest {
  return <T>(query: string, variables: Record<string, unknown> = {}) => runAdminQuery<T>(admin, query, variables);
}

// Don't start another full Shopify sync within this long of the last one.
const REFILL_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Starts a full Shopify sync when the mirror lacks published products; its
 * import ends with a full catalog run that builds them. At most once an
 * hour, so a product the export can't return doesn't cause a loop.
 */
async function refillMirror(admin: AdminGraphqlClient, shop: string): Promise<void> {
  const store = await prisma.shopifyStore.findUnique({ where: { shop }, select: { lastFullSyncAt: true } });
  if (store?.lastFullSyncAt && Date.now() - store.lastFullSyncAt.getTime() < REFILL_INTERVAL_MS) return;
  const { startFullProductSync } = await import("../product-sync.server");
  await startFullProductSync(admin, shop);
}

async function claim(shop: string): Promise<Date | null> {
  const now = new Date();
  const { count } = await prisma.shopifyStore.updateMany({
    where: {
      shop,
      OR: [{ catalogSyncingSince: null }, { catalogSyncingSince: { lt: new Date(now.getTime() - LOCK_TIMEOUT_MS) } }],
    },
    data: { catalogSyncingSince: now },
  });
  return count ? now : null;
}

/** Brings the store's catalog up to date: all products, or just `productIds`. */
export async function syncCatalog(shop: string, productIds?: string[]): Promise<void> {
  if (!catalogSyncEnabled()) return;
  if (productIds && productIds.length === 0) return;

  let ids = productIds;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const startedAt = await claim(shop);
    if (!startedAt) {
      await prisma.shopifyStore.updateMany({ where: { shop }, data: { catalogSyncRequestedAt: new Date() } });
      return;
    }
    try {
      const { admin } = await unauthenticated.admin(shop);
      const { plan, missingFromMirror } = await runCatalogSync({
        ops: prisma,
        legacy: legacyDb(),
        shop,
        graphql: adminGraphql(admin),
        productIds: ids,
      });
      const missing = missingFromMirror
        ? `${missingFromMirror} published products aren't in full_ShopifyProducts yet`
        : null;
      await prisma.shopifyStore.update({
        where: { shop },
        data: { lastCatalogSyncAt: new Date(), catalogSyncError: missing },
      });
      console.log(
        `[catalog] ${shop}: ${ids ? `${ids.length} products` : "full run"}, ${plan.rows.length} rows, ${plan.deletes.length} removed${missing ? `; ${missing}` : ""}`,
      );
      if (missing) await refillMirror(admin, shop);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[catalog] ${shop}: run failed: ${message}`);
      await prisma.shopifyStore.update({ where: { shop }, data: { catalogSyncError: message.slice(0, 1000) } }).catch(() => {});
    } finally {
      await prisma.shopifyStore.update({ where: { shop }, data: { catalogSyncingSince: null } }).catch(() => {});
    }

    const store = await prisma.shopifyStore.findUnique({ where: { shop }, select: { catalogSyncRequestedAt: true } });
    if (!store?.catalogSyncRequestedAt || store.catalogSyncRequestedAt < startedAt) return;
    // Something changed while this run was busy: one full run catches all of it.
    ids = undefined;
  }
}
