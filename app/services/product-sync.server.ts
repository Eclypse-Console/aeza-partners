import prisma from "../db.server";
import type { AdminGraphqlClient } from "../models/products.server";
import { runAdminQuery } from "../models/products.server";
import { pushProductsToAeza } from "./aeza-catalog.server";

// Keeps ShopifyProduct / ShopifyVariant a full copy of each brand's catalog.
//
// Full sync (on install and nightly) uses a Shopify Bulk Operation, so even
// very large catalogs are exported by Shopify in the background instead of
// paged through inside one request. When it finishes Shopify sends the
// bulk_operations/finish webhook, which calls processBulkOperation to
// download the JSONL result and upsert it in batches.
//
// Single products (product webhooks) are re-fetched with refreshProduct.
//
// Publish rules (ShopifyStore.publishMode):
//   "all":      every ACTIVE product is published, including new ones;
//               drafts/archived are not.
//   "selected": the brand picks; new products start unpublished and a sync
//               never changes an existing product's `published`.

export type PublishMode = "selected" | "all";

export function isPublishMode(value: unknown): value is PublishMode {
  return value === "selected" || value === "all";
}

type SyncedVariant = {
  variantId: string;
  sku: string | null;
  title: string;
  options: Record<string, string>;
  price: string;
  compareAtPrice: string | null;
  inventoryItemId: string | null;
  availableQty: number;
};

type SyncedProduct = {
  productId: string;
  title: string;
  handle: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  tags: string[];
  images: string[];
  status: string;
  shopifyUpdatedAt: string;
  variants: SyncedVariant[];
};

// Fields shared by the bulk export and the single-product query.
type ProductFields = Omit<
  SyncedProduct,
  "productId" | "images" | "variants" | "shopifyUpdatedAt"
> & { id: string; updatedAt: string };

type VariantNode = {
  id: string;
  sku: string | null;
  title: string;
  price: string;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
  selectedOptions: Array<{ name: string; value: string }>;
  inventoryItem: { id: string } | null;
};

const BULK_PRODUCTS_QUERY = `{
  products {
    edges {
      node {
        id
        title
        handle
        descriptionHtml
        vendor
        productType
        tags
        status
        updatedAt
        media {
          edges { node { ... on MediaImage { image { url } } } }
        }
        variants {
          edges {
            node {
              id
              sku
              title
              price
              compareAtPrice
              inventoryQuantity
              selectedOptions { name value }
              inventoryItem { id }
            }
          }
        }
      }
    }
  }
}`;

// Products upserted per database round trip while importing.
const IMPORT_BATCH_SIZE = 100;

function toSyncedProduct(
  node: ProductFields,
  images: string[],
  variants: VariantNode[],
): SyncedProduct {
  return {
    productId: node.id,
    title: node.title,
    handle: node.handle,
    descriptionHtml: node.descriptionHtml,
    vendor: node.vendor,
    productType: node.productType,
    tags: node.tags,
    images,
    status: node.status,
    shopifyUpdatedAt: node.updatedAt,
    variants: variants.map(toSyncedVariant),
  };
}

function toSyncedVariant(node: VariantNode): SyncedVariant {
  return {
    variantId: node.id,
    sku: node.sku || null,
    title: node.title,
    options: Object.fromEntries(
      node.selectedOptions.map((option) => [option.name, option.value]),
    ),
    price: node.price,
    compareAtPrice: node.compareAtPrice,
    inventoryItemId: node.inventoryItem?.id ?? null,
    availableQty: node.inventoryQuantity ?? 0,
  };
}

export async function getPublishMode(shop: string): Promise<PublishMode> {
  const store = await prisma.shopifyStore.findUnique({
    where: { shop },
    select: { publishMode: true },
  });
  return isPublishMode(store?.publishMode) ? store.publishMode : "selected";
}

/**
 * Upserts products and replaces their variants, in one transaction. One SQL
 * statement covers the whole batch (instead of one query per product), so a
 * large import stays fast even with database latency. `published` is only
 * set on insert, or always in "all" mode; in "selected" mode an existing
 * product keeps the brand's decision.
 */
