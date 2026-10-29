// Plans one brand's catalog: matches each Shopify product (per colour) to its
// legacy products row, merges the two into catalog rows with one owner per
// field, and lists the enrichment steps that are actually needed. Pure: the
// caller loads the inputs and writes the outputs (see sync.server.ts), which
// keeps every rule testable without a database (see plan.test.ts).
//
// The catalog holds only products the brand published to Aeza that are
// ACTIVE or DRAFT in Shopify and not deleted (drafts: stored and enriched,
// live_on_aeza / is_active false until they're activated). A legacy row is
// used only to carry its id and AI work into a matching Shopify product;
// legacy rows without one aren't stored.
//
// Field owners:
//   Shopify   title, description, handle, images, prices, sizes, stock,
//             status, tags (kept separately), collections, URL
//   brand     fabric, colour names, pattern, neckline, sleeve, lengths, rise,
//   attrs     gender (Shopify attribute metafields, when they can be read)
//   legacy/AI category, fit, colour hex/base colour, AI description, style
//             fields, embeddings, ghost images (copied, never recomputed
//             unless their inputs changed or they're missing)

import { createHash, randomUUID } from "node:crypto";
import {
  applyCategoryFieldExclusions,
  categoryFromMerchantType,
  categoryFromShopify,
  chooseGender,
  cleanLegacyScalar,
  determineProductType,
  imageIdentity,
  normalizeCategory,
  normalizeFabric,
  normalizeFitType,
  normalizeMultiScalar,
  normalizeNeckline,
  slugValue,
  normalizeSizeToken,
  sortSizes,
  titleCase,
} from "./normalize.ts";

// ---------------------------------------------------------------- inputs ---

export type ShopifyVariantInput = {
  id: string;
  title: string;
  sku: string | null;
  position: number | null;
  price: string;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
  inventoryPolicy: string | null;
  taxable: boolean | null;
  selectedOptions: Array<{ name: string; value: string }>;
  images: string[];
  inventoryItem: { tracked: boolean | null } | null;
};

export type ShopifyProductInput = {
  productId: string;
  handle: string;
  title: string;
  description: string | null;
  productType: string | null;
  vendor: string | null;
  tags: string[];
  status: string | null;
  categoryName: string | null;
  options: Array<{ name: string; values: string[] }>;
  onlineStoreUrl: string | null;
  media: Array<{ mediaContentType?: string; alt?: string | null; image?: { url: string; altText?: string | null } | null }>;
  metafields: Array<{ namespace: string; key: string; type: string; value: unknown }>;
  collections: Array<{ id?: string; handle?: string; title: string }>;
  variants: ShopifyVariantInput[];
  /** The brand's choice in the Aeza dashboard. */
  published: boolean;
  deletedAt: Date | null;
};

export type MetaobjectInput = { id: string; type: string; label: string | null; hex: string | null };

/** A row of the legacy products table, or an existing catalog row. */
// Products-table rows have ~90 loosely typed columns; the planner reads them by name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ProductRow = Record<string, any> & { id: string };

export type LinkInput = {
  shopifyProductId: string;
  colorKey: string;
  legacyProductId: string | null;
  duplicateLegacyIds: string[];
  status: string;
  reviewedAt: Date | null;
};

export type PlanInput = {
  shop: string;
  brand: { id: string | null; name: string | null };
  shopifyProducts: ShopifyProductInput[];
  legacyRows: ProductRow[];
  existingRows: ProductRow[];
  existingLinks: LinkInput[];
  metaobjects: Map<string, MetaobjectInput>;
  knownCategories: ReadonlySet<string>;
  /** Legacy row id -> how much depends on it (interactions, ghost images, ...). */
  legacyUsage?: Map<string, number>;
  /**
   * Shopify products the live sync knows are deleted or unpublished but that
   * aren't in shopifyProducts (e.g. no longer in the mirror): their catalog
   * rows are removed.
   */
  removedProductIds?: Set<string>;
  now?: Date;
};

// --------------------------------------------------------------- outputs ---

export type CatalogVariantRow = {
  variantId: string;
  catalogProductId: string;
  shop: string;
  sku: string | null;
  size: string | null;
  options: Record<string, string>;
  position: number | null;
  price: string;
  compareAtPrice: string | null;
  availableQty: number;
  inventoryPolicy: string | null;
  tracked: boolean;
  available: boolean;
};

export type LinkRow = {
  shopifyProductId: string;
  colorKey: string;
  legacyProductId: string | null;
  duplicateLegacyIds: string[];
  status: "auto" | "new" | "needs_review";
  method: string;
  confidence: number | null;
  reason: string | null;
  candidates: Array<{ id: string; handle: string | null; title: string | null }>;
  /** True when a person decided this link. */
  reviewed: boolean;
  /** Kept from an earlier run (reviewed or already has a catalog row); the writer leaves it alone. */
  unchanged?: boolean;
};

