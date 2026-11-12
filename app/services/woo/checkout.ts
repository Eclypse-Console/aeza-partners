// Checkout for WooCommerce brands, behind the same three connector endpoints
// the main Aeza backend uses for Shopify brands (resolve, orders,
// order-fulfillments), so the backend needs no Woo-specific code. Pure: every
// rule here is testable without a store (see checkout.test.ts); the HTTP and
// database side is in orders.server.ts.
//
// Catalog rows for Woo are one per colour with handle "<slug>--<colour>" (or
// just "<slug>" for a single-colour product, see catalogHandle in map.ts); a
// cart line is that handle plus a size, which picks exactly one variation.

import { slugValue } from "../catalog/normalize.ts";
import { colourOf, pricesOf, stockOf, wooSimpleVariantGid, wooVariationGid } from "./map.ts";
import type { WooProduct, WooVariation } from "./map.ts";

/** Woo stores sold through checkout. Keyed by the `shop` value on their catalog rows. */
export const WOO_SHOPS = new Set(["knitdomain.com"]);

export function wooShopOf(value: unknown): string | null {
  const shop = typeof value === "string" ? value.trim().toLowerCase() : "";
  return WOO_SHOPS.has(shop) ? shop : null;
}

const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();
const toPaise = (amount: string | null) => (amount === null || amount === "" ? null : Math.round(Number(amount) * 100));
const COLOUR_ATTRIBUTE = /colou?r/i;

/** "flora--aqua-green" -> { slug: "flora", colorKey: "aqua-green" }; "flora" -> no colour. */
export function parseHandle(handle: string): { slug: string; colorKey: string } {
  const at = handle.indexOf("--");
  return at === -1 ? { slug: handle, colorKey: "" } : { slug: handle.slice(0, at), colorKey: handle.slice(at + 2) };
}

/** The size of a variation: its non-colour attribute (Woo's "Size"). */
export function sizeOfVariation(variation: WooVariation): string {
  const size =
    variation.attributes.find((a) => /size/i.test(a.name)) ?? variation.attributes.find((a) => !COLOUR_ATTRIBUTE.test(a.name));
  return size?.option ?? "";
}

/**
 * What the backend may sell: null when Woo doesn't limit sales (stock not managed, or
 * backorders allowed), else the quantity left - the same meaning as Shopify's resolve.
 */
export function liveStock(item: WooProduct | WooVariation, parent: WooProduct): number | null {
  const stock = stockOf(item, parent);
  if (!stock.tracked || stock.inventoryPolicy === "CONTINUE") return null;
  return Math.max(0, stock.inventoryQuantity ?? 0);
}

/** Sellable variation: published, priced, and every attribute pinned (Woo's "any" can't be shipped). */
function sellable(variation: WooVariation): boolean {
  return variation.status === "publish" && Boolean(variation.price) && variation.attributes.every((a) => a.option);
}

/** Shown on Aeza and buyable: the same rule the catalog sync uses for `published`. */
export function productIsLive(product: WooProduct): boolean {
  return product.status === "publish" && product.catalog_visibility !== "hidden";
}

export type WooResolved =
  | {
      handle: string;
      size: string | null;
      ok: true;
      variantId: string;
      sku: string | null;
      title: string;
      pricePaise: number;
      compareAtPricePaise: number | null;
      stock: number | null;
      live: boolean;
    }
  | { handle: string; size: string | null; ok: false; code: "PRODUCT_NOT_FOUND" | "SIZE_REQUIRED" | "SIZE_NOT_FOUND" };

/**
 * One cart line (handle + size) against the live Woo product, plus every size of
 * that colour with its stock. `product` is null when Woo has no product with the slug.
 */
export function resolveLine(
  handle: string,
  size: string | null,
  product: WooProduct | null,
  variations: WooVariation[],
): { item: WooResolved; sizes: Array<{ size: string; stock: number | null }> } {
  const notFound = { item: { handle, size, ok: false as const, code: "PRODUCT_NOT_FOUND" as const }, sizes: [] };
  if (!product) return notFound;
  const live = productIsLive(product);

  if (product.type !== "variable") {
    if (!product.price) return notFound;
    const prices = pricesOf(product);
    const stock = liveStock(product, product);
    return {
      item: {
        handle, size, ok: true, variantId: wooSimpleVariantGid(product.id), sku: product.sku || null, title: product.name,
        pricePaise: toPaise(prices.price)!, compareAtPricePaise: toPaise(prices.compareAtPrice), stock, live,
      },
      sizes: [{ size: "Free Size", stock }],
    };
  }

  const { colorKey } = parseHandle(handle);
  const ofColour = variations
    .filter(sellable)
    .filter((v) => !colorKey || slugValue(colourOf(v) ?? "") === colorKey)
    .sort((a, b) => a.menu_order - b.menu_order || a.id - b.id);
  if (ofColour.length === 0) return notFound;

  const sizes = ofColour.map((v) => ({ size: sizeOfVariation(v), stock: liveStock(v, product) }));
  let chosen: WooVariation | undefined;
  if (size) chosen = ofColour.find((v) => norm(sizeOfVariation(v)) === norm(size));
  else if (ofColour.length === 1) chosen = ofColour[0];
  if (!chosen) {
    return { item: { handle, size, ok: false, code: size ? "SIZE_NOT_FOUND" : "SIZE_REQUIRED" }, sizes };
  }

  const prices = pricesOf(chosen);
  return {
    item: {
      handle, size, ok: true, variantId: wooVariationGid(chosen.id), sku: chosen.sku || null,
      title: `${product.name} - ${chosen.attributes.map((a) => a.option).join(" / ")}`,
      pricePaise: toPaise(prices.price)!, compareAtPricePaise: toPaise(prices.compareAtPrice),
      stock: liveStock(chosen, product), live,
    },
    sizes,
  };
}