async function saveProducts(
  shop: string,
  products: SyncedProduct[],
  publishMode: PublishMode,
): Promise<void> {
  if (products.length === 0) return;

  const rows = products.map((product) => ({
    productId: product.productId,
    title: product.title,
    handle: product.handle,
    descriptionHtml: product.descriptionHtml,
    vendor: product.vendor,
    productType: product.productType,
    tags: product.tags,
    images: product.images,
    status: product.status,
    shopifyUpdatedAt: product.shopifyUpdatedAt,
    published: publishMode === "all" && product.status === "ACTIVE",
  }));
  const productIds = products.map((product) => product.productId);
  const variants = products.flatMap((product) =>
    product.variants.map((variant) => ({
      ...variant,
      shop,
      productId: product.productId,
    })),
  );

  await prisma.$transaction([
    prisma.$executeRaw`
      INSERT INTO "shopify_connector"."ShopifyProduct" (
        "shop", "productId", "title", "handle", "descriptionHtml", "vendor",
        "productType", "tags", "images", "status", "published",
        "shopifyUpdatedAt", "syncedAt", "updatedAt"
      )
      SELECT
        ${shop}, r."productId", r."title", r."handle", r."descriptionHtml",
        r."vendor", r."productType",
        ARRAY(SELECT jsonb_array_elements_text(r."tags")),
        r."images", r."status", r."published",
        r."shopifyUpdatedAt"::timestamptz AT TIME ZONE 'UTC',
        now() AT TIME ZONE 'UTC',
        now() AT TIME ZONE 'UTC'
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(
        "productId" text, "title" text, "handle" text, "descriptionHtml" text,
        "vendor" text, "productType" text, "tags" jsonb, "images" jsonb,
        "status" text, "published" boolean, "shopifyUpdatedAt" text
      )
      ON CONFLICT ("shop", "productId") DO UPDATE SET
        "title" = EXCLUDED."title",
        "handle" = EXCLUDED."handle",
        "descriptionHtml" = EXCLUDED."descriptionHtml",
        "vendor" = EXCLUDED."vendor",
        "productType" = EXCLUDED."productType",
        "tags" = EXCLUDED."tags",
        "images" = EXCLUDED."images",
        "status" = EXCLUDED."status",
        "published" = CASE WHEN ${publishMode}::text = 'all'
          THEN EXCLUDED."published"
          ELSE "ShopifyProduct"."published" END,
        "shopifyUpdatedAt" = EXCLUDED."shopifyUpdatedAt",
        "syncedAt" = EXCLUDED."syncedAt",
        "deletedAt" = NULL,
        "updatedAt" = EXCLUDED."updatedAt"
    `,
    prisma.shopifyVariant.deleteMany({
      where: { shop, productId: { in: productIds } },
    }),
    prisma.shopifyVariant.createMany({ data: variants }),
  ]);

  await pushProductsToAeza(shop, productIds);
}

/** Marks products as deleted in Shopify: unpublished and removed from Aeza. */
export async function markProductsDeleted(
  shop: string,
  productIds: string[],
): Promise<void> {
  if (productIds.length === 0) return;
  await prisma.shopifyProduct.updateMany({
    where: { shop, productId: { in: productIds } },
    data: { deletedAt: new Date(), published: false },
  });
  await pushProductsToAeza(shop, productIds);
}

/** Starts a full catalog export. The result arrives via bulk_operations/finish. */
export async function startFullProductSync(
  admin: AdminGraphqlClient,
  shop: string,
): Promise<void> {
  const data = await runAdminQuery<{
    bulkOperationRunQuery: {
      bulkOperation: { id: string; status: string } | null;
      userErrors: Array<{ message: string }>;
    };
  }>(
    admin,
    `#graphql
    mutation StartProductBulkSync($query: String!) {
      bulkOperationRunQuery(query: $query) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }`,
    { query: BULK_PRODUCTS_QUERY },
  );

  const { bulkOperation, userErrors } = data.bulkOperationRunQuery;
  if (userErrors.length > 0 || !bulkOperation) {
    throw new Error(
      `Couldn't start product sync for ${shop}: ${userErrors.map((error) => error.message).join("; ")}`,
    );
  }
  console.log(`[product-sync] started ${bulkOperation.id} for ${shop}`);
}

