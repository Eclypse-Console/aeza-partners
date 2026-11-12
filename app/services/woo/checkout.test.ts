// Woo checkout rules (resolve, order body, status). Run: npm run test:woo

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildWooOrder,
  findAezaOrder,
  liveStock,
  parseHandle,
  parseWooVariantGid,
  resolveLine,
  wooOrderStatus,
  wooShopOf,
} from "./checkout.ts";
import type { WooOrder } from "./checkout.ts";
import type { WooProduct, WooVariation } from "./map.ts";

const product = (fields: Partial<WooProduct> = {}): WooProduct => ({
  id: 313, slug: "flora", name: "Flora", type: "variable", status: "publish", catalog_visibility: "visible",
  description: "", short_description: "", permalink: "", price: "690", regular_price: "850", sku: "",
  tax_status: "taxable", images: [{ src: "x.jpg" }], categories: [], tags: [], attributes: [],
  manage_stock: false, stock_quantity: null, stock_status: "instock", backorders: "no", ...fields,
});

let seq = 400;
const variation = (colour: string | null, size: string, fields: Partial<WooVariation> = {}): WooVariation => ({
  id: ++seq, status: "publish", sku: "", price: "690", regular_price: "850", menu_order: seq, tax_status: "taxable", image: null,
  attributes: [...(colour ? [{ name: "Color", option: colour }] : []), { name: "Size", option: size }],
  manage_stock: true, stock_quantity: 4, stock_status: "instock", backorders: "no", ...fields,
});

test("only Woo stores are routed to Woo", () => {
  assert.equal(wooShopOf(" KnitDomain.com "), "knitdomain.com");
  assert.equal(wooShopOf("sajke-in.myshopify.com"), null);
  assert.equal(wooShopOf(undefined), null);
});

test("handles carry the colour after a double dash", () => {
  assert.deepEqual(parseHandle("aqua-bloom--petrol-blue"), { slug: "aqua-bloom", colorKey: "petrol-blue" });
  assert.deepEqual(parseHandle("1901-legendary-velocipede"), { slug: "1901-legendary-velocipede", colorKey: "" });
});

test("resolve picks the variation of the handle's colour and the requested size, with live price and stock", () => {
  const blueM = variation("Petrol Blue", "M", { stock_quantity: 3, price: "999", regular_price: "1150" });
  const vars = [variation("Beige", "M"), blueM, variation("Petrol Blue", "L", { stock_quantity: 0 })];
  const { item, sizes } = resolveLine("aqua-bloom--petrol-blue", "m", product({ slug: "aqua-bloom" }), vars);
  assert.equal(item.ok, true);
  if (!item.ok) return;
  assert.equal(item.variantId, `gid://woocommerce/ProductVariation/${blueM.id}`);
  assert.equal(item.pricePaise, 99900);
  assert.equal(item.compareAtPricePaise, 115000);
  assert.equal(item.stock, 3);
  assert.equal(item.live, true);
  assert.deepEqual(sizes, [{ size: "M", stock: 3 }, { size: "L", stock: 0 }]);
});

test("resolve reports a missing size, a needed size and a missing product", () => {
  const vars = [variation("Cream", "S"), variation("Cream", "M")];
  assert.equal((resolveLine("flora--cream", "XXL", product(), vars).item as any).code, "SIZE_NOT_FOUND");
  assert.equal((resolveLine("flora--cream", null, product(), vars).item as any).code, "SIZE_REQUIRED");
  assert.equal((resolveLine("flora--green", "S", product(), vars).item as any).code, "PRODUCT_NOT_FOUND");
  assert.equal((resolveLine("gone", "S", null, []).item as any).code, "PRODUCT_NOT_FOUND");
});

test("unpublished variations and 'any' attributes are never sold", () => {
  const vars = [variation("Cream", "S", { status: "private" }), { ...variation("Cream", "M"), attributes: [{ name: "Color", option: "Cream" }, { name: "Size", option: "" }] }];
  assert.equal((resolveLine("flora--cream", "S", product(), vars).item as any).code, "PRODUCT_NOT_FOUND");
});

test("a hidden or draft product resolves but is not live", () => {
  const vars = [variation("Cream", "S")];
  const hidden = resolveLine("flora--cream", "S", product({ catalog_visibility: "hidden" }), vars).item;
  assert.equal(hidden.ok && hidden.live, false);
});

