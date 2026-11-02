// Woo -> catalog mapping, run through the real planner. Run: npm run test:woo

import { test } from "node:test";
import assert from "node:assert/strict";
import { planCatalog } from "../catalog/plan.ts";
import type { PlanResult, ProductRow } from "../catalog/plan.ts";
import { finishRows, isPublishable, plainText, toProductInput, wooProductGid, wooVariationGid } from "./map.ts";
import type { WooListing, WooProduct, WooVariation } from "./map.ts";

const UPLOADS = "https://knitdomain.com/wp-content/uploads/2026/08/";
let seq = 100;

function product(fields: Partial<WooProduct> = {}): WooProduct {
  seq += 1;
  return {
    id: seq,
    slug: "flora",
    name: "Flora (Oversized T-Shirt)",
    type: "variable",
    status: "publish",
    catalog_visibility: "visible",
    description: "<p>Soft cotton &amp; a relaxed drape.</p>",
    short_description: "",
    permalink: "https://knitdomain.com/product/flora/",
    price: "899",
    regular_price: "",
    sku: "",
    tax_status: "taxable",
    manage_stock: false,
    stock_quantity: null,
    stock_status: "instock",
    backorders: "no",
    images: [{ src: `${UPLOADS}gallery-1.webp`, alt: "" }],
    categories: [{ id: 1, name: "Over Sized T -Shirts", slug: "over-sized-t-shirts" }],
    tags: [],
    attributes: [
      { name: "Color", variation: true, options: ["Aqua Green"] },
      { name: "Size", variation: true, options: ["S", "M"] },
    ],
    ...fields,
  };
}

function variation(size: string, colour: string | null, fields: Partial<WooVariation> = {}): WooVariation {
  seq += 1;
  return {
    id: seq,
    status: "publish",
    sku: "",
    price: "899",
    regular_price: "1199",
    menu_order: 0,
    tax_status: "taxable",
    manage_stock: true,
    stock_quantity: 4,
    stock_status: "instock",
    backorders: "no",
    image: { src: `${UPLOADS}${(colour ?? "plain").toLowerCase().replace(/ /g, "-")}.webp`, alt: "" },
    attributes: [...(colour ? [{ name: "Color", option: colour }] : []), { name: "Size", option: size }],
    ...fields,
  };
}

function plan(listings: WooListing[]): PlanResult {
  const result = planCatalog({
    shop: "knitdomain.com",
    brand: { id: "4c1f1c76-6900-4b31-852b-fa702fe7c592", name: "Knit Domain" },
    shopifyProducts: listings.map(toProductInput),
    legacyRows: [],
    existingRows: [],
    existingLinks: [],
    metaobjects: new Map(),
    knownCategories: new Set(["T-Shirts"]),
  });
  finishRows(result.rows, listings, { gender: "unisex" });
  return result;
}

const sources = (rows: ProductRow[]) => rows.map((r) => r.images.map((i: { src: string }) => i.src.replace(UPLOADS, "")));

test("a single-colour product is one live row with Woo's prices, sizes and colour", () => {
  const listing = { product: product(), variations: [variation("S", "Aqua Green"), variation("M", "Aqua Green")] };
  const { rows, variants } = plan([listing]);

  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.shop, "knitdomain.com");
  assert.equal(row.source, "woocommerce");
  assert.equal(row.handle, "flora");
  assert.equal(row.color_key, "");
  assert.equal(row.shopify_product_id, wooProductGid(listing.product.id));
  assert.equal(row.live_on_aeza, true);
  assert.equal(row.is_active, true);
  assert.equal(row.is_available, true);
  assert.equal(row.price, "899.00");
  assert.equal(row.compare_at_price, "1199.00");
  assert.equal(row.discounted, true);
  assert.equal(row.sku_id, null);
  assert.deepEqual(row.sizes, ["S", "M"]);
  assert.deepEqual(row.primary_colors, ["Aqua Green"]);
  assert.deepEqual(row.base_color, ["aqua green"]);
  assert.equal(row.description, "Soft cotton & a relaxed drape.");
  assert.equal(row.brand, "Knit Domain");
  assert.equal(row.product_category, "T-Shirts");
  assert.equal(row.product_type, "Clothing");
  assert.equal(row.body_part_tag, "top");
  assert.equal(row.fit, "oversized");
  assert.equal(row.gender, "unisex");
  assert.equal(row.field_sources.title, "woocommerce");
  assert.deepEqual(variants.map((v) => v.variantId), listing.variations.map((v) => wooVariationGid(v.id)));
});

test("colours get their own row and handle, and share variant_id", () => {
  const listing = {
    product: product({
      attributes: [
        { name: "Color", variation: true, options: ["Aqua Green", "Brick Red"] },
        { name: "Size", variation: true, options: ["S", "M"] },
      ],
    }),
    variations: [variation("S", "Aqua Green"), variation("M", "Aqua Green"), variation("S", "Brick Red"), variation("M", "Brick Red")],
  };
  const { rows, variants } = plan([listing]);

  assert.deepEqual(rows.map((r) => r.handle).sort(), ["flora--aqua-green", "flora--brick-red"]);
  assert.deepEqual(rows.map((r) => r.primary_colors[0]).sort(), ["Aqua Green", "Brick Red"]);
  assert.equal(rows[0].variant_id, rows[1].variant_id);
  assert.notEqual(rows[0].id, rows[1].id);
  assert.equal(variants.length, 4);
});