/** gid://woocommerce/ProductVariation/354 -> 354; gid://woocommerce/SimpleProduct/12 -> 12. */
export function parseWooVariantGid(gid: string): { kind: "variation" | "simple"; id: number } | null {
  const match = /^gid:\/\/woocommerce\/(ProductVariation|SimpleProduct)\/(\d+)$/.exec(gid);
  if (!match) return null;
  return { kind: match[1] === "ProductVariation" ? "variation" : "simple", id: Number(match[2]) };
}

export const WOO_VARIANT_GID = /^gid:\/\/woocommerce\/(ProductVariation|SimpleProduct)\/\d+$/;
export const wooOrderGid = (id: number) => `gid://woocommerce/Order/${id}`;
export const AEZA_ORDER_META = "aeza_order_id";

export type WooOrderLine = { productId: number; variationId: number | null; quantity: number; price: string };

export type WooOrderInput = {
  aezaOrderId: string;
  paymentReference: string;
  lines: WooOrderLine[];
  shippingPrice: string;
  customer: { name: string; email: string; phone: string };
  shippingAddress: {
    firstName?: string; lastName?: string; address1: string; address2?: string; city: string;
    provinceCode?: string; zip: string; countryCode: string; phone?: string;
  };
};

const money = (paise: number) => (paise / 100).toFixed(2);
const toMinor = (amount: string) => Math.round(Number(amount) * 100);

/**
 * The body for POST /wc/v3/orders: already paid (set_paid -> "processing", and Woo
 * reduces its own stock), each line at the price the shopper paid, tagged with the
 * Aeza order id so a retry can find it instead of creating a second order.
 */
export function buildWooOrder(input: WooOrderInput) {
  const [first, ...rest] = input.customer.name.trim().split(/\s+/);
  const a = input.shippingAddress;
  const address = {
    first_name: a.firstName ?? first ?? "",
    last_name: a.lastName ?? (rest.join(" ") || first || ""),
    address_1: a.address1,
    address_2: a.address2 ?? "",
    city: a.city,
    state: a.provinceCode ?? "",
    postcode: a.zip,
    country: a.countryCode,
    phone: a.phone ?? input.customer.phone,
  };
  const shipping = toMinor(input.shippingPrice);
  return {
    status: "processing",
    set_paid: true,
    payment_method: "aeza",
    payment_method_title: "Aeza (Cashfree)",
    transaction_id: input.paymentReference,
    customer_note: `Aeza order ${input.aezaOrderId} (payment ${input.paymentReference})`,
    billing: { ...address, email: input.customer.email },
    shipping: address,
    line_items: input.lines.map((line) => {
      const total = money(toMinor(line.price) * line.quantity);
      return {
        product_id: line.productId,
        ...(line.variationId ? { variation_id: line.variationId } : {}),
        quantity: line.quantity,
        subtotal: total,
        total,
      };
    }),
    shipping_lines: shipping > 0 ? [{ method_id: "flat_rate", method_title: "Aeza shipping", total: money(shipping) }] : [],
    meta_data: [{ key: AEZA_ORDER_META, value: input.aezaOrderId }],
  };
}

export type WooOrder = {
  id: number;
  number: string;
  status: string;
  date_created_gmt: string | null;
  date_modified_gmt: string | null;
  date_completed_gmt: string | null;
  meta_data: Array<{ key: string; value: unknown }>;
};

/** The order in this list that was created for this Aeza order, if any. */
export function findAezaOrder(orders: WooOrder[], aezaOrderId: string): WooOrder | null {
  return orders.find((o) => o.meta_data?.some((m) => m.key === AEZA_ORDER_META && m.value === aezaOrderId)) ?? null;
}

const gmt = (value: string | null) => (value ? `${value.replace(/Z$/, "")}Z` : null);
const CANCELLED = new Set(["cancelled", "refunded", "failed", "trash"]);

type TrackingItem = { tracking_provider?: string; custom_tracking_provider?: string; tracking_number?: string; custom_tracking_link?: string };

/**
 * A Woo order in the shape the backend's delivery sync reads (Shopify fulfilments).
 * Plain Woo has no shipments: "completed" means the brand shipped it, and tracking
 * comes from the WooCommerce Shipment Tracking plugin's meta when the store has it.
 */
export function wooOrderStatus(order: WooOrder) {
  if (CANCELLED.has(order.status)) {
    return { cancelledAt: gmt(order.date_modified_gmt), fulfillments: [] };
  }
  if (order.status !== "completed") return { cancelledAt: null, fulfillments: [] };

  const items = (order.meta_data.find((m) => m.key === "_wc_shipment_tracking_items")?.value ?? []) as TrackingItem[];
  const tracking = (Array.isArray(items) ? items : []).map((t) => ({
    company: t.custom_tracking_provider || t.tracking_provider || null,
    number: t.tracking_number || null,
    url: t.custom_tracking_link || null,
  }));
  return {
    cancelledAt: null,
    fulfillments: [
      {
        id: wooOrderGid(order.id),
        displayStatus: "FULFILLED",
        createdAt: gmt(order.date_completed_gmt ?? order.date_modified_gmt),
        inTransitAt: null,
        estimatedDeliveryAt: null,
        deliveredAt: null,
        tracking,
        events: [],
      },
    ],
  };
}
