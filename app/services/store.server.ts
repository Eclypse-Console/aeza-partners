import prisma from "../db.server";
import type { AdminGraphqlClient } from "../models/products.server";
import { pushProductsToAeza } from "./aeza-catalog.server";
import { startFullProductSync } from "./product-sync.server";

/**
 * Called from the afterAuth hook. The library runs that hook whenever it
 * exchanges a session token for a fresh offline token, which happens on
 * install but can also happen again later (e.g. after a token expires), so
 * this only acts when the store isn't already connected: first install, or
 * reinstall after an uninstall.
 */
export async function markStoreConnected(
  shop: string,
  admin: AdminGraphqlClient,
): Promise<void> {
  const store = await prisma.shopifyStore.findUnique({ where: { shop } });
  if (!store || store.status === "connected") return;

  const brandProfile = await prisma.brandProfile.findUnique({
    where: { shop },
    select: { id: true },
  });

  await prisma.shopifyStore.update({
    where: { shop },
    data: {
      status: "connected",
      installedAt: new Date(),
      uninstalledAt: null,
      brandProfileId: store.brandProfileId ?? brandProfile?.id ?? null,
    },
  });

  // A failed sync kick-off must not break the install; the nightly re-sync
  // picks the store up again.
  try {
    await startFullProductSync(admin, shop);
  } catch (error) {
    console.error(`Failed to start initial product sync for ${shop}:`, error);
  }
}

/**
 * app/uninstalled: the token is gone, so drop sessions, mark the store
 * uninstalled and take all its products off Aeza. Product rows are kept, so
 * a reinstall picks up where the brand left off once it re-syncs.
 */
export async function markStoreUninstalled(shop: string): Promise<void> {
  const published = await prisma.shopifyProduct.findMany({
    where: { shop, published: true },
    select: { productId: true },
  });

  await prisma.$transaction([
    prisma.session.deleteMany({ where: { shop } }),
    prisma.shopifyStore.updateMany({
      where: { shop },
      data: { status: "uninstalled", uninstalledAt: new Date() },
    }),
    prisma.shopifyProduct.updateMany({
      where: { shop, published: true },
      data: { published: false },
    }),
  ]);

  await pushProductsToAeza(
    shop,
    published.map((product) => product.productId),
  );
}

/** Links the store to its BrandProfile once the onboarding form is saved. */
export async function linkBrandProfile(
  shop: string,
  brandProfileId: number,
): Promise<void> {
  await prisma.shopifyStore.updateMany({
    where: { shop, brandProfileId: null },
    data: { brandProfileId },
  });
}
