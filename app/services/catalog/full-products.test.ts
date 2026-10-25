// Rebuilding products from Shopify's bulk JSONL. Run: npm run test:catalog

import { test } from "node:test";
import assert from "node:assert/strict";
import { BulkProductAssembler } from "./full-products.server.ts";

const P1 = "gid://shopify/Product/1";
const P2 = "gid://shopify/Product/2";
const V1 = "gid://shopify/ProductVariant/11";
const V2 = "gid://shopify/ProductVariant/12";

test("bulk lines are regrouped into products with their media, metafields, variants and variant images", () => {
  const lines = [
    { id: P1, title: "Pants", handle: "pants" },
    { id: "gid://shopify/MediaImage/1", mediaContentType: "IMAGE", image: { url: "https://cdn/red.jpg" }, __parentId: P1 },
    { id: "gid://shopify/Metafield/1", namespace: "shopify", key: "fabric", type: "list.metaobject_reference", value: "[\"gid://m/1\"]", __parentId: P1 },
    { id: V1, title: "S / Red", sku: "", __parentId: P1 },
    { id: "gid://shopify/MediaImage/1", image: { url: "https://cdn/red.jpg" }, __parentId: V1 },
    { id: V2, title: "S / Beige", sku: "", __parentId: P1 },
    { __parentId: V2 }, // a variant media that isn't an image
    { id: P2, title: "Top", handle: "top" },
  ];
  const assembler = new BulkProductAssembler();
  const done = lines.map((line) => assembler.add(line)).filter(Boolean);
  const last = assembler.finish();

  assert.equal(done.length, 1);
  const pants = done[0]!;
  assert.equal(pants.id, P1);
  assert.equal(pants.media.nodes.length, 1);
  assert.deepEqual(pants.metafields.nodes, [{ namespace: "shopify", key: "fabric", type: "list.metaobject_reference", value: "[\"gid://m/1\"]" }]);
  assert.equal(pants.collections, null, "the bulk export has no collections; the stored ones are kept");
  assert.deepEqual(pants.variants.nodes.map((v) => v.id), [V1, V2]);
  assert.deepEqual(pants.variants.nodes[0].media!.nodes, [{ id: "gid://shopify/MediaImage/1", image: { url: "https://cdn/red.jpg" } }]);
  assert.deepEqual(pants.variants.nodes[1].media!.nodes, []);
  assert.equal(last!.id, P2);
  assert.equal(assembler.finish(), null);
});
