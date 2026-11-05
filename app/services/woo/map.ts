// Turns WooCommerce products into the planner's input, and finishes the rows
// the planner returns. Pure, so every rule is testable without a store or a
// database (see map.test.ts). The planner itself is shared with Shopify and
// isn't changed for Woo: anything Woo needs differently happens here.
//
// A multi-colour product gets one catalog row per colour, which all share the
// Woo slug. The backend resolves a cart line by handle + size only, so
// finishRows gives each colour its own handle (flora--aqua-green) and the
// resolver can find the exact variation from that.

import { imageIdentity, slugValue, titleCase } from "../catalog/normalize.ts";
import type { ProductRow, ShopifyProductInput, ShopifyVariantInput } from "../catalog/plan.ts";

export type WooImage = { src: string; alt?: string | null };

export type WooAttribute = { name: string; variation: boolean; options: string[] };

type WooStock = {
  manage_stock: boolean | "parent";
  stock_quantity: number | null;
  stock_status: string;
  backorders: string;
};

export type WooProduct = WooStock & {
  id: number;
  slug: string;
  name: string;
  type: string;
  status: string;
  catalog_visibility: string;
  description: string;
  short_description: string;
  permalink: string;
  price: string;
  regular_price: string;
  sku: string;
  tax_status: string;
  images: WooImage[];
  categories: Array<{ id: number; name: string; slug: string }>;
  tags: Array<{ name: string }>;
  attributes: WooAttribute[];
};

export type WooVariation = WooStock & {
  id: number;
  status: string;
  sku: string;
  price: string;
  regular_price: string;
  menu_order: number;
  tax_status: string;
  image: WooImage | null;
  attributes: Array<{ name: string; option: string }>;
};

export type WooListing = { product: WooProduct; variations: WooVariation[] };

const VARIATION_PREFIX = "gid://woocommerce/ProductVariation/";
const COLOUR_ATTRIBUTE = /colou?r/i;

// Published on the store but not for sale on Aeza.
const EXCLUDED_SLUGS = new Set(["test"]);

// Woo sells what the brand calls "Over Sized T -Shirts" and so on; these are
// the catalog's values for the same things.
const CATEGORY_RULES: Array<{ pattern: RegExp; category: string }> = [{ pattern: /t\s*[-–—]?\s*shirt/i, category: "T-Shirts" }];
const FIT_RULES: Array<{ pattern: RegExp; fit: string; fitType?: string }> = [
  { pattern: /over\s*sized?/i, fit: "oversized" },
  { pattern: /boxy/i, fit: "relaxed", fitType: "boxy" },
  { pattern: /regular/i, fit: "regular" },
];
const BODY_PART_BY_CATEGORY: Record<string, string> = { "T-Shirts": "top" };

export const wooProductGid = (id: number) => `gid://woocommerce/Product/${id}`;
export const wooVariationGid = (id: number) => `${VARIATION_PREFIX}${id}`;
// A simple product has no variations, so it stands in as its own single size.
export const wooSimpleVariantGid = (id: number) => `gid://woocommerce/SimpleProduct/${id}`;

export function catalogHandle(slug: string, colorKey: string): string {
  return colorKey ? `${slug}--${colorKey}` : slug;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Woo descriptions are HTML; the catalog stores plain text. */
export function plainText(html: string | null | undefined): string | null {
  const text = (html ?? "")
    .replace(/<\/(p|div|li|h[1-6])>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (entity, name: string) => ENTITIES[name.toLowerCase()] ?? entity)
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n[ \n]*/g, "\n")
    .trim();
  return text || null;
}

function colourValues(product: WooProduct): string[] {
  return product.attributes.find((a) => COLOUR_ATTRIBUTE.test(a.name))?.options ?? [];
}

function colourOf(variation: WooVariation): string | null {
  return variation.attributes.find((a) => COLOUR_ATTRIBUTE.test(a.name))?.option ?? null;
}

