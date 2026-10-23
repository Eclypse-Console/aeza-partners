import prisma from "../db.server";
import type { AdminGraphqlClient } from "../models/products.server";
import { runAdminQuery } from "../models/products.server";
import { isLiveOnAeza } from "./aeza-catalog.server";

// Resolves what the main Aeza backend has in a cart (product handle + size)
// to the brand's real Shopify variant, with LIVE price and stock read from
// Shopify at that moment. Called before a shopper pays, so the amount charged
// and the stock check are always current.
//
// Matching is by handle + size, never by SKU alone: brands reuse SKUs across
// products (e.g. two "2816" tops share the same size codes).

export type ResolveRequestItem = { handle: string; size: string | null };

export type SizeOption = { size: string; stock: number | null };

export type ResolvedItem =
  | {
      handle: string;
      size: string | null;
      ok: true;
      variantId: string;
      sku: string | null;
      title: string;
      pricePaise: number;
      compareAtPricePaise: number | null;
      /** null = Shopify doesn't limit sales (untracked, or sells when out of stock) */
      stock: number | null;
      live: boolean;
    }
  | {
      handle: string;
      size: string | null;
      ok: false;
      code: "PRODUCT_NOT_FOUND" | "SIZE_REQUIRED" | "SIZE_NOT_FOUND";
    };

type LiveVariant = {
  id: string;
  price: string;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
  inventoryPolicy: "DENY" | "CONTINUE";
  inventoryItem: { tracked: boolean } | null;
};

const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();
const toPaise = (amount: string | null) =>
  amount === null ? null : Math.round(Number(amount) * 100);

// Shopify's `nodes` query accepts at most 250 ids per call.
const NODES_PAGE_SIZE = 250;

/** Size of a variant: its "Size" option, else its only option value / title. */
function sizeOf(variant: { title: string; options: unknown }): string {
  const options = (variant.options ?? {}) as Record<string, string>;
  const sizeKey = Object.keys(options).find((name) => norm(name).includes("size"));
  if (sizeKey) return options[sizeKey];
  const values = Object.values(options);
  return values.length === 1 ? values[0] : variant.title;
}

async function fetchLiveVariants(
  admin: AdminGraphqlClient,
  ids: string[],
): Promise<Map<string, LiveVariant>> {
  const live = new Map<string, LiveVariant>();
  for (let start = 0; start < ids.length; start += NODES_PAGE_SIZE) {
    const data = await runAdminQuery<{ nodes: Array<LiveVariant | null> }>(
      admin,
      `#graphql
      query LiveVariants($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            price
            compareAtPrice
            inventoryQuantity
            inventoryPolicy
            inventoryItem { tracked }
          }
        }
      }`,
      { ids: ids.slice(start, start + NODES_PAGE_SIZE) },
    );
    for (const node of data.nodes) if (node?.id) live.set(node.id, node);
  }
  return live;
}

function liveStock(variant: LiveVariant | undefined, fallback: number): number | null {
  if (!variant) return fallback;
  if (variant.inventoryItem?.tracked === false || variant.inventoryPolicy === "CONTINUE") {
    return null;
  }
  return variant.inventoryQuantity ?? 0;
}

export async function resolveCartItems(
  admin: AdminGraphqlClient,
  shop: string,
  items: ResolveRequestItem[],
): Promise<{ items: ResolvedItem[]; sizes: Record<string, SizeOption[]> }> {
  const handles = [...new Set(items.map((item) => item.handle))];
  const products = await prisma.shopifyProduct.findMany({
    where: { shop, handle: { in: handles }, deletedAt: null },
    include: { variants: { orderBy: { id: "asc" } } },
  });
  const byHandle = new Map(products.map((product) => [product.handle, product]));

  const live = await fetchLiveVariants(
    admin,
    products.flatMap((product) => product.variants.map((variant) => variant.variantId)),
  );

  const sizes: Record<string, SizeOption[]> = {};
  for (const product of products) {
    sizes[product.handle!] = product.variants.map((variant) => ({
      size: sizeOf(variant),
      stock: liveStock(live.get(variant.variantId), variant.availableQty),
    }));
  }

  const resolved = items.map((item): ResolvedItem => {
    const product = byHandle.get(item.handle);
    if (!product) return { ...item, ok: false, code: "PRODUCT_NOT_FOUND" };

    let variant = product.variants[0];
    if (item.size) {
      const wanted = norm(item.size);
      const match = product.variants.find((v) => norm(sizeOf(v)) === wanted);
      if (!match) return { ...item, ok: false, code: "SIZE_NOT_FOUND" };
      variant = match;
    } else if (product.variants.length !== 1) {
      return { ...item, ok: false, code: "SIZE_REQUIRED" };
    }

    const current = live.get(variant.variantId);
    return {
      ...item,
      ok: true,
      variantId: variant.variantId,
      sku: variant.sku,
      title: product.title,
      pricePaise: toPaise(current?.price ?? null) ?? Math.round(Number(variant.price) * 100),
      compareAtPricePaise: current
        ? toPaise(current.compareAtPrice)
        : variant.compareAtPrice === null
          ? null
          : Math.round(Number(variant.compareAtPrice) * 100),
      stock: liveStock(current, variant.availableQty),
      live: isLiveOnAeza(product),
    };
  });

  return { items: resolved, sizes };
}
