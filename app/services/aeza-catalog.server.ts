import type { ShopifyProduct, ShopifyVariant } from "@prisma/client";
import { waitUntil } from "@vercel/functions";
import prisma from "../db.server";
import { syncCatalog } from "./catalog/auto-sync.server";

// Adapter between our Shopify product copy and the main Aeza catalog. Every
// change also refreshes the catalog pipeline's rows (catalog/auto-sync).
// Not wired to the Aeza backend yet: behind AEZA_SYNC_MODE it is either a
// silent no-op ("off", the default) or logs what it would send ("log").
// Every product change (sync, webhook, publish decision) goes through
// pushProductsToAeza, so connecting the real backend later only means
// implementing upsertToAeza / removeFromAeza.

export type AezaCatalogProduct = ShopifyProduct & { variants: ShopifyVariant[] };

function syncMode(): "off" | "log" {
  return process.env.AEZA_SYNC_MODE === "log" ? "log" : "off";
}

/** Only published, active, not-deleted products are live on Aeza. */
export function isLiveOnAeza(
  product: Pick<ShopifyProduct, "published" | "status" | "deletedAt">,
): boolean {
  return product.published && product.status === "ACTIVE" && !product.deletedAt;
}

export async function upsertToAeza(product: AezaCatalogProduct): Promise<void> {
  console.log(
    `[aeza-catalog] upsert ${product.shop} ${product.productId} (${product.variants.length} variants)`,
  );
}

export async function removeFromAeza(
  shop: string,
  productId: string,
): Promise<void> {
  console.log(`[aeza-catalog] remove ${shop} ${productId}`);
}

/**
 * Sends the current state of these products to Aeza: live ones are
 * upserted, everything else (unpublished, draft, deleted) is removed.
 */
export async function pushProductsToAeza(
  shop: string,
  productIds: string[],
): Promise<void> {
  // Keep the catalog (CatalogProduct) current for these products, in the
  // background so a dashboard Save or webhook doesn't wait for it.
  waitUntil(syncCatalog(shop, productIds));

  if (syncMode() === "off" || productIds.length === 0) return;

  const products = await prisma.shopifyProduct.findMany({
    where: { shop, productId: { in: productIds } },
    include: { variants: true },
  });

  for (const product of products) {
    if (isLiveOnAeza(product)) {
      await upsertToAeza(product);
    } else {
      await removeFromAeza(shop, product.productId);
    }
  }
}