export type PlanResult = {
  rows: ProductRow[];
  variants: CatalogVariantRow[];
  links: LinkRow[];
  /** Catalog row ids to delete (their sizes go with them). */
  deletes: string[];
  notes: Array<{ handle: string | null; colorKey: string; note: string }>;
};

// ----------------------------------------------------------------- rules ---

// AI-owned fields a live product should have; a gap queues the text step.
const CORE_AI_FIELDS = [
  "ai_description",
  "product_category",
  "gender",
  "occasion",
  "aesthetic",
  "season",
  "fit",
  "layering_role",
  "luxury_level",
] as const;

// Fields copied from the legacy row (or kept from the catalog row) as-is.
const CARRIED_FIELDS = [
  "brand_id",
  "brand",
  "product_category",
  "product_type",
  "ai_description",
  "tags",
  "gender",
  "primary_colors",
  "color_family",
  "color_hex",
  "base_color",
  "fabric",
  "fabric_category",
  "fit",
  "fit_type",
  "neckline",
  "sleeve_length_type",
  "top_length_type",
  "skirt_dress_length_type",
  "pants_length_type",
  "waist_rise",
  "outerwear_features",
  "occasion",
  "activity",
  "season",
  "aesthetic",
  "trend_alignment",
  "luxury_level",
  "pairs_well_with",
  "avoid_pairing_with",
  "layering_role",
  "breathability",
  "body_part_tag",
  "embedding_text",
  "multimodal_product_embeddings",
  "last_vectorized_at",
  "embedding_model",
  "embedding_status",
  "product_image_siglip_embedding",
  "product_image_siglip_url",
  "product_image_siglip_model",
  "product_image_siglip_at",
  "analysis_status",
  "ghost_status",
  "collection_name",
  "data_version",
  "ingested_at",
  "created_at",
] as const;

// Of those, the ones that describe one colour and so can't be inherited by a
// new colour of the same product.
const COLOUR_SPECIFIC_FIELDS = new Set([
  "ai_description",
  "primary_colors",
  "color_family",
  "color_hex",
  "base_color",
  "embedding_text",
  "multimodal_product_embeddings",
  "last_vectorized_at",
  "embedding_model",
  "embedding_status",
  "product_image_siglip_embedding",
  "product_image_siglip_url",
  "product_image_siglip_model",
  "product_image_siglip_at",
  "analysis_status",
  "ghost_status",
]);

// Shopify attribute metafield -> catalog column it fills.
const ATTRIBUTE_FIELDS: Array<{ key: string; column: string; normalize: (labels: string[]) => string | null }> = [
  { key: "neckline", column: "neckline", normalize: normalizeNeckline },
  { key: "sleeve-length-type", column: "sleeve_length_type", normalize: (v) => normalizeMultiScalar(v) },
  { key: "top-length-type", column: "top_length_type", normalize: (v) => normalizeMultiScalar(v) },
  { key: "pants-length-type", column: "pants_length_type", normalize: (v) => normalizeMultiScalar(v) },
  { key: "skirt-dress-length-type", column: "skirt_dress_length_type", normalize: (v) => normalizeMultiScalar(v) },
  { key: "waist-rise", column: "waist_rise", normalize: (v) => normalizeMultiScalar(v) },
];

// ---------------------------------------------------------------- helpers ---

const isEmpty = (value: unknown) =>
  value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);

const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();

const isRealSku = (sku: unknown) => {
  const value = String(sku ?? "").trim();
  return value.length > 0 && !/^(temp|test|sample)-sku/i.test(value);
};

function legacySkus(row: ProductRow): Set<string> {
  const skus = [row.sku_id, ...((row.variants as Array<{ sku?: string }> | null) ?? []).map((v) => v?.sku)];
  return new Set(skus.filter(isRealSku).map(String));
}

function metafield(product: ShopifyProductInput, namespace: string, key: string): unknown {
  return product.metafields.find((m) => m.namespace === namespace && m.key === key)?.value;
}

type Resolved = { labels: string[]; entries: MetaobjectInput[]; complete: boolean };

/** Metaobject labels behind an attribute metafield; `complete` is false if any ID couldn't be read. */
function attribute(product: ShopifyProductInput, key: string, metaobjects: Map<string, MetaobjectInput>): Resolved | null {
  const ids = metafield(product, "shopify", key);
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const entries = ids.map((id) => metaobjects.get(String(id))).filter((e): e is MetaobjectInput => !!e && !!e.label);
  return { labels: entries.map((e) => e.label!), entries, complete: entries.length === ids.length };
}

