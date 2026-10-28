// The full Shopify mirror, shopify_connector."full_ShopifyProducts": every
// field Shopify has for a product (category, options and swatches, price
// ranges, SEO, media, metafields, collections, variants), one row per
// product. It's the catalog pipeline's input, filled three ways with the
// same row shape:
//   * the bulk export on install / nightly (BULK_FULL_PRODUCTS_QUERY, via
//     product-sync.server.ts),
//   * product webhooks (fetchFullProduct, one product),
//   * npm run store:full-export (every product, one by one).
// The bulk export can't nest more than five connections, so its variants
// carry no per-location stock or variant metafields; the per-product query
// has both.
//
// Not fetched on purpose: inventoryItem.unitCost (the brand's cost price,
// commercially sensitive and not needed by Aeza).

import type { PrismaClient } from "@prisma/client";

export type GraphqlRequest = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

const INVENTORY_ITEM_FIELDS = `
    id tracked requiresShipping
    countryCodeOfOrigin provinceCodeOfOrigin harmonizedSystemCode
    measurement { weight { unit value } }`;

// Scalar variant fields shared by the per-product and the bulk query.
const VARIANT_SCALARS = `
  id legacyResourceId title displayName sku barcode position
  price compareAtPrice taxable
  inventoryQuantity sellableOnlineQuantity inventoryPolicy availableForSale
  showUnitPrice
  unitPrice { amount currencyCode }
  unitPriceMeasurement { measuredType quantityUnit quantityValue referenceUnit referenceValue }
  selectedOptions { name value }
  createdAt updatedAt`;

// Kept to 25 variants per page: per-location stock makes each variant
// expensive, and a single query may cost at most 1000 points.
const VARIANT_FIELDS = `
  ${VARIANT_SCALARS}
  media(first: 5) { nodes { ... on MediaImage { image { url } } } }
  metafields(first: 20) { nodes { namespace key type value } }
  inventoryItem {
    ${INVENTORY_ITEM_FIELDS}
    inventoryLevels(first: 10) {
      nodes {
        location { id name }
        quantities(names: ["available", "on_hand", "committed", "incoming", "reserved"]) { name quantity }
      }
    }
  }`;

// Scalar product fields shared by the per-product and the bulk query.
const PRODUCT_SCALARS = `
  id legacyResourceId title handle descriptionHtml description vendor productType tags status
  category { id name fullName }
  options {
    id name position values
    linkedMetafield { namespace key }
    optionValues {
      id name hasVariants linkedMetafieldValue
      swatch { color image { image { url } } }
    }
  }
  onlineStoreUrl
  seo { title description }
  totalInventory tracksInventory hasOutOfStockVariants
  isGiftCard hasOnlyDefaultVariant requiresSellingPlan templateSuffix combinedListingRole
  priceRangeV2 {
    minVariantPrice { amount currencyCode }
    maxVariantPrice { amount currencyCode }
  }
  compareAtPriceRange {
    minVariantCompareAtPrice { amount currencyCode }
    maxVariantCompareAtPrice { amount currencyCode }
  }
  sellingPlanGroupsCount { count }
  variantsCount { count }
  mediaCount { count }
  featuredMedia { ... on MediaImage { id image { url altText width height } } }
  createdAt publishedAt updatedAt`;

const MEDIA_FIELDS = `
  id mediaContentType alt status
  preview { image { url } }
  ... on MediaImage { mimeType originalSource { fileSize } image { url altText width height } }
  ... on Video { duration sources { url mimeType format height width fileSize } }
  ... on ExternalVideo { host originUrl embedUrl }
  ... on Model3d { sources { url mimeType format filesize } }`;

const COLLECTION_FIELDS = `id handle title description sortOrder image { url altText }`;

export const PRODUCT_IDS_QUERY = `#graphql
  query ProductIds($after: String) {
    products(first: 250, after: $after) {
      nodes { id }
      pageInfo { hasNextPage endCursor }
    }
  }`;