/**
 * Handles a finished bulk operation: downloads the JSONL export, upserts
 * every product, marks products that no longer exist in Shopify as deleted,
 * and records the sync time.
 */
export async function processBulkOperation(
  admin: AdminGraphqlClient,
  shop: string,
  bulkOperationId: string,
): Promise<void> {
  const data = await runAdminQuery<{
    node: {
      status: string;
      errorCode: string | null;
      url: string | null;
      createdAt: string;
    } | null;
  }>(
    admin,
    `#graphql
    query BulkOperationResult($id: ID!) {
      node(id: $id) {
        ... on BulkOperation { status errorCode url createdAt }
      }
    }`,
    { id: bulkOperationId },
  );

  const operation = data.node;
  if (!operation) throw new Error(`Bulk operation ${bulkOperationId} not found.`);
  if (operation.status !== "COMPLETED") {
    throw new Error(
      `Bulk operation ${bulkOperationId} ended as ${operation.status} (${operation.errorCode ?? "no error code"}).`,
    );
  }

  // No url means the store has no products at all.
  const imported = operation.url ? await importBulkFile(shop, operation.url) : 0;

  // Anything not touched by this export (and not created after it started)
  // was deleted in Shopify while we weren't listening.
  const startedAt = new Date(operation.createdAt);
  const stale = await prisma.shopifyProduct.findMany({
    where: {
      shop,
      deletedAt: null,
      OR: [
        { syncedAt: { lt: startedAt } },
        { syncedAt: null, createdAt: { lt: startedAt } },
      ],
    },
    select: { productId: true },
  });
  await markProductsDeleted(
    shop,
    stale.map((product) => product.productId),
  );

  await prisma.shopifyStore.update({
    where: { shop },
    data: { lastFullSyncAt: new Date() },
  });
  console.log(
    `[product-sync] ${shop}: imported ${imported} products, marked ${stale.length} deleted`,
  );
}

/**
 * Streams the bulk JSONL file. Shopify writes each product line followed by
 * its children (media, variants) carrying `__parentId`, so a product is
 * complete as soon as the next product line starts; memory stays constant.
 */
async function importBulkFile(shop: string, url: string): Promise<number> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Couldn't download bulk result (HTTP ${response.status}).`);
  }

  const publishMode = await getPublishMode(shop);
  let batch: SyncedProduct[] = [];
  let current: SyncedProduct | null = null;
  let imported = 0;

  const flush = async () => {
    await saveProducts(shop, batch, publishMode);
    imported += batch.length;
    batch = [];
  };

  for await (const line of readLines(response.body)) {
    const node = JSON.parse(line) as Record<string, unknown> & {
      __parentId?: string;
    };

    if (!node.__parentId) {
      if (current) batch.push(current);
      if (batch.length >= IMPORT_BATCH_SIZE) await flush();
      current = toSyncedProduct(node as unknown as ProductFields, [], []);
      continue;
    }

    if (!current || node.__parentId !== current.productId) {
      console.warn(`[product-sync] skipped orphan line for ${node.__parentId}`);
      continue;
    }
    if (typeof node.id === "string" && node.id.includes("/ProductVariant/")) {
      current.variants.push(toSyncedVariant(node as unknown as VariantNode));
    } else {
      const image = node.image as { url?: string } | undefined;
      if (image?.url) current.images.push(image.url);
    }
  }

  if (current) batch.push(current);
  await flush();
  return imported;
}

async function* readLines(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = done ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (line.trim()) yield line;
    }
    if (done) return;
  }
}

/**
 * Re-fetches one product (with all its variants) from Shopify and saves it.
 * Used by product webhooks, so we never depend on webhook payload order.
 */