test("stock: managed + no backorders = a limit; untracked or backorders = no limit", () => {
  const parent = product();
  assert.equal(liveStock(variation(null, "S", { stock_quantity: 2 }), parent), 2);
  assert.equal(liveStock(variation(null, "S", { stock_quantity: -1 }), parent), 0);
  assert.equal(liveStock(variation(null, "S", { backorders: "notify" }), parent), null);
  assert.equal(liveStock(variation(null, "S", { manage_stock: false, stock_status: "instock" }), parent), null);
  assert.equal(liveStock(variation(null, "S", { manage_stock: false, stock_status: "outofstock" }), parent), 0);
  const parentManaged = product({ manage_stock: true, stock_quantity: 7 });
  assert.equal(liveStock(variation(null, "S", { manage_stock: "parent" }), parentManaged), 7);
});

test("a simple product is its own single size", () => {
  const { item } = resolveLine("scarf", null, product({ type: "simple", slug: "scarf", id: 9, manage_stock: true, stock_quantity: 5 }), []);
  assert.equal(item.ok && item.variantId, "gid://woocommerce/SimpleProduct/9");
  assert.equal(item.ok && item.stock, 5);
});

test("variant gids parse back to Woo ids", () => {
  assert.deepEqual(parseWooVariantGid("gid://woocommerce/ProductVariation/354"), { kind: "variation", id: 354 });
  assert.deepEqual(parseWooVariantGid("gid://woocommerce/SimpleProduct/12"), { kind: "simple", id: 12 });
  assert.equal(parseWooVariantGid("gid://shopify/ProductVariant/1"), null);
});

test("the order is created paid, at the price the shopper paid, tagged with the Aeza order id", () => {
  const body = buildWooOrder({
    aezaOrderId: "AZ-20261112-ABC234",
    paymentReference: "cf_998877",
    lines: [{ productId: 313, variationId: 360, quantity: 2, price: "690.00" }],
    shippingPrice: "49.00",
    customer: { name: "Asha Rao", email: "asha@example.com", phone: "+919876543210" },
    shippingAddress: { address1: "12 MG Road", city: "Bengaluru", provinceCode: "KA", zip: "560001", countryCode: "IN" },
  });
  assert.equal(body.set_paid, true);
  assert.equal(body.status, "processing");
  assert.deepEqual(body.line_items, [{ product_id: 313, variation_id: 360, quantity: 2, subtotal: "1380.00", total: "1380.00" }]);
  assert.deepEqual(body.shipping_lines, [{ method_id: "flat_rate", method_title: "Aeza shipping", total: "49.00" }]);
  assert.deepEqual(body.meta_data, [{ key: "aeza_order_id", value: "AZ-20261112-ABC234" }]);
  assert.equal(body.shipping.first_name, "Asha");
  assert.equal(body.shipping.last_name, "Rao");
  assert.equal(body.shipping.state, "KA");
  assert.equal(body.billing.email, "asha@example.com");
  assert.equal(body.transaction_id, "cf_998877");
  assert.deepEqual(buildWooOrder({ ...{ aezaOrderId: "A", paymentReference: "p", lines: [], customer: { name: "A", email: "e", phone: "p" }, shippingAddress: { address1: "a", city: "c", zip: "z", countryCode: "IN" } }, shippingPrice: "0" }).shipping_lines, []);
});

const order = (fields: Partial<WooOrder>): WooOrder => ({
  id: 1001, number: "1001", status: "processing", date_created_gmt: "2026-11-12T08:00:00", date_modified_gmt: "2026-11-12T09:00:00",
  date_completed_gmt: null, meta_data: [], ...fields,
});

test("a retry finds the order already created for this Aeza order", () => {
  const mine = order({ id: 7, meta_data: [{ key: "aeza_order_id", value: "AZ-1" }] });
  assert.equal(findAezaOrder([order({}), mine], "AZ-1")?.id, 7);
  assert.equal(findAezaOrder([order({})], "AZ-1"), null);
});

test("Woo status maps onto the backend's delivery sync", () => {
  assert.deepEqual(wooOrderStatus(order({ status: "processing" })), { cancelledAt: null, fulfillments: [] });
  assert.equal(wooOrderStatus(order({ status: "cancelled" })).cancelledAt, "2026-11-12T09:00:00Z");
  const done = wooOrderStatus(order({
    status: "completed", date_completed_gmt: "2026-11-13T10:00:00",
    meta_data: [{ key: "_wc_shipment_tracking_items", value: [{ tracking_provider: "delhivery", tracking_number: "AWB1" }] }],
  }));
  assert.equal(done.fulfillments[0].displayStatus, "FULFILLED");
  assert.equal(done.fulfillments[0].createdAt, "2026-11-13T10:00:00Z");
  assert.deepEqual(done.fulfillments[0].tracking, [{ company: "delhivery", number: "AWB1", url: null }]);
});