export const FULL_PRODUCT_QUERY = `#graphql
  query FullProduct($id: ID!) {
    product(id: $id) {
      ${PRODUCT_SCALARS}
      media(first: 50) { nodes { ${MEDIA_FIELDS} } }
      metafields(first: 50) { nodes { namespace key type value } }
      collections(first: 50) { nodes { ${COLLECTION_FIELDS} } }
      variants(first: 25) {
        nodes { ${VARIANT_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

const MORE_VARIANTS_QUERY = `#graphql
  query MoreVariants($id: ID!, $after: String) {
    product(id: $id) {
      variants(first: 25, after: $after) {
        nodes { ${VARIANT_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

// Bulk queries allow five connections, counting `products` itself: media,
// metafields, variants and the variants' media. Collections don't fit, so a
// bulk row keeps the collections already stored (product webhooks fill
// them). Every node that becomes its own JSONL line selects `id`, so
// BulkProductAssembler can tell them apart.
export const BULK_FULL_PRODUCTS_QUERY = `{
  products {
    edges {
      node {
        ${PRODUCT_SCALARS}
        media { edges { node { ${MEDIA_FIELDS} } } }
        metafields { edges { node { id namespace key type value } } }
        variants {
          edges {
            node {
              ${VARIANT_SCALARS}
              inventoryItem { ${INVENTORY_ITEM_FIELDS} }
              media { edges { node { ... on MediaImage { id image { url } } } } }
            }
          }
        }
      }
    }
  }
}`;

// Columns added to the table after it was first created.
const ADDED_COLUMNS: Record<string, string> = {
  legacyResourceId: "text",
  currencyCode: "text",
  minPrice: "numeric(12,2)",
  maxPrice: "numeric(12,2)",
  minCompareAtPrice: "numeric(12,2)",
  maxCompareAtPrice: "numeric(12,2)",
  isGiftCard: "boolean",
  hasOnlyDefaultVariant: "boolean",
  requiresSellingPlan: "boolean",
  templateSuffix: "text",
  combinedListingRole: "text",
  sellingPlanGroupsCount: "integer",
};

type PageInfo = { hasNextPage: boolean; endCursor: string | null };
type Connection<T> = { nodes: T[]; pageInfo?: PageInfo };
type Money = { amount: string; currencyCode: string } | null;

export type FullVariant = Record<string, unknown> & {
  id: string;
  media?: { nodes: Array<{ image?: { url: string } }> };
  metafields?: { nodes: unknown[] };
  inventoryItem: (Record<string, unknown> & { inventoryLevels?: { nodes: unknown[] } }) | null;
};

export type FullProduct = {
  id: string;
  legacyResourceId: string;
  title: string;
  handle: string | null;
  descriptionHtml: string | null;
  description: string | null;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  status: string | null;
  category: { id: string; name: string; fullName: string } | null;
  options: unknown[];
  onlineStoreUrl: string | null;
  seo: { title: string | null; description: string | null };
  totalInventory: number | null;
  tracksInventory: boolean | null;
  hasOutOfStockVariants: boolean | null;
  isGiftCard: boolean;
  hasOnlyDefaultVariant: boolean;
  requiresSellingPlan: boolean;
  templateSuffix: string | null;
  combinedListingRole: string | null;
  priceRangeV2: { minVariantPrice: Money; maxVariantPrice: Money };
  compareAtPriceRange: { minVariantCompareAtPrice: Money; maxVariantCompareAtPrice: Money } | null;
  sellingPlanGroupsCount: { count: number } | null;
  variantsCount: { count: number } | null;
  mediaCount: { count: number } | null;
  featuredMedia: unknown;
  media: Connection<unknown>;
  metafields: Connection<unknown>;
  /** null when not fetched (the bulk export): the stored value is kept. */
  collections: Connection<unknown> | null;
  variants: Connection<FullVariant>;
  createdAt: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
};

export async function fetchProductIds(graphql: GraphqlRequest): Promise<string[]> {
  const ids: string[] = [];
  let after: string | null = null;
  do {
    const data: { products: Connection<{ id: string }> & { pageInfo: PageInfo } } = await graphql(
      PRODUCT_IDS_QUERY,
      { after },
    );
    ids.push(...data.products.nodes.map((node) => node.id));
    after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (after);
  return ids;
}

/** One product with all its variants, or null when Shopify no longer has it. */
export async function fetchFullProduct(graphql: GraphqlRequest, id: string): Promise<FullProduct | null> {
  const { product } = await graphql<{ product: FullProduct | null }>(FULL_PRODUCT_QUERY, { id });
  if (!product) return null;

  let pageInfo = product.variants.pageInfo;
  while (pageInfo?.hasNextPage) {
    const more: { product: { variants: Connection<FullVariant> } } = await graphql(MORE_VARIANTS_QUERY, {
      id,
      after: pageInfo.endCursor,
    });
    product.variants.nodes.push(...more.product.variants.nodes);
    pageInfo = more.product.variants.pageInfo;
  }
  return product;
}

/**
 * Rebuilds products from the bulk JSONL file, where every connection node is
 * its own line pointing at its parent (`__parentId`). Lines arrive parent
 * first, so a product is complete when the next product line starts:
 * `add` returns the previous product then, and `finish` returns the last.
 */
export class BulkProductAssembler {
  private current: FullProduct | null = null;
  private variants = new Map<string, FullVariant>();

  add(line: Record<string, unknown> & { __parentId?: string }): FullProduct | null {
    const { __parentId: parentId, ...node } = line;
    if (!parentId) {
      const done = this.finish();
      this.current = {
        ...(node as unknown as FullProduct),
        media: { nodes: [] },
        metafields: { nodes: [] },
        collections: null,
        variants: { nodes: [] },
      };
      return done;
    }
    if (!this.current) return null;

    const id = String(node.id ?? "");
    const variant = this.variants.get(parentId);
    if (variant) {
      // A variant's media line.
      if ((node.image as { url?: string } | undefined)?.url) variant.media!.nodes.push(node as { image: { url: string } });
    } else if (parentId === this.current.id) {
      if (id.includes("/ProductVariant/")) {
        const v = { ...(node as FullVariant), media: { nodes: [] } };
        this.variants.set(id, v);
        this.current.variants.nodes.push(v);
      } else if (id.includes("/Metafield/")) {
        // Same shape as the per-product query, which doesn't select the id.
        const metafield = { ...node };
        delete metafield.id;
        this.current.metafields.nodes.push(metafield);
      } else {
        this.current.media.nodes.push(node);
      }
    }
    return null;
  }

  finish(): FullProduct | null {
    const done = this.current;
    this.current = null;
    this.variants.clear();
    return done;
  }
}

type Metafield = { namespace: string; key: string; type: string; value: string };

// Metafield types whose value Shopify sends as a JSON-encoded string.
const JSON_METAFIELD_TYPES = new Set([
  "json", "rating", "dimension", "weight", "volume", "money", "link", "rich_text_field",
]);

// Shopify returns every metafield value as a string. Decode it by type so
// lists, JSON and ratings are stored as real JSON and numbers/booleans as
// numbers/booleans; text, HTML and single references stay strings. The
// original strings are kept in the raw column.
function decodeMetafield(metafield: Metafield) {
  const { type, value } = metafield;
  let decoded: unknown = value;
  try {
    if (type.startsWith("list.") || JSON_METAFIELD_TYPES.has(type)) {
      decoded = JSON.parse(value);
    } else if (type === "number_integer" || type === "number_decimal") {
      decoded = Number(value);
    } else if (type === "boolean") {
      decoded = value === "true";
    }
  } catch {
    // Malformed value: keep Shopify's string as-is.
  }
  return { ...metafield, value: decoded };
}

// Flattens the variant's connections: media to a URL list, metafields and
// inventory levels to plain arrays.
function toVariantRow(variant: FullVariant) {
  const { media, metafields, inventoryItem, ...rest } = variant;
  return {
    ...rest,
    images: (media?.nodes ?? []).map((node) => node.image?.url).filter(Boolean),
    metafields: ((metafields?.nodes ?? []) as Metafield[]).map(decodeMetafield),
    inventoryItem: inventoryItem && {
      ...inventoryItem,
      inventoryLevels: inventoryItem.inventoryLevels?.nodes ?? [],
    },
  };
}

const toDate = (value: string | null) => (value ? new Date(value) : null);

let columnsEnsured = false;

/** Adds columns introduced after the table was created (once per process). */
export async function ensureFullColumns(prisma: PrismaClient): Promise<void> {
  if (columnsEnsured) return;
  for (const [name, type] of Object.entries(ADDED_COLUMNS)) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE shopify_connector."full_ShopifyProducts" ADD COLUMN IF NOT EXISTS "${name}" ${type}`,
    );
  }
  columnsEnsured = true;
}

/** Upserts one product into the full mirror, on (shop, productId). */
export async function saveFullProduct(prisma: PrismaClient, shop: string, product: FullProduct): Promise<void> {
  const { variants, ...productFields } = product;
  const variantRows = variants.nodes.map(toVariantRow);
  const metafieldRows = (product.metafields.nodes as Metafield[]).map(decodeMetafield);
  // raw keeps Shopify's response as received (metafield values undecoded).
  const raw = { ...productFields, variants: variants.nodes };
  const price = product.priceRangeV2;
  const compareAt = product.compareAtPriceRange;

  await prisma.$executeRaw`
    INSERT INTO shopify_connector."full_ShopifyProducts" (
      shop, "productId", "legacyResourceId", title, handle, "descriptionHtml",
      description, vendor, "productType", tags, status,
      "categoryId", "categoryName", "categoryFullName",
      options, "onlineStoreUrl", "seoTitle", "seoDescription", "totalInventory",
      "tracksInventory", "hasOutOfStockVariants",
      "currencyCode", "minPrice", "maxPrice", "minCompareAtPrice", "maxCompareAtPrice",
      "isGiftCard", "hasOnlyDefaultVariant", "requiresSellingPlan", "templateSuffix",
      "combinedListingRole", "sellingPlanGroupsCount",
      "variantsCount", "mediaCount",
      "featuredImage", media, metafields, collections, variants,
      "shopifyCreatedAt", "publishedAt", "shopifyUpdatedAt", raw,
      "fetchedAt", "updatedAt"
    ) VALUES (
      ${shop}, ${product.id}, ${product.legacyResourceId}, ${product.title}, ${product.handle},
      ${product.descriptionHtml}, ${product.description}, ${product.vendor},
      ${product.productType}, ${product.tags}, ${product.status},
      ${product.category?.id ?? null}, ${product.category?.name ?? null},
      ${product.category?.fullName ?? null},
      ${JSON.stringify(product.options)}::jsonb, ${product.onlineStoreUrl},
      ${product.seo?.title ?? null}, ${product.seo?.description ?? null}, ${product.totalInventory},
      ${product.tracksInventory}, ${product.hasOutOfStockVariants},
      ${price?.minVariantPrice?.currencyCode ?? null},
      ${price?.minVariantPrice?.amount ?? null}::numeric,
      ${price?.maxVariantPrice?.amount ?? null}::numeric,
      ${compareAt?.minVariantCompareAtPrice?.amount ?? null}::numeric,
      ${compareAt?.maxVariantCompareAtPrice?.amount ?? null}::numeric,
      ${product.isGiftCard}, ${product.hasOnlyDefaultVariant}, ${product.requiresSellingPlan},
      ${product.templateSuffix}, ${product.combinedListingRole},
      ${product.sellingPlanGroupsCount?.count ?? null},
      ${product.variantsCount?.count ?? null}, ${product.mediaCount?.count ?? null},
      ${product.featuredMedia ? JSON.stringify(product.featuredMedia) : null}::jsonb,
      ${JSON.stringify(product.media.nodes)}::jsonb,
      ${JSON.stringify(metafieldRows)}::jsonb,
      ${JSON.stringify(product.collections?.nodes ?? [])}::jsonb,
      ${JSON.stringify(variantRows)}::jsonb,
      ${toDate(product.createdAt)}::timestamp, ${toDate(product.publishedAt)}::timestamp,
      ${toDate(product.updatedAt)}::timestamp, ${JSON.stringify(raw)}::jsonb,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT (shop, "productId") DO UPDATE SET
      "legacyResourceId" = EXCLUDED."legacyResourceId",
      title = EXCLUDED.title,
      handle = EXCLUDED.handle,
      "descriptionHtml" = EXCLUDED."descriptionHtml",
      description = EXCLUDED.description,
      vendor = EXCLUDED.vendor,
      "productType" = EXCLUDED."productType",
      tags = EXCLUDED.tags,
      status = EXCLUDED.status,
      "categoryId" = EXCLUDED."categoryId",
      "categoryName" = EXCLUDED."categoryName",
      "categoryFullName" = EXCLUDED."categoryFullName",
      options = EXCLUDED.options,
      "onlineStoreUrl" = EXCLUDED."onlineStoreUrl",
      "seoTitle" = EXCLUDED."seoTitle",
      "seoDescription" = EXCLUDED."seoDescription",
      "totalInventory" = EXCLUDED."totalInventory",
      "tracksInventory" = EXCLUDED."tracksInventory",
      "hasOutOfStockVariants" = EXCLUDED."hasOutOfStockVariants",
      "currencyCode" = EXCLUDED."currencyCode",
      "minPrice" = EXCLUDED."minPrice",
      "maxPrice" = EXCLUDED."maxPrice",
      "minCompareAtPrice" = EXCLUDED."minCompareAtPrice",
      "maxCompareAtPrice" = EXCLUDED."maxCompareAtPrice",
      "isGiftCard" = EXCLUDED."isGiftCard",
      "hasOnlyDefaultVariant" = EXCLUDED."hasOnlyDefaultVariant",
      "requiresSellingPlan" = EXCLUDED."requiresSellingPlan",
      "templateSuffix" = EXCLUDED."templateSuffix",
      "combinedListingRole" = EXCLUDED."combinedListingRole",
      "sellingPlanGroupsCount" = EXCLUDED."sellingPlanGroupsCount",
      "variantsCount" = EXCLUDED."variantsCount",
      "mediaCount" = EXCLUDED."mediaCount",
      "featuredImage" = EXCLUDED."featuredImage",
      media = EXCLUDED.media,
      metafields = EXCLUDED.metafields,
      collections = CASE WHEN ${product.collections === null} THEN "full_ShopifyProducts".collections ELSE EXCLUDED.collections END,
      variants = EXCLUDED.variants,
      "shopifyCreatedAt" = EXCLUDED."shopifyCreatedAt",
      "publishedAt" = EXCLUDED."publishedAt",
      "shopifyUpdatedAt" = EXCLUDED."shopifyUpdatedAt",
      raw = EXCLUDED.raw,
      "fetchedAt" = EXCLUDED."fetchedAt",
      "updatedAt" = EXCLUDED."updatedAt"
  `;
}