function sizeOf(variant: ShopifyVariantInput): string {
  const size = variant.selectedOptions.find((o) => /size/i.test(o.name));
  if (size) return size.value;
  const nonColour = variant.selectedOptions.filter((o) => !/colou?r/i.test(o.name));
  return nonColour.length === 1 ? nonColour[0].value : variant.title;
}

function canBuy(variant: ShopifyVariantInput): boolean {
  if (variant.inventoryItem?.tracked === false || variant.inventoryPolicy === "CONTINUE") return true;
  return (variant.inventoryQuantity ?? 0) > 0;
}

type Image = { src: string; alt_text: string | null };

function mediaImages(product: ShopifyProductInput): Image[] {
  return product.media
    .filter((m) => m.image?.url && (m.mediaContentType ?? "IMAGE") === "IMAGE")
    .map((m) => ({ src: m.image!.url, alt_text: m.image!.altText ?? m.alt ?? null }));
}

type Group = {
  colorKey: string;
  colorValue: string | null;
  variants: ShopifyVariantInput[];
  /** Images attached to this colour's variants (the colour's anchor shots). */
  anchorImages: string[];
};

/** One group per colour when the product has a colour option with several values. */
function groupsOf(product: ShopifyProductInput): Group[] {
  const colour = product.options.find((o) => /colou?r/i.test(o.name) && o.values.length > 1);
  if (!colour) {
    return [{ colorKey: "", colorValue: null, variants: product.variants, anchorImages: [] }];
  }
  const groups = new Map<string, Group>();
  for (const variant of product.variants) {
    const value = variant.selectedOptions.find((o) => o.name === colour.name)?.value ?? "";
    const key = slugValue(value);
    const group = groups.get(key) ?? { colorKey: key, colorValue: value, variants: [], anchorImages: [] };
    group.variants.push(variant);
    for (const url of variant.images) {
      if (!group.anchorImages.some((u) => imageIdentity(u) === imageIdentity(url))) group.anchorImages.push(url);
    }
    groups.set(key, group);
  }
  return [...groups.values()];
}

function variantJson(variant: ShopifyVariantInput) {
  const options: Record<string, string> = {};
  variant.selectedOptions.forEach((o, i) => {
    options[`option${i + 1}_name`] = o.name;
    options[`option${i + 1}_value`] = o.value;
  });
  return {
    // Only a real SKU from Shopify; never an empty or made-up placeholder.
    ...(isRealSku(variant.sku) ? { sku: variant.sku } : {}),
    price: Number(variant.price),
    stock: variant.inventoryQuantity ?? 0,
    options,
    taxable: variant.taxable ?? false,
    compare_at_price: variant.compareAtPrice === null ? null : Number(variant.compareAtPrice),
    variant_id: variant.id,
  };
}

/** Quality of a legacy row as a source: AI work done and things pointing at it. */
function legacyScore(row: ProductRow, usage: Map<string, number> | undefined): number {
  let score = 0;
  for (const field of CORE_AI_FIELDS) if (!isEmpty(row[field])) score += 1;
  if (!isEmpty(row.multimodal_product_embeddings)) score += 3;
  if (!isEmpty(row.product_image_siglip_embedding)) score += 3;
  if (row.ghost_status === "success") score += 2;
  return score * 1000 + (usage?.get(row.id) ?? 0);
}

// ---------------------------------------------------------------- matching ---

type Slot = {
  product: ShopifyProductInput;
  group: Group;
  link: LinkRow;
};

