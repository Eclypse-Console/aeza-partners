// Edge cases for the catalog planner. Run: npm run test:catalog

import { test } from "node:test";
import assert from "node:assert/strict";
import { planCatalog } from "./plan.ts";
import type { MetaobjectInput, PlanInput, ProductRow, ShopifyProductInput, ShopifyVariantInput } from "./plan.ts";
import { categoryFromShopify, chooseGender, cleanLegacyScalar, imageIdentity, sortSizes } from "./normalize.ts";

const CDN = "https://cdn.shopify.com/s/files/1/0001/files/";
const SHOP = "test-brand.myshopify.com";
let seq = 0;

function variant(fields: Partial<ShopifyVariantInput> & { size?: string; colour?: string } = {}): ShopifyVariantInput {
  seq += 1;
  const options = [{ name: "Size", value: fields.size ?? "M" }];
  if (fields.colour) options.push({ name: "Color", value: fields.colour });
  return {
    id: `gid://shopify/ProductVariant/${seq}`,
    title: options.map((o) => o.value).join(" / "),
    sku: null,
    position: seq,
    price: "1000.00",
    compareAtPrice: "1500.00",
    inventoryQuantity: 5,
    inventoryPolicy: "DENY",
    taxable: true,
    selectedOptions: options,
    images: [],
    inventoryItem: { tracked: true },
    ...fields,
  };
}

function product(fields: Partial<ShopifyProductInput> = {}): ShopifyProductInput {
  seq += 1;
  const handle = fields.handle ?? `product-${seq}`;
  return {
    productId: `gid://shopify/Product/${seq}`,
    handle,
    title: `Product ${seq}`,
    description: "A nice product.",
    productType: "tops",
    vendor: "Test",
    tags: [],
    status: "ACTIVE",
    categoryName: "Tank Tops",
    options: [{ name: "Size", values: ["S", "M"] }],
    onlineStoreUrl: null,
    media: [{ mediaContentType: "IMAGE", image: { url: `${CDN}${handle}-1.jpg?v=1` } }],
    metafields: [],
    collections: [],
    variants: [variant({ size: "S" }), variant({ size: "M" })],
    published: true,
    deletedAt: null,
    ...fields,
  };
}