export async function refreshProduct(
  admin: AdminGraphqlClient,
  shop: string,
  productId: string,
): Promise<void> {
  type ProductPage = {
    product:
      | (ProductFields & {
          media: { nodes: Array<{ image?: { url: string } }> };
          variants: {
            nodes: VariantNode[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        })
      | null;
  };

  let product: ProductPage["product"] = null;
  const variants: VariantNode[] = [];
  let after: string | null = null;

  do {
    const data: ProductPage = await runAdminQuery<ProductPage>(
      admin,
      `#graphql
      query RefreshProduct($id: ID!, $variantsAfter: String) {
        product(id: $id) {
          id
          title
          handle
          descriptionHtml
          vendor
          productType
          tags
          status
          updatedAt
          media(first: 50) { nodes { ... on MediaImage { image { url } } } }
          variants(first: 250, after: $variantsAfter) {
            nodes {
              id
              sku
              title
              price
              compareAtPrice
              inventoryQuantity
              selectedOptions { name value }
              inventoryItem { id }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id: productId, variantsAfter: after },
    );

    if (!data.product) {
      await markProductsDeleted(shop, [productId]);
      return;
    }
    product ??= data.product;
    variants.push(...data.product.variants.nodes);
    after = data.product.variants.pageInfo.hasNextPage
      ? data.product.variants.pageInfo.endCursor
      : null;
  } while (after);

  const images = product.media.nodes.flatMap((media) =>
    media.image?.url ? [media.image.url] : [],
  );
  await saveProducts(
    shop,
    [toSyncedProduct(product, images, variants)],
    await getPublishMode(shop),
  );
}

/** Re-reads one inventory item's available quantity and stores it. */
export async function refreshInventoryItem(
  admin: AdminGraphqlClient,
  shop: string,
  inventoryItemId: string,
): Promise<void> {
  const known = await prisma.shopifyVariant.findFirst({
    where: { shop, inventoryItemId },
    select: { productId: true },
  });
  // Not synced yet: the full sync or product webhook will bring it in.
  if (!known) return;

  const data = await runAdminQuery<{
    inventoryItem: {
      variants: { nodes: Array<{ id: string; inventoryQuantity: number | null }> };
    } | null;
  }>(
    admin,
    `#graphql
    query InventoryItemQuantity($id: ID!) {
      inventoryItem(id: $id) {
        variants(first: 1) { nodes { id inventoryQuantity } }
      }
    }`,
    { id: inventoryItemId },
  );

  const variant = data.inventoryItem?.variants.nodes[0];
  if (!variant) return;

  await prisma.shopifyVariant.updateMany({
    where: { shop, variantId: variant.id },
    data: { availableQty: variant.inventoryQuantity ?? 0 },
  });
  await pushProductsToAeza(shop, [known.productId]);
}

/**
 * Switches a store between "all" and "selected". Going to "all" publishes
 * every active product (and unpublishes drafts/archived); going back to
 * "selected" keeps the current choices, which the brand can then edit.
 */
export async function setPublishMode(
  shop: string,
  publishMode: PublishMode,
): Promise<void> {
  await prisma.shopifyStore.update({ where: { shop }, data: { publishMode } });
  if (publishMode !== "all") return;

  const active = { shop, deletedAt: null, status: "ACTIVE" };
  const inactive = {
    shop,
    OR: [{ status: { not: "ACTIVE" } }, { status: null }],
  };

  const changing = await prisma.shopifyProduct.findMany({
    where: {
      OR: [
        { ...active, published: false },
        { ...inactive, published: true },
      ],
    },
    select: { productId: true },
  });

  await prisma.$transaction([
    prisma.shopifyProduct.updateMany({
      where: { ...active, published: false },
      data: { published: true, syncStatus: "recorded", syncError: null },
    }),
    prisma.shopifyProduct.updateMany({
      where: { ...inactive, published: true },
      data: { published: false, syncStatus: "recorded", syncError: null },
    }),
  ]);

  await pushProductsToAeza(
    shop,
    changing.map((product) => product.productId),
  );
}