function matchProduct(
  product: ShopifyProductInput,
  groups: Group[],
  byHandle: Map<string, ProductRow[]>,
  byTitle: Map<string, ProductRow[]>,
  shopifyHandles: Set<string>,
  existingLinks: Map<string, LinkInput>,
  usage: Map<string, number> | undefined,
  claimed: Set<string>,
  settledSlots: Set<string>,
): Slot[] {
  const candidates = (byHandle.get(norm(product.handle)) ?? []).filter((r) => !claimed.has(r.id));
  const describe = (rows: ProductRow[]) => rows.map((r) => ({ id: r.id, handle: r.handle ?? null, title: r.title ?? null }));
  const slots: Slot[] = [];
  const unassigned = new Set(candidates.map((r) => r.id));
  const take = (id: string) => {
    unassigned.delete(id);
    claimed.add(id);
  };

  // Decisions a person made are kept as they are, and so is any slot that
  // already has a catalog row: once linked, a product isn't matched again
  // (re-matching could only flip a row's id, and incremental runs don't load
  // the legacy rows to match against).
  const pendingGroups: Group[] = [];
  for (const group of groups) {
    const key = `${product.productId}|${group.colorKey}`;
    const existing = existingLinks.get(key);
    const settled = existing && existing.status !== "needs_review" && settledSlots.has(key);
    if (existing && (existing.reviewedAt || settled)) {
      if (existing.legacyProductId) take(existing.legacyProductId);
      existing.duplicateLegacyIds.forEach(take);
      slots.push({
        product,
        group,
        link: {
          shopifyProductId: product.productId,
          colorKey: group.colorKey,
          legacyProductId: existing.legacyProductId,
          duplicateLegacyIds: existing.duplicateLegacyIds,
          status: existing.legacyProductId ? "auto" : existing.status === "needs_review" ? "needs_review" : "new",
          method: existing.reviewedAt ? "reviewed" : "kept",
          confidence: 1,
          reason: null,
          candidates: [],
          reviewed: Boolean(existing.reviewedAt),
          unchanged: true,
        },
      });
    } else {
      pendingGroups.push(group);
    }
  }

  const base = (group: Group, fields: Partial<LinkRow>): Slot => ({
    product,
    group,
    link: {
      shopifyProductId: product.productId,
      colorKey: group.colorKey,
      legacyProductId: null,
      duplicateLegacyIds: [],
      status: "new",
      method: "new",
      confidence: null,
      reason: null,
      candidates: describe(candidates),
      reviewed: false,
      ...fields,
    },
  });

  const remaining = () => candidates.filter((r) => unassigned.has(r.id));

  if (pendingGroups.length === 0) return slots;

  const split = groups.length > 1 || groups[0].colorKey !== "";

  if (!split) {
    const group = pendingGroups[0];
    const rows = remaining();
    if (rows.length === 0) {
      const sameTitle = (byTitle.get(norm(product.title)) ?? []).filter(
        (r) => !claimed.has(r.id) && !shopifyHandles.has(norm(r.handle)),
      );
      if (sameTitle.length) {
        slots.push(base(group, { status: "needs_review", method: "title", reason: "no handle match; same title as a legacy row (renamed handle?)", candidates: describe(sameTitle) }));
      } else {
        slots.push(base(group, {}));
      }
      return slots;
    }

    const shopifySkus = new Set(group.variants.map((v) => v.sku).filter(isRealSku).map(String));
    if (rows.length === 1) {
      const row = rows[0];
      const oldSkus = legacySkus(row);
      if (shopifySkus.size && oldSkus.size) {
        const overlap = [...oldSkus].some((s) => shopifySkus.has(s));
        if (!overlap) {
          slots.push(base(group, { status: "needs_review", method: "handle", reason: "handle matches but none of the SKUs do", candidates: describe(rows) }));
          return slots;
        }
        take(row.id);
        slots.push(base(group, { status: "auto", method: "handle+sku", confidence: 1, legacyProductId: row.id }));
        return slots;
      }
      take(row.id);
      slots.push(base(group, { status: "auto", method: "handle", confidence: 0.8, legacyProductId: row.id, reason: "no real SKUs to confirm with" }));
      return slots;
    }

    // Several legacy rows for one Shopify product without colours.
    const colours = new Set(rows.map((r) => ((r.primary_colors as string[] | null) ?? []).map(norm).sort().join("/")));
    if (colours.size > 1) {
      slots.push(base(group, { status: "needs_review", method: "duplicate", reason: "several legacy rows with different colours, but Shopify has no colour option", candidates: describe(rows) }));
      return slots;
    }
    const [keep, ...duplicates] = [...rows].sort((a, b) => legacyScore(b, usage) - legacyScore(a, usage));
    take(keep.id);
    duplicates.forEach((r) => take(r.id));
    slots.push(base(group, { status: "auto", method: "duplicate", confidence: 0.9, legacyProductId: keep.id, duplicateLegacyIds: duplicates.map((r) => r.id), reason: `kept the most complete of ${rows.length} legacy rows` }));
    return slots;
  }

  // Split by colour: match each colour by SKUs, then by colour name.
  const decided = new Map<string, Slot>();
  for (const group of pendingGroups) {
    const skus = new Set(group.variants.map((v) => v.sku).filter(isRealSku).map(String));
    const bySku = remaining().filter((r) => [...legacySkus(r)].some((s) => skus.has(s)));
    if (bySku.length === 1) {
      take(bySku[0].id);
      decided.set(group.colorKey, base(group, { status: "auto", method: "handle+sku", confidence: 1, legacyProductId: bySku[0].id }));
    }
  }
  for (const group of pendingGroups) {
    if (decided.has(group.colorKey)) continue;
    const colour = norm(group.colorValue);
    const byColour = remaining().filter((r) => ((r.primary_colors as string[] | null) ?? []).map(norm).includes(colour));
    if (byColour.length === 1) {
      take(byColour[0].id);
      decided.set(group.colorKey, base(group, { status: "auto", method: "handle+colour", confidence: 0.9, legacyProductId: byColour[0].id }));
    }
  }
  const leftGroups = pendingGroups.filter((g) => !decided.has(g.colorKey));
  const leftRows = remaining();
  for (const group of leftGroups) {
    if (leftRows.length) {
      decided.set(group.colorKey, base(group, { status: "needs_review", method: "handle+colour", reason: "colour doesn't match any remaining legacy row", candidates: describe(leftRows) }));
    } else {
      // A colour the CSV never had: a new row that shares the product's variant_id.
      decided.set(group.colorKey, base(group, { status: "new", method: candidates.length ? "colour_sibling" : "new" }));
    }
  }
  for (const group of pendingGroups) slots.push(decided.get(group.colorKey)!);
  return slots;
}

