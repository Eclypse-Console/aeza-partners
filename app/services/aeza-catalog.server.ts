import type { ShopifyProduct, ShopifyVariant } from "@prisma/client";
import prisma from "../db.server";

// Adapter between our Shopify product copy and the main Aeza catalog.
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