function legacy(fields: Partial<ProductRow> = {}): ProductRow {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    variant_id: `10000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    handle: `product-${seq}`,
    title: `Legacy ${seq}`,
    sku_id: null,
    brand: "Test Brand",
    brand_id: "brand-1",
    product_category: "Tank Tops",
    product_type: "Clothing",
    description: "Old CSV description",
    ai_description: "An AI description.",
    tags: ["tank tops", "test brand"],
    images: [{ src: `${CDN}old.jpg?v=1`, alt_text: null }],
    variants: [],
    price: "1200.00",
    stock: 3,
    gender: "women",
    primary_colors: ["Red"],
    color_hex: ["#aa0000"],
    base_color: ["red"],
    fabric: ["cotton"],
    fit: "regular",
    fit_type: "straight",
    neckline: null,
    occasion: ["brunch"],
    aesthetic: ["minimal"],
    season: ["summer"],
    layering_role: "standalone",
    luxury_level: 1,
    body_part_tag: "top",
    embedding_text: "text",
    multimodal_product_embeddings: "[0.1,0.2]",
    product_image_siglip_embedding: "[0.3]",
    ghost_status: "success",
    analysis_status: "success",
    is_active: true,
    ...fields,
  };
}

function plan(fields: Partial<PlanInput>) {
  return planCatalog({
    shop: SHOP,
    brand: { id: "brand-1", name: "Test Brand" },
    shopifyProducts: [],
    legacyRows: [],
    existingRows: [],
    existingLinks: [],
    existingJobs: [],
    metaobjects: new Map(),
    knownCategories: new Set(["Tank Tops", "Trousers", "Co-ord Sets", "Blouses"]),
    now: new Date("2026-10-26T00:00:00Z"),
    ...fields,
  });
}

const steps = (result: ReturnType<typeof plan>, id: string) =>
  result.jobs.filter((j) => j.catalogProductId === id).map((j) => j.step).sort();

const metaobjects = (entries: MetaobjectInput[]) => new Map(entries.map((e) => [e.id, e]));

// ------------------------------------------------------------ matching ---

test("handle match without real SKUs keeps the legacy id and its AI work", () => {
  const old = legacy({ handle: "pink-top", sku_id: "TEMP-SKU-PINK-TOP-S" });
  const p = product({ handle: "pink-top" });
  const result = plan({ shopifyProducts: [p], legacyRows: [old] });
  const row = result.rows.find((r) => r.shopify_product_id === p.productId)!;
  assert.equal(row.id, old.id);
  assert.equal(row.variant_id, old.variant_id);
  assert.equal(row.ai_description, old.ai_description);
  assert.equal(result.links[0].method, "handle");
  assert.equal(result.links[0].status, "auto");
  assert.equal(row.price, "1000.00", "price comes from Shopify");
  assert.equal(row.field_sources.ai_description, "legacy");
  assert.equal(row.sku_id, null, "a legacy TEMP-SKU is never stored");
  assert.ok(row.variants.every((v: Record<string, unknown>) => !("sku" in v)), "no sku key without a real SKU");
  assert.ok(result.variants.every((v) => v.sku === null));
});

test("a real Shopify SKU is stored on the row and its sizes", () => {
  const p = product({ variants: [variant({ size: "S", sku: "CL-001-S" }), variant({ size: "M", sku: "CL-001-M" })] });
  const result = plan({ shopifyProducts: [p] });
  assert.equal(result.rows[0].sku_id, "CL-001-S");
  assert.equal(result.rows[0].variants[1].sku, "CL-001-M");
  assert.equal(result.variants[0].sku, "CL-001-S");
});

test("handle + SKU match is confirmed", () => {
  const old = legacy({ handle: "dress", variants: [{ sku: "SKU-1" }] });
  const p = product({ handle: "dress", variants: [variant({ sku: "SKU-1" })] });
  const result = plan({ shopifyProducts: [p], legacyRows: [old] });
  assert.equal(result.links[0].method, "handle+sku");
  assert.equal(result.rows[0].id, old.id);
});

test("handle matches but SKUs point elsewhere: sent to review, legacy row keeps serving", () => {
  const old = legacy({ handle: "top-2816", variants: [{ sku: "PEACH-1" }] });
  const p = product({ handle: "top-2816", variants: [variant({ sku: "PINK-1" })] });
  const result = plan({ shopifyProducts: [p], legacyRows: [old] });
  assert.equal(result.links[0].status, "needs_review");
  const kept = result.rows.find((r) => r.id === old.id)!;
  assert.equal(kept.source, "legacy_only");
  assert.equal(kept.is_active, true);
  assert.equal(result.rows.filter((r) => r.source === "shopify").length, 0);
});

test("SKUs shared by two Shopify products don't cross-link them", () => {
  const pinkOld = legacy({ handle: "pink-2816", variants: [{ sku: "SISH-XS" }] });
  const peachOld = legacy({ handle: "peach-2816", variants: [{ sku: "SISH-XS" }] });
  const pink = product({ handle: "pink-2816", variants: [variant({ sku: "SISH-XS" })] });
  const peach = product({ handle: "peach-2816", variants: [variant({ sku: "SISH-XS" })] });
  const result = plan({ shopifyProducts: [pink, peach], legacyRows: [pinkOld, peachOld] });
  assert.equal(result.rows.find((r) => r.shopify_product_id === pink.productId)!.id, pinkOld.id);
  assert.equal(result.rows.find((r) => r.shopify_product_id === peach.productId)!.id, peachOld.id);
});

test("renamed handle with the same title goes to review instead of creating a duplicate", () => {
  const old = legacy({ handle: "old-handle", title: "Lily Top" });
  const p = product({ handle: "new-handle", title: "Lily Top" });
  const result = plan({ shopifyProducts: [p], legacyRows: [old] });
  assert.equal(result.links[0].status, "needs_review");
  assert.match(result.links[0].reason!, /renamed/);
});

test("new product gets a new id and the full enrichment set", () => {
  const p = product({ handle: "brand-new" });
  const result = plan({ shopifyProducts: [p] });
  const row = result.rows[0];
  assert.equal(result.links[0].status, "new");
  assert.equal(row.legacy_product_id, null);
  assert.deepEqual(steps(result, row.id), ["body_part_tag", "color", "image_embedding", "text_attributes", "text_embedding"]);
  assert.equal(row.brand, "Test Brand");
});

test("duplicate legacy rows: the most complete one is kept, the other kept hidden", () => {
  const rich = legacy({ handle: "dup" });
  const poor = legacy({ handle: "dup", ai_description: null, multimodal_product_embeddings: null, product_image_siglip_embedding: null, ghost_status: "pending" });
  const p = product({ handle: "dup" });
  const result = plan({ shopifyProducts: [p], legacyRows: [poor, rich] });
  assert.equal(result.links[0].legacyProductId, rich.id);
  assert.deepEqual(result.links[0].duplicateLegacyIds, [poor.id]);
  const hidden = result.rows.find((r) => r.id === poor.id)!;
  assert.equal(hidden.source, "legacy_only");
  assert.equal(hidden.is_active, false);
});

test("duplicates with different colours but no colour option in Shopify go to review", () => {
  const red = legacy({ handle: "bd-412", primary_colors: ["Red"] });
  const blue = legacy({ handle: "bd-412", primary_colors: ["Blue"] });
  const result = plan({ shopifyProducts: [product({ handle: "bd-412" })], legacyRows: [red, blue] });
  assert.equal(result.links[0].status, "needs_review");
  assert.ok(result.rows.every((r) => r.source === "legacy_only" && r.is_active));
});

test("an incremental run keeps a linked product's link and id without the legacy rows", () => {
  const old = legacy({ handle: "linked" });
  const p = product({ handle: "linked" });
  const first = plan({ shopifyProducts: [p], legacyRows: [old] });
  const row = first.rows[0];
  const link = first.links[0];
  // A webhook run: only this product, no legacy rows loaded.
  const second = plan({
    shopifyProducts: [p],
    existingRows: [row],
    existingLinks: [{ ...link, status: link.status, reviewedAt: null }],
  });
  assert.equal(second.rows.length, 1);
  assert.equal(second.rows[0].id, old.id);
  assert.equal(second.links[0].unchanged, true, "the stored link isn't rewritten");
  assert.equal(second.rows[0].ai_description, old.ai_description);
});

test("a person's review decision survives a re-run", () => {
  const old = legacy({ handle: "x", variants: [{ sku: "A" }] });
  const p = product({ handle: "x", variants: [variant({ sku: "B" })] });
  const result = plan({
    shopifyProducts: [p],
    legacyRows: [old],
    existingLinks: [{ shopifyProductId: p.productId, colorKey: "", legacyProductId: old.id, duplicateLegacyIds: [], status: "auto", reviewedAt: new Date() }],
  });
  assert.equal(result.links[0].reviewed, true);
  assert.equal(result.rows.find((r) => r.shopify_product_id === p.productId)!.id, old.id);
});

// ------------------------------------------------------------- colours ---

test("colour split: the matched colour keeps its row, a new colour inherits from it", () => {
  const red = legacy({ handle: "pants", primary_colors: ["Red"], images: [{ src: `${CDN}red-1.jpg?v=1`, alt_text: null }, { src: `${CDN}red-2.jpg?v=1`, alt_text: null }] });
  const p = product({
    handle: "pants",
    options: [{ name: "Size", values: ["S", "M"] }, { name: "Color", values: ["Red", "Beige"] }],
    media: ["red-1", "red-2", "beige-1", "beige-2"].map((n) => ({ mediaContentType: "IMAGE", image: { url: `${CDN}${n}.jpg?v=2` } })),
    variants: [
      variant({ size: "S", colour: "Red", images: [`${CDN}red-2.jpg?v=2`] }),
      variant({ size: "S", colour: "Beige", images: [`${CDN}beige-1.jpg?v=2`], inventoryQuantity: 0 }),
      variant({ size: "M", colour: "Beige", images: [`${CDN}beige-1.jpg?v=2`] }),
    ],
  });
  const result = plan({ shopifyProducts: [p], legacyRows: [red] });
  const redRow = result.rows.find((r) => r.color_key === "red")!;
  const beigeRow = result.rows.find((r) => r.color_key === "beige")!;
  assert.equal(redRow.id, red.id);
  assert.notEqual(beigeRow.id, red.id);
  assert.equal(beigeRow.variant_id, red.variant_id, "colours of one product share variant_id");
  assert.deepEqual(beigeRow.primary_colors, ["Beige"]);
  assert.deepEqual(beigeRow.fabric, ["cotton"], "colour-independent AI work is inherited");
  assert.equal(beigeRow.field_sources.fabric, "sibling");
  assert.equal(beigeRow.ai_description, undefined, "colour-specific AI work is not inherited");
  assert.deepEqual(beigeRow.color_hex, undefined);
  assert.deepEqual(redRow.images.map((i: { src: string }) => imageIdentity(i.src)), [`${CDN}red-1.jpg`, `${CDN}red-2.jpg`]);
  assert.deepEqual(beigeRow.images.map((i: { src: string }) => imageIdentity(i.src)), [`${CDN}beige-1.jpg`, `${CDN}beige-2.jpg`]);
  assert.deepEqual(beigeRow.sizes, ["S", "M"]);
  assert.deepEqual(beigeRow.sizes_in_stock, ["M"]);
  assert.ok(steps(result, beigeRow.id).includes("text_attributes"));
  assert.ok(!steps(result, redRow.id).includes("text_attributes"));
});

test("a colour option with one value is not a split", () => {
  const old = legacy({ handle: "dress-3082" });
  const p = product({ handle: "dress-3082", options: [{ name: "Size", values: ["S"] }, { name: "Color", values: ["Blue"] }], variants: [variant({ colour: "Blue" })] });
  const result = plan({ shopifyProducts: [p], legacyRows: [old] });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].color_key, "");
  assert.equal(result.rows[0].id, old.id);
});

test("colour without variant images falls back to all media and says so", () => {
  const p = product({
    handle: "no-imgs",
    options: [{ name: "Size", values: ["S"] }, { name: "Color", values: ["Red", "Blue"] }],
    variants: [variant({ colour: "Red" }), variant({ colour: "Blue" })],
  });
  const result = plan({ shopifyProducts: [p] });
  assert.equal(result.rows.length, 2);
  assert.ok(result.notes.some((n) => /no variant images/.test(n.note)));
});

// ------------------------------------------------------- live and stock ---

test("draft, unlisted, unpublished and deleted products are not live and queue no AI", () => {
  const draft = product({ status: "DRAFT" });
  const unlisted = product({ status: "UNLISTED" });
  const unpublished = product({ published: false });
  const deleted = product({ deletedAt: new Date() });
  const result = plan({ shopifyProducts: [draft, unlisted, unpublished, deleted] });
  assert.ok(result.rows.every((r) => !r.live_on_aeza && !r.is_active));
  assert.equal(result.jobs.length, 0);
});

test("sold out everywhere: live but not available", () => {
  const p = product({ variants: [variant({ inventoryQuantity: 0 }), variant({ inventoryQuantity: -2 })] });
  const row = plan({ shopifyProducts: [p] }).rows[0];
  assert.equal(row.live_on_aeza, true);
  assert.equal(row.is_available, false);
  assert.equal(row.stock, 0, "negative stock doesn't reduce the total");
});

test("untracked stock and sell-when-out-of-stock count as available", () => {
  const p = product({
    variants: [
      variant({ size: "S", inventoryQuantity: 0, inventoryItem: { tracked: false } }),
      variant({ size: "M", inventoryQuantity: 0, inventoryPolicy: "CONTINUE" }),
    ],
  });
  assert.deepEqual(plan({ shopifyProducts: [p] }).rows[0].sizes_in_stock, ["S", "M"]);
});

test("a product removed from Shopify is hidden but kept", () => {
  const existing = legacy({ handle: "gone", shopify_product_id: "gid://shopify/Product/999", color_key: "" });
  const result = plan({ existingRows: [existing] });
  assert.equal(result.rows[0].id, existing.id);
  assert.equal(result.rows[0].is_active, false);
  assert.equal(result.rows[0].shopify_status, "DELETED");
});

test("legacy rows with no Shopify product are kept hidden", () => {
  const orphan = legacy({ handle: "discontinued" });
  const result = plan({ legacyRows: [orphan] });
  assert.equal(result.rows[0].id, orphan.id);
  assert.equal(result.rows[0].source, "legacy_only");
  assert.equal(result.rows[0].is_active, false);
});

// ------------------------------------------------------- re-runs / jobs ---

function rerun(change: (p: ShopifyProductInput) => void) {
  const old = legacy({ handle: "stable" });
  const p = product({ handle: "stable" });
  const first = plan({ shopifyProducts: [p], legacyRows: [old] });
  const row = first.rows.find((r) => r.shopify_product_id === p.productId)!;
  const doneJobs = first.jobs.map((j) => ({ catalogProductId: j.catalogProductId, step: j.step, status: "done", inputHash: j.inputHash }));
  const next = structuredClone(p);
  change(next);
  return { row, second: plan({ shopifyProducts: [next], legacyRows: [old], existingRows: [row], existingJobs: doneJobs }) };
}

test("price and stock changes re-run nothing", () => {
  const { row, second } = rerun((p) => {
    p.variants[0].price = "799.00";
    p.variants[0].inventoryQuantity = 0;
  });
  assert.deepEqual(steps(second, row.id), []);
  assert.equal(second.rows[0].price, "799.00");
});

test("a new ?v= on the same image re-runs nothing", () => {
  const { row, second } = rerun((p) => {
    p.media[0].image!.url = p.media[0].image!.url.replace("?v=1", "?v=99");
  });
  assert.deepEqual(steps(second, row.id), []);
});

test("a new photo re-runs colour and image embedding only", () => {
  const { row, second } = rerun((p) => {
    p.media[0].image!.url = `${CDN}new-photo.jpg?v=1`;
  });
  assert.deepEqual(steps(second, row.id), ["color", "image_embedding"]);
});

test("a title change refreshes the text attributes and embedding", () => {
  const { row, second } = rerun((p) => {
    p.title = "Renamed product";
  });
  const text = second.jobs.find((j) => j.catalogProductId === row.id && j.step === "text_attributes")!;
  assert.equal(text.mode, "refresh");
  assert.ok(steps(second, row.id).includes("text_embedding"));
});

test("missing AI fields queue a fill-only text step; complete rows queue nothing", () => {
  const gap = legacy({ handle: "gap", season: [], layering_role: null });
  const full = legacy({ handle: "full" });
  const result = plan({ shopifyProducts: [product({ handle: "gap" }), product({ handle: "full" })], legacyRows: [gap, full] });
  const job = result.jobs.find((j) => j.catalogProductId === gap.id && j.step === "text_attributes")!;
  assert.equal(job.mode, "fill");
  assert.match(job.reason, /season, layering_role/);
  assert.ok(!result.jobs.some((j) => j.catalogProductId === full.id && j.step === "text_attributes"));
});

test("a product without images queues no AI", () => {
  const result = plan({ shopifyProducts: [product({ media: [] })] });
  assert.equal(result.jobs.length, 0);
});

// ------------------------------------------------------ brand attributes ---

test("brand attributes override legacy values; unreadable ones keep the legacy value", () => {
  const old = legacy({ handle: "attrs", fabric: ["cotton"], neckline: "{\"crew neck\",\"round neck\"}", gender: "women" });
  const p = product({
    handle: "attrs",
    metafields: [
      { namespace: "shopify", key: "fabric", type: "list.metaobject_reference", value: ["gid://m/1", "gid://m/2"] },
      { namespace: "shopify", key: "neckline", type: "list.metaobject_reference", value: ["gid://m/unreadable"] },
      { namespace: "shopify", key: "target-gender", type: "list.metaobject_reference", value: ["gid://m/3", "gid://m/4"] },
      { namespace: "shopify", key: "color-pattern", type: "list.metaobject_reference", value: ["gid://m/5", "gid://m/6"] },
      { namespace: "shopify", key: "sleeve-length-type", type: "list.metaobject_reference", value: ["gid://m/7"] },
    ],
  });
  const result = plan({
    shopifyProducts: [p],
    legacyRows: [old],
    metaobjects: metaobjects([
      { id: "gid://m/1", type: "shopify--fabric", label: "Cotton", hex: null },
      { id: "gid://m/2", type: "shopify--fabric", label: "poly cotton", hex: null },
      { id: "gid://m/3", type: "shopify--target-gender", label: "Unisex", hex: null },
      { id: "gid://m/4", type: "shopify--target-gender", label: "Female", hex: null },
      { id: "gid://m/5", type: "shopify--color-pattern", label: "Yellow", hex: "#FFE500" },
      { id: "gid://m/6", type: "shopify--color-pattern", label: "Dots", hex: null },
      { id: "gid://m/7", type: "shopify--sleeve-length-type", label: "Spaghetti strap", hex: null },
    ]),
  });
  const row = result.rows[0];
  assert.deepEqual(row.fabric, ["cotton", "poly-cotton"]);
  assert.equal(row.field_sources.fabric, "shopify");
  assert.equal(row.neckline, "crew; round", "legacy array literal cleaned, unreadable attribute ignored");
  assert.equal(row.gender, "women", "legacy gender kept when the brand's labels allow it");
  assert.deepEqual(row.primary_colors, ["Yellow"]);
  assert.ok(row.tags.includes("dots"), "patterns become tags, not colours");
  assert.deepEqual(row.color_hex, ["#aa0000"], "Shopify's swatch hex never replaces the measured hex");
  assert.equal(row.sleeve_length_type, "spaghetti-strap");
});

test("the brand's pants length and waist rise win over legacy AI values, even multi-valued", () => {
  const old = legacy({ handle: "pants-attrs", pants_length_type: "ankle", waist_rise: "mid" });
  const p = product({
    handle: "pants-attrs",
    metafields: [
      { namespace: "shopify", key: "pants-length-type", type: "list.metaobject_reference", value: ["gid://m/long"] },
      { namespace: "shopify", key: "waist-rise", type: "list.metaobject_reference", value: ["gid://m/high", "gid://m/mid"] },
    ],
  });
  const row = plan({
    shopifyProducts: [p],
    legacyRows: [old],
    metaobjects: metaobjects([
      { id: "gid://m/long", type: "shopify--pants-length-type", label: "Long", hex: null },
      { id: "gid://m/high", type: "shopify--waist-rise", label: "High", hex: null },
      { id: "gid://m/mid", type: "shopify--waist-rise", label: "Mid", hex: null },
    ]),
  }).rows[0];
  assert.equal(row.pants_length_type, "long");
  assert.equal(row.waist_rise, "high; mid");
  assert.equal(row.field_sources.pants_length_type, "shopify");
});

test("Shopify's 'Trousers' for a co-ord set doesn't override the category", () => {
  const old = legacy({ handle: "set-1", product_category: "Co-ord Sets" });
  const result = plan({ shopifyProducts: [product({ handle: "set-1", categoryName: "Trousers" })], legacyRows: [old] });
  assert.equal(result.rows[0].product_category, "Co-ord Sets");
  assert.equal(result.rows[0].shopify_category, "Trousers");
  const fresh = plan({ shopifyProducts: [product({ title: "Yellow co-ord set", categoryName: "Trousers" })] }).rows[0];
  assert.equal(fresh.product_category, "Co-ord Sets");
});

test("empty Shopify description keeps the legacy one", () => {
  const old = legacy({ handle: "nodesc" });
  const row = plan({ shopifyProducts: [product({ handle: "nodesc", description: "" })], legacyRows: [old] }).rows[0];
  assert.equal(row.description, "Old CSV description");
});

// ----------------------------------------------------------- normalizers ---

test("normalizers", () => {
  assert.equal(cleanLegacyScalar("square; halter", "neckline"), "square; halter");
  assert.equal(cleanLegacyScalar("{\"collared\",\"collar\"}", "neckline"), "collared");
  assert.equal(cleanLegacyScalar("spaghetti strap, sleeveless"), "spaghetti-strap; sleeveless");
  assert.equal(chooseGender(["Female"], null), "women");
  assert.equal(chooseGender(["Male", "Female"], null), "unisex");
  assert.equal(chooseGender(["Female"], "men"), "women", "brand label wins over a value outside it");
  assert.deepEqual(sortSizes(["XL", "S", "M", "XS", "L"]), ["XS", "S", "M", "L", "XL"]);
  assert.equal(categoryFromShopify("Jeans", "Ocean jeans", "", new Set(["Trousers"])), null, "unknown categories are left for AI");
});