test("a colour keeps its own photo and the shared gallery, never another colour's photo", () => {
  const listing = {
    product: product({
      attributes: [
        { name: "Color", variation: true, options: ["Aqua Green", "Brick Red"] },
        { name: "Size", variation: true, options: ["S"] },
      ],
    }),
    variations: [variation("S", "Aqua Green"), variation("S", "Brick Red")],
  };
  const { rows } = plan([listing]);
  const byColour = new Map(rows.map((r, i) => [r.color_key, sources(rows)[i]]));

  assert.deepEqual([...byColour.get("aqua-green")!].sort(), ["aqua-green.webp", "gallery-1.webp"]);
  assert.deepEqual([...byColour.get("brick-red")!].sort(), ["brick-red.webp", "gallery-1.webp"]);
  for (const row of rows) assert.equal(row.primary_image, row.images[0].src);
  for (const row of rows) assert.ok(row.primary_image.endsWith(`${row.color_key}.webp`), "the colour's own photo comes first");
});

test("a colour that isn't a variation attribute still sets the row's colour", () => {
  const listing = {
    product: product({
      attributes: [
        { name: "Color", variation: false, options: ["Brick Red"] },
        { name: "Size", variation: true, options: ["S"] },
      ],
    }),
    variations: [variation("S", null)],
  };
  const [row] = plan([listing]).rows;
  assert.equal(row.color_key, "");
  assert.deepEqual(row.primary_colors, ["Brick Red"]);
});

test("stock: sold-out sizes aren't buyable, and all sizes sold out makes the row unavailable", () => {
  const listing = {
    product: product(),
    variations: [variation("S", "Aqua Green", { stock_quantity: 0, stock_status: "outofstock" }), variation("M", "Aqua Green", { stock_quantity: 3 })],
  };
  const [row] = plan([listing]).rows;
  assert.deepEqual(row.sizes_in_stock, ["M"]);
  assert.equal(row.stock, 3);
  assert.equal(row.is_available, true);

  const soldOut = { product: product(), variations: [variation("S", "Aqua Green", { stock_quantity: 0, stock_status: "outofstock" })] };
  assert.equal(plan([soldOut]).rows[0].is_available, false);
});

test("stock: a variation without its own count follows the parent, or its stock_status", () => {
  const followsParent = {
    product: product({ manage_stock: true, stock_quantity: 0 }),
    variations: [variation("S", "Aqua Green", { manage_stock: "parent", stock_quantity: null })],
  };
  assert.equal(plan([followsParent]).rows[0].is_available, false);

  const untrackedSoldOut = {
    product: product(),
    variations: [variation("S", "Aqua Green", { manage_stock: false, stock_quantity: null, stock_status: "outofstock" })],
  };
  assert.equal(plan([untrackedSoldOut]).rows[0].is_available, false);

  const untrackedInStock = {
    product: product(),
    variations: [variation("S", "Aqua Green", { manage_stock: false, stock_quantity: null })],
  };
  assert.equal(plan([untrackedInStock]).rows[0].is_available, true);
});

test("backorders stay buyable at zero stock", () => {
  const listing = { product: product(), variations: [variation("S", "Aqua Green", { stock_quantity: 0, backorders: "yes" })] };
  assert.equal(plan([listing]).rows[0].is_available, true);
});

test("no sale price means no MRP", () => {
  const listing = { product: product(), variations: [variation("S", "Aqua Green", { price: "1199", regular_price: "1199" })] };
  const [row] = plan([listing]).rows;
  assert.equal(row.compare_at_price, null);
  assert.equal(row.discounted, false);
});

test("Boxy maps to the catalog's fit values", () => {
  const listing = {
    product: product({ categories: [{ id: 2, name: "Boxy Fit T-Shirts", slug: "boxy" }] }),
    variations: [variation("S", "Aqua Green")],
  };
  const [row] = plan([listing]).rows;
  assert.equal(row.fit, "relaxed");
  assert.equal(row.fit_type, "boxy");
  assert.equal(row.product_category, "T-Shirts");
});

test("a simple product is one free-size variant", () => {
  const listing = {
    product: product({ type: "simple", slug: "scarf", price: "490", regular_price: "500", attributes: [], manage_stock: true, stock_quantity: 2 }),
    variations: [],
  };
  const { rows, variants } = plan([listing]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].price, "490.00");
  assert.equal(rows[0].compare_at_price, "500.00");
  assert.equal(variants.length, 1);
  assert.equal(variants[0].availableQty, 2);
});

test("private, draft, imageless, hidden and test products never reach the catalog", () => {
  const variations = [variation("S", "Aqua Green")];
  const excluded = [
    product({ status: "private" }),
    product({ status: "draft" }),
    product({ images: [] }),
    product({ catalog_visibility: "hidden" }),
    product({ slug: "test" }),
  ];
  for (const item of excluded) assert.equal(isPublishable(item), false);
  assert.deepEqual(plan(excluded.map((p) => ({ product: p, variations }))).rows, []);
});

test("variations that can't be sold are left out, and a product left with none isn't listed", () => {
  const unusable = [
    variation("S", "Aqua Green", { price: "" }),
    variation("M", "Aqua Green", { status: "private" }),
    variation("", "Aqua Green"),
  ];
  const input = toProductInput({ product: product(), variations: unusable });
  assert.deepEqual(input.variants, []);
  assert.equal(input.published, false);
});

test("variation images outside the gallery still reach the planner's media", () => {
  const input = toProductInput({ product: product(), variations: [variation("S", "Aqua Green"), variation("M", "Aqua Green")] });
  assert.deepEqual(input.media.map((m) => m.image!.url.replace(UPLOADS, "")), ["gallery-1.webp", "aqua-green.webp"]);
});

test("plainText strips tags and decodes entities", () => {
  assert.equal(plainText("<p>One &amp; two</p><ul><li>Three&#8211;four</li></ul>"), "One & two\nThree–four");
  assert.equal(plainText("<p> </p>"), null);
  assert.equal(plainText(null), null);
});