// ----------------------------------------------------------------- merging ---

type Sources = Record<string, string>;

function setField(row: ProductRow, sources: Sources, field: string, value: unknown, source: string) {
  row[field] = value;
  sources[field] = source;
}

function buildRow(
  input: PlanInput,
  slot: Slot,
  base: ProductRow | null,
  baseKind: "catalog" | "legacy" | "sibling" | null,
  sibling: ProductRow | null,
  claimedImages: Set<string>,
  now: Date,
): { row: ProductRow; variants: CatalogVariantRow[]; notes: string[] } {
  const { product, group } = slot;
  const notes: string[] = [];
  const row: ProductRow = { id: "" };
  const sources: Sources = { ...((baseKind === "catalog" ? (base?.field_sources as Sources) : null) ?? {}) };
  const carriedSource = baseKind === "catalog" ? null : baseKind;

  // 1. Carry AI work and anything Shopify doesn't own.
  const donor = base ?? sibling;
  if (donor) {
    for (const field of CARRIED_FIELDS) {
      if (!base && COLOUR_SPECIFIC_FIELDS.has(field)) continue;
      const value = donor[field];
      if (value === undefined) continue;
      row[field] = value;
      if (carriedSource && !isEmpty(value)) sources[field] = base ? carriedSource : "sibling";
      else if (!base && !isEmpty(value)) sources[field] = "sibling";
    }
  }
  if (!base) {
    row.analysis_status = "pending";
    row.ghost_status = "pending";
    row.data_version = row.data_version ?? "1.0.0";
    row.ingested_at = now;
    row.created_at = now;
  }
  // Legacy multi-valued scalars come in three spellings; settle on "a; b".
  for (const field of ["neckline", "sleeve_length_type", "top_length_type", "skirt_dress_length_type", "pants_length_type", "waist_rise", "fit_type"]) {
    if (typeof row[field] === "string") row[field] = cleanLegacyScalar(row[field], field);
  }

  // 2. Shopify-owned facts.
  const allImages = mediaImages(product);
  let images: Image[];
  if (group.colorKey === "") {
    images = allImages;
  } else if (base && Array.isArray(base.images) && base.images.length) {
    // A matched colour keeps the images it was curated with, minus any the
    // brand has since removed, plus its anchor shot.
    const current = new Map(allImages.map((img) => [imageIdentity(img.src), img]));
    images = (base.images as Image[]).map((img) => current.get(imageIdentity(img.src))).filter((img): img is Image => !!img);
    for (const url of group.anchorImages) {
      if (!images.some((img) => imageIdentity(img.src) === imageIdentity(url))) {
        images.unshift(current.get(imageIdentity(url)) ?? { src: url, alt_text: null });
      }
    }
  } else {
    // A new colour gets its own anchor shots plus the media no other colour uses.
    const anchors = new Set(group.anchorImages.map(imageIdentity));
    images = allImages.filter((img) => anchors.has(imageIdentity(img.src)) || !claimedImages.has(imageIdentity(img.src)));
    images.sort((a, b) => Number(anchors.has(imageIdentity(b.src))) - Number(anchors.has(imageIdentity(a.src))));
    notes.push("images for this colour were chosen automatically (its own variant images + unclaimed media)");
  }
  if (group.colorKey !== "" && !group.anchorImages.length) {
    notes.push("colour has no variant images; using all product media");
    images = allImages;
  }
  setField(row, sources, "images", images, group.colorKey && !group.anchorImages.length ? "derived" : "shopify");
  setField(row, sources, "primary_image", images[0]?.src ?? null, "shopify");
  setField(row, sources, "title", product.title, "shopify");
  setField(row, sources, "handle", product.handle, "shopify");
  if (product.description?.trim()) setField(row, sources, "description", product.description.trim(), "shopify");
  else if (base?.description) row.description = base.description;

  const ordered = [...group.variants].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const prices = ordered.map((v) => Number(v.price));
  const compareAts = ordered.map((v) => (v.compareAtPrice === null ? null : Number(v.compareAtPrice))).filter((v): v is number => v !== null);
  const sizes = sortSizes([...new Set(ordered.map(sizeOf))]);
  const inStock = sortSizes([...new Set(ordered.filter(canBuy).map(sizeOf))]);
  if (sizes.length === 0 && ordered.length > 0) sizes.push("FREE SIZE");
  if (inStock.length === 0 && ordered.some(canBuy)) inStock.push("FREE SIZE");
  setField(row, sources, "variants", ordered.map(variantJson), "shopify");
  // The row's SKU is the colour's first real Shopify SKU; legacy TEMP-SKU codes are dropped.
  setField(row, sources, "sku_id", ordered.map((v) => v.sku).find(isRealSku) ?? null, "shopify");
  setField(row, sources, "sizes", sizes, "shopify");
  setField(row, sources, "price", prices.length ? Math.min(...prices).toFixed(2) : null, "shopify");
  setField(row, sources, "min_price", prices.length ? Math.min(...prices).toFixed(2) : null, "shopify");
  setField(row, sources, "max_price", prices.length ? Math.max(...prices).toFixed(2) : null, "shopify");
  setField(row, sources, "compare_at_price", compareAts.length ? Math.max(...compareAts).toFixed(2) : null, "shopify");
  setField(row, sources, "discounted", ordered.some((v) => v.compareAtPrice !== null && Number(v.compareAtPrice) > Number(v.price)), "shopify");
  setField(row, sources, "stock", ordered.reduce((sum, v) => sum + Math.max(v.inventoryQuantity ?? 0, 0), 0), "shopify");
  setField(row, sources, "sizes_in_stock", inStock, "shopify");

  const live = isLiveProduct(product);
  row.live_on_aeza = live;
  row.is_active = live;
  row.is_available = live && inStock.length > 0;
  row.deleted_at = product.deletedAt ?? null;
  row.shopify_status = product.deletedAt ? "DELETED" : product.status;
  row.shopify_category = product.categoryName;
  row.shopify_tags = product.tags;
  row.online_store_url = product.onlineStoreUrl;
  row.collections = product.collections.map((c) => ({ id: c.id ?? null, handle: c.handle ?? null, title: c.title }));
  const info = metafield(product, "custom", "product_info");
  row.product_info = typeof info === "string" ? info : null;
  const rating = metafield(product, "reviews", "rating") as { value?: string } | undefined;
  row.rating = rating?.value ? Number(rating.value).toFixed(2) : null;
  const ratingCount = metafield(product, "reviews", "rating_count");
  row.rating_count = typeof ratingCount === "number" ? ratingCount : null;
  const linked = metafield(product, "custom", "linked_products");
  row.linked_product_ids = Array.isArray(linked) ? linked.map(String) : [];

  // 3. Brand attributes (Shopify metafields), when they could be read.
  const fabric = attribute(product, "fabric", input.metaobjects);
  if (fabric?.complete && fabric.labels.length) setField(row, sources, "fabric", normalizeFabric(fabric.labels), "shopify");
  else if (fabric && !fabric.complete) notes.push("fabric attribute couldn't be read (metaobject access); kept existing value");

  const colours = attribute(product, "color-pattern", input.metaobjects);
  const patternTags = (colours?.entries ?? []).filter((e) => !e.hex).map((e) => slugValue(e.label!));
  if (group.colorValue) {
    setField(row, sources, "primary_colors", [titleCase(group.colorValue)], "shopify");
  } else if (colours?.complete) {
    const names = colours.entries.filter((e) => e.hex).map((e) => titleCase(e.label!));
    if (names.length) setField(row, sources, "primary_colors", names, "shopify");
  }
  if (patternTags.length) {
    row.tags = [...new Set([...(row.tags ?? []), ...patternTags])];
  }

  for (const { key, column, normalize } of ATTRIBUTE_FIELDS) {
    const resolved = attribute(product, key, input.metaobjects);
    if (!resolved?.complete || !resolved.labels.length) continue;
    const value = normalize(resolved.labels);
    if (value) setField(row, sources, column, value, "shopify");
  }

  const gender = attribute(product, "target-gender", input.metaobjects);
  if (gender?.complete) {
    const chosen = chooseGender(gender.labels, row.gender ?? null);
    if (chosen && chosen !== row.gender) setField(row, sources, "gender", chosen, "shopify");
  }

  const fit = attribute(product, "fit", input.metaobjects);
  if (fit?.complete && isEmpty(row.fit_type)) {
    const fitType = normalizeFitType(fit.labels);
    if (fitType) setField(row, sources, "fit_type", fitType, "shopify");
  }

  // 4. Gaps a rule can fill without AI.
  if (isEmpty(row.product_category)) {
    const category = categoryFromShopify(product.categoryName, product.title, product.productType, input.knownCategories);
    const fromMerchant = categoryFromMerchantType(product.productType);
    if (category) {
      setField(row, sources, "product_category", category, "derived");
    } else if (fromMerchant) {
      setField(row, sources, "product_category", fromMerchant, "derived");
    }
  }

  // Strict product_type mapping: ONLY 'Clothing' or 'Accessories'
  const computedType = determineProductType(row.product_category, product.productType, product.title);
  setField(row, sources, "product_type", computedType, "derived");

  // Fallback gender if missing
  if (isEmpty(row.gender)) {
    const cat = (row.product_category ?? "").toLowerCase();
    if (["dresses", "skirts", "sarees", "kaftans", "kurtas", "kurta sets", "blouses", "crop tops", "bikini sets"].some((c) => cat.includes(c))) {
      setField(row, sources, "gender", "women", "derived");
    } else if (computedType === "Accessories") {
      setField(row, sources, "gender", "unisex", "derived");
    }
  }

  // Fallback base_color if missing but primary_colors exists
  if (isEmpty(row.base_color) && Array.isArray(row.primary_colors) && row.primary_colors.length > 0) {
    setField(row, sources, "base_color", row.primary_colors.map((c: string) => c.toLowerCase()), "derived");
  }

  if (isEmpty(row.brand)) setField(row, sources, "brand", input.brand.name, "derived");
  if (isEmpty(row.brand_id)) setField(row, sources, "brand_id", input.brand.id, "derived");
  if (isEmpty(row.tags)) {
    const cleanMerchantTags = (product.tags ?? []).filter((t: string) => !/^[A-Z0-9_\-/]{8,}$/.test(t) && !t.includes("TEMP-"));
    const tags = [row.product_category, row.brand, ...(row.primary_colors ?? []), ...(row.fabric ?? []), row.gender, ...cleanMerchantTags]
      .filter(Boolean)
      .map((t: string) => t.toLowerCase());
    setField(row, sources, "tags", [...new Set(tags)], "derived");
  }

  row.text_hash = sha([product.title, product.description ?? "", row.product_info ?? "", product.productType ?? ""]);
  row.image_hash = sha(images.map((img) => imageIdentity(img.src)));
  row.field_sources = sources;

  const variantRows = ordered.map((v) => ({
    variantId: v.id,
    catalogProductId: "",
    shop: input.shop,
    sku: isRealSku(v.sku) ? v.sku : null,
    size: normalizeSizeToken(sizeOf(v)) ?? "FREE SIZE",
    options: Object.fromEntries(v.selectedOptions.map((o) => [o.name, o.value])),
    position: v.position,
    price: Number(v.price).toFixed(2),
    compareAtPrice: v.compareAtPrice === null ? null : Number(v.compareAtPrice).toFixed(2),
    availableQty: v.inventoryQuantity ?? 0,
    inventoryPolicy: v.inventoryPolicy,
    tracked: v.inventoryItem?.tracked !== false,
    available: canBuy(v),
  }));
  if (row.product_category) row.product_category = normalizeCategory(row.product_category);
  applyCategoryFieldExclusions(row);

  return { row, variants: variantRows, notes };
}