function stockOf(item: WooStock, parent: WooStock) {
  const source = item.manage_stock === "parent" ? parent : item;
  const inventoryPolicy = source.backorders === "no" ? "DENY" : "CONTINUE";
  if (source.manage_stock === true) {
    return { inventoryQuantity: source.stock_quantity ?? 0, inventoryPolicy, tracked: true };
  }
  // No count kept, so stock_status is all there is. Out of stock has to stay
  // tracked: the planner treats untracked as always buyable.
  const soldOut = item.stock_status === "outofstock";
  return { inventoryQuantity: soldOut ? 0 : null, inventoryPolicy, tracked: soldOut };
}

/** The sale price and MRP; Woo leaves regular_price equal to price when nothing is on sale. */
function pricesOf(item: { price: string; regular_price: string }) {
  const onSale = item.regular_price !== "" && Number(item.regular_price) > Number(item.price);
  return { price: item.price, compareAtPrice: onSale ? item.regular_price : null };
}

function toVariant(variation: WooVariation, product: WooProduct, position: number): ShopifyVariantInput | null {
  const options = variation.attributes.map((a) => ({ name: a.name, value: a.option }));
  // An empty option is Woo's "any value": it can't be matched to one size.
  if (variation.status !== "publish" || !variation.price || options.some((o) => !o.value)) return null;
  const stock = stockOf(variation, product);
  return {
    id: wooVariationGid(variation.id),
    title: options.map((o) => o.value).join(" / "),
    sku: variation.sku || null,
    position,
    ...pricesOf(variation),
    inventoryQuantity: stock.inventoryQuantity,
    inventoryPolicy: stock.inventoryPolicy,
    taxable: variation.tax_status === "taxable",
    selectedOptions: options,
    images: variation.image?.src ? [variation.image.src] : [],
    inventoryItem: { tracked: stock.tracked },
  };
}

function simpleVariant(product: WooProduct): ShopifyVariantInput | null {
  if (!product.price) return null;
  const stock = stockOf(product, product);
  return {
    id: wooSimpleVariantGid(product.id),
    title: "Free Size",
    sku: product.sku || null,
    position: 0,
    ...pricesOf(product),
    inventoryQuantity: stock.inventoryQuantity,
    inventoryPolicy: stock.inventoryPolicy,
    taxable: product.tax_status === "taxable",
    selectedOptions: [{ name: "Size", value: "Free Size" }],
    images: [],
    inventoryItem: { tracked: stock.tracked },
  };
}

function statusOf(product: WooProduct): string {
  if (product.status === "publish") return "ACTIVE";
  return product.status === "draft" || product.status === "pending" ? "DRAFT" : "ARCHIVED";
}

/** Shown on Aeza: visible on the store, has images, and isn't on the excluded list. */
export function isPublishable(product: WooProduct): boolean {
  return (
    product.status === "publish" &&
    product.catalog_visibility !== "hidden" &&
    product.images.length > 0 &&
    !EXCLUDED_SLUGS.has(product.slug)
  );
}

function categoryOf(product: WooProduct): string | null {
  for (const { name } of product.categories) {
    const rule = CATEGORY_RULES.find((r) => r.pattern.test(name));
    if (rule) return rule.category;
  }
  return product.categories[0]?.name ?? null;
}

/**
 * The planner drops a colour's variation image unless it's also in the
 * product's media, and Woo keeps those two lists separately.
 */
function mediaOf({ product, variations }: WooListing): ShopifyProductInput["media"] {
  const images = [...product.images, ...variations.flatMap((v) => (v.image?.src ? [v.image] : []))];
  const seen = new Set<string>();
  return images.flatMap((image) => {
    const identity = imageIdentity(image.src);
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{ mediaContentType: "IMAGE", image: { url: image.src, altText: image.alt || null } }];
  });
}

export function toProductInput(listing: WooListing): ShopifyProductInput {
  const { product, variations } = listing;
  const ordered = [...variations].sort((a, b) => a.menu_order - b.menu_order || a.id - b.id);
  const variants =
    product.type === "variable"
      ? ordered.flatMap((v, i) => toVariant(v, product, i) ?? [])
      : [simpleVariant(product)].flatMap((v) => v ?? []);

  return {
    productId: wooProductGid(product.id),
    handle: product.slug,
    title: product.name,
    description: plainText(product.description) ?? plainText(product.short_description),
    productType: categoryOf(product),
    vendor: null,
    tags: product.tags.map((t) => t.name),
    status: statusOf(product),
    categoryName: categoryOf(product),
    options: product.attributes.filter((a) => a.variation).map((a) => ({ name: a.name, values: a.options })),
    onlineStoreUrl: product.permalink,
    media: mediaOf(listing),
    metafields: [],
    collections: product.categories.map((c) => ({ id: String(c.id), handle: c.slug, title: c.name })),
    variants,
    published: isPublishable(product) && variants.length > 0,
    deletedAt: null,
  };
}

/** Each colour's variation images, by colour key. */
function colourAnchors(variations: WooVariation[]): Map<string, Set<string>> {
  const anchors = new Map<string, Set<string>>();
  for (const variation of variations) {
    const colour = colourOf(variation);
    if (!colour || !variation.image?.src) continue;
    const key = slugValue(colour);
    anchors.set(key, (anchors.get(key) ?? new Set()).add(imageIdentity(variation.image.src)));
  }
  return anchors;
}

/**
 * The planner hands every unclaimed image to the first new colour: it would
 * show other colours' photos, and later colours would lose the shared gallery.
 * So a colour's images are rebuilt here: its own photos first, then the
 * gallery shots that don't belong to another colour.
 */
function colourImages(colorKey: string, listing: WooListing): Array<{ src: string; alt_text: string | null }> {
  const anchors = colourAnchors(listing.variations);
  const own = anchors.get(colorKey) ?? new Set<string>();
  const others = new Set([...anchors].filter(([key]) => key !== colorKey).flatMap(([, urls]) => [...urls]));
  const images = mediaOf(listing).map((m) => ({ src: m.image!.url, alt_text: m.image!.altText ?? null }));
  const isOwn = (src: string) => own.has(imageIdentity(src));
  return [...images.filter((i) => isOwn(i.src)), ...images.filter((i) => !isOwn(i.src) && !others.has(imageIdentity(i.src)))];
}

/** Applies what the planner can't know about Woo to its rows, in place. */
export function finishRows(rows: ProductRow[], listings: WooListing[], { gender }: { gender: string }): void {
  const byId = new Map(listings.map((listing) => [wooProductGid(listing.product.id), listing]));
  for (const row of rows) {
    const listing = byId.get(row.shopify_product_id);
    if (!listing) continue;
    const { product } = listing;

    row.source = "woocommerce";
    row.handle = catalogHandle(product.slug, row.color_key);
    row.field_sources = Object.fromEntries(
      Object.entries((row.field_sources ?? {}) as Record<string, string>).map(([field, source]) => [field, source === "shopify" ? "woocommerce" : source]),
    );

    if (row.color_key) {
      row.images = colourImages(row.color_key, listing);
      row.primary_image = row.images[0]?.src ?? null;
    } else {
      // One colour: the planner only reads colours from a colour it splits on.
      const colours = colourValues(product).map(titleCase);
      if (colours.length) row.primary_colors = colours;
    }
    if (!row.base_color?.length) row.base_color = (row.primary_colors ?? []).map((c: string) => c.toLowerCase());

    const fit = FIT_RULES.find((rule) => product.categories.some((c) => rule.pattern.test(c.name)));
    if (fit) {
      row.fit = fit.fit;
      if (fit.fitType) row.fit_type = fit.fitType;
    }
    row.gender = row.gender || gender;
    row.body_part_tag = row.body_part_tag || BODY_PART_BY_CATEGORY[row.product_category] || null;
  }
}