// --------------------------------------------------------------------- plan ---

export function planCatalog(input: PlanInput): PlanResult {
  const now = input.now ?? new Date();
  const byHandle = new Map<string, ProductRow[]>();
  const byTitle = new Map<string, ProductRow[]>();
  for (const row of input.legacyRows) {
    const h = norm(row.handle);
    byHandle.set(h, [...(byHandle.get(h) ?? []), row]);
    const t = norm(row.title);
    byTitle.set(t, [...(byTitle.get(t) ?? []), row]);
  }
  const legacyById = new Map(input.legacyRows.map((r) => [r.id, r]));
  const existingBySlot = new Map(input.existingRows.filter((r) => r.shopify_product_id).map((r) => [`${r.shopify_product_id}|${r.color_key ?? ""}`, r]));
  const settledSlots = new Set(existingBySlot.keys());
  const existingById = new Map(input.existingRows.map((r) => [r.id, r]));
  const existingLinks = new Map(input.existingLinks.map((l) => [`${l.shopifyProductId}|${l.colorKey}`, l]));
  const shopifyHandles = new Set(input.shopifyProducts.map((p) => norm(p.handle)));

  const claimed = new Set<string>();
  const result: PlanResult = { rows: [], variants: [], links: [], deletes: [], notes: [] };
  const existingOf = (productId: string) => input.existingRows.filter((r) => r.shopify_product_id === productId);
  const remove = (row: ProductRow, why: string) => {
    result.deletes.push(row.id);
    result.notes.push({ handle: row.handle ?? null, colorKey: row.color_key ?? "", note: `removed from the catalog (${why})` });
  };

  for (const product of input.shopifyProducts) {
    // Only published products (active or draft, not deleted) are in the catalog.
    if (!inCatalog(product)) {
      existingOf(product.productId).forEach((row) =>
        remove(row, product.deletedAt ? "deleted in Shopify" : !product.published ? "unpublished" : `status ${product.status}`),
      );
      continue;
    }
    const groups = groupsOf(product);
    const slots = matchProduct(product, groups, byHandle, byTitle, shopifyHandles, existingLinks, input.legacyUsage, claimed, settledSlots);

    // Rows of this product already built, so new colours can inherit from a sibling.
    const productRows: ProductRow[] = [];
    const claimedImages = new Set<string>();
    // Matched slots first: their images are claimed before new colours pick theirs.
    const ordered = [...slots].sort((a, b) => Number(!a.link.legacyProductId) - Number(!b.link.legacyProductId));

    for (const slot of ordered) {
      result.links.push(slot.link);
      if (slot.link.status === "needs_review") {
        result.notes.push({ handle: product.handle, colorKey: slot.group.colorKey, note: `needs review: ${slot.link.reason}` });
        continue;
      }
      const existing = existingBySlot.get(`${product.productId}|${slot.group.colorKey}`) ?? null;
      const legacy = slot.link.legacyProductId ? legacyById.get(slot.link.legacyProductId) ?? existingById.get(slot.link.legacyProductId) ?? null : null;
      const base = existing ?? legacy;
      const baseKind = existing ? "catalog" : legacy ? "legacy" : null;
      const sibling = base ? null : productRows[0] ?? (byHandle.get(norm(product.handle)) ?? [])[0] ?? null;

      const { row, variants, notes } = buildRow(input, slot, base, baseKind, sibling, claimedImages, now);
      row.id = existing?.id ?? legacy?.id ?? randomUUID();
      row.variant_id = existing?.variant_id ?? legacy?.variant_id ?? sibling?.variant_id ?? productRows[0]?.variant_id ?? randomUUID();
      row.shop = input.shop;
      row.shopify_product_id = product.productId;
      row.color_key = slot.group.colorKey;
      row.source = "shopify";
      row.legacy_product_id = legacy?.id ?? existing?.legacy_product_id ?? null;
      row.synced_at = now;
      row.updated_at = now;
      for (const img of row.images as Image[]) claimedImages.add(imageIdentity(img.src));
      variants.forEach((v) => (v.catalogProductId = row.id));

      result.rows.push(row);
      result.variants.push(...variants);
      notes.forEach((note) => result.notes.push({ handle: product.handle, colorKey: slot.group.colorKey, note }));
      productRows.push(row);
    }

    // A colour the product no longer has (or one now waiting for review).
    const built = new Set(productRows.map((r) => r.id));
    existingOf(product.productId)
      .filter((row) => !built.has(row.id))
      .forEach((row) => remove(row, `colour "${row.color_key}" no longer sold, or waiting for review`));
  }

  // Rows of products that aren't in this run's input: removed only when the
  // live sync says they're gone or unpublished (removedProductIds), never
  // because the mirror happens to lack them. Rows from before this rule
  // that came from the legacy table alone are removed too.
  const seenProducts = new Set(input.shopifyProducts.map((p) => p.productId));
  for (const existing of input.existingRows) {
    if (!existing.shopify_product_id) {
      remove(existing, "not a Shopify product");
    } else if (!seenProducts.has(existing.shopify_product_id) && input.removedProductIds?.has(existing.shopify_product_id)) {
      remove(existing, "deleted or unpublished in Shopify");
    }
  }

  // Legacy rows without a published Shopify product aren't stored; matched
  // ones (and their duplicates) live on through the catalog row's id.
  const unmatched = input.legacyRows.filter((r) => !claimed.has(r.id)).length;
  if (unmatched) {
    result.notes.push({ handle: null, colorKey: "", note: `${unmatched} legacy rows have no published Shopify product; not stored` });
  }

  return result;
}

type ProductState = Pick<ShopifyProductInput, "published" | "status" | "deletedAt">;

// Shopify statuses a published product may have to be in the catalog.
// Only ACTIVE products are included in the catalog (drafts are excluded).
const CATALOG_STATUSES = new Set(["ACTIVE"]);

/** In the catalog: the brand published it, it's active in Shopify, and not deleted. */
export function inCatalog(product: ProductState): boolean {
  return product.published && CATALOG_STATUSES.has(product.status ?? "") && !product.deletedAt;
}

/** Live on Aeza (can be shown and bought): in the catalog and ACTIVE in Shopify. */
export function isLiveProduct(product: ProductState): boolean {
  return inCatalog(product) && product.status === "ACTIVE";
}
