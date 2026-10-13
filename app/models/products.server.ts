import type { Prisma } from "@prisma/client";
import prisma from "../db.server";

// Loose shape for the authenticated Shopify Admin GraphQL client returned by
// `authenticate.admin(request)`, narrow enough to type-check the calls we
// make here without importing internal SDK types that may shift versions.
type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export type ShopifyProduct = {
  id: string;
  title: string;
  status: string;
  imageUrl: string | null;
  /** Small CDN-resized version of the image, for the dashboard grid. */
  thumbnailUrl: string | null;
};

export type DashboardProduct = ShopifyProduct & {
  published: boolean;
  syncStatus: string;
};

export type ProductPageInfo = {
  hasNextPage: boolean;
  endCursor: string | null;
};

export type ShopifyCollection = {
  id: string;
  title: string;
  productCount: number;
};

export type ProductCounts = {
  /** Products published to Aeza across the whole store. */
  published: number;
  /** Products in the current scope (whole store, or the chosen collection). */
  total: number | null;
};

const PRODUCT_GID_PATTERN = /^gid:\/\/shopify\/Product\/\d+$/;
const COLLECTION_GID_PATTERN = /^gid:\/\/shopify\/Collection\/\d+$/;

// Upper bound on how many products a single bulk action will touch. Keeps one
// request inside serverless time limits and Shopify's API cost budget; the
// caller is told when a catalog is bigger so the brand can run it again.
export const MAX_BULK_PRODUCTS = 2000;

// Products per dashboard page. Small pages keep each Shopify call cheap and
// the first paint fast; more load as the brand scrolls.
export const PRODUCTS_PAGE_SIZE = 20;

// Upper bound on how many individually selected products one Save can carry.
export const MAX_SAVE_CHANGES = 1000;

export function isValidProductGid(value: string): boolean {
  return PRODUCT_GID_PATTERN.test(value);
}

export function isValidCollectionGid(value: string): boolean {
  return COLLECTION_GID_PATTERN.test(value);
}

type GraphqlErrors = Array<{ message: string; extensions?: { code?: string } }>;

function describeErrors(errors: GraphqlErrors, fallback: string): string {
  if (errors.length === 0) return fallback;
  return errors.map((error) => error.message).join("; ");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs an Admin GraphQL query and returns `data`. Retries with a short
 * backoff when Shopify reports the call as THROTTLED (its cost-based rate
 * limit), which bulk actions can hit when paging through large catalogs.
 */
async function runAdminQuery<T>(
  admin: AdminGraphqlClient,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const maxAttempts = 5;

  for (let attempt = 1; ; attempt++) {
    const response = await admin.graphql(query, { variables });
    const body = (await response.json()) as {
      data?: T;
      errors?: GraphqlErrors;
    };

    const throttled = body.errors?.some(
      (error) => error.extensions?.code === "THROTTLED",
    );
    if (throttled && attempt < maxAttempts) {
      await sleep(500 * attempt);
      continue;
    }

    if (body.errors?.length) {
      throw new Error(
        describeErrors(body.errors, "Unknown error from Shopify."),
      );
    }
    if (!body.data) {
      throw new Error("Shopify returned an empty response.");
    }
    return body.data;
  }
}

type ProductNode = {
  id: string;
  title: string;
  status: string;
  featuredImage: { url: string; thumbnailUrl: string } | null;
};

type ProductConnection = {
  nodes: ProductNode[];
  pageInfo: ProductPageInfo;
};

const EMPTY_CONNECTION: ProductConnection = {
  nodes: [],
  pageInfo: { hasNextPage: false, endCursor: null },
};

/**
 * Fetches one page of the shop's products via the Admin GraphQL API, using
 * the already-authenticated admin client (so results are always scoped to
 * whichever shop's session made the request, there is no shop parameter to
 * accidentally trust from a client). Pass `collectionId` to page through a
 * single collection instead of the whole catalog. The whole-catalog view is
 * newest first, so products added in Shopify show up at the top after a sync.
 */
export async function fetchShopifyProducts(
  admin: AdminGraphqlClient,
  {
    first = PRODUCTS_PAGE_SIZE,
    after,
    collectionId,
  }: { first?: number; after?: string | null; collectionId?: string | null } = {},
): Promise<{ products: ShopifyProduct[]; pageInfo: ProductPageInfo }> {
  let connection: ProductConnection;

  if (collectionId) {
    const data = await runAdminQuery<{
      collection: { products: ProductConnection } | null;
    }>(
      admin,
      `#graphql
      query FetchCollectionProducts($id: ID!, $first: Int!, $after: String) {
        collection(id: $id) {
          products(first: $first, after: $after) {
            nodes {
              id
              title
              status
              featuredImage {
                url
                thumbnailUrl: url(transform: { maxWidth: 480, maxHeight: 480 })
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }`,
      { id: collectionId, first, after: after ?? null },
    );
    connection = data.collection?.products ?? EMPTY_CONNECTION;
  } else {
    const data = await runAdminQuery<{ products: ProductConnection }>(
      admin,
      `#graphql
      query FetchProducts($first: Int!, $after: String) {
        products(
          first: $first
          after: $after
          sortKey: CREATED_AT
          reverse: true
        ) {
          nodes {
            id
            title
            status
            featuredImage {
              url
              thumbnailUrl: url(transform: { maxWidth: 480, maxHeight: 480 })
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }`,
      { first, after: after ?? null },
    );
    connection = data.products ?? EMPTY_CONNECTION;
  }

  return {
    products: connection.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      status: node.status,
      imageUrl: node.featuredImage?.url ?? null,
      thumbnailUrl: node.featuredImage?.thumbnailUrl ?? null,
    })),
    pageInfo: connection.pageInfo,
  };
}

// Shopify's `nodes` query accepts at most 250 ids per call.
const NODES_PAGE_SIZE = 250;

/**
 * Fetches specific products by id, using the authenticated admin client.
 * Used when saving a brand's selection so the title/image we store come
 * from Shopify itself, never from whatever the browser sent. Ids that don't
 * resolve to a product on this shop (deleted, or from another store) are
 * simply absent from the result.
 */
export async function fetchShopifyProductsByIds(
  admin: AdminGraphqlClient,
  productIds: string[],
): Promise<ShopifyProduct[]> {
  const products: ShopifyProduct[] = [];

  for (let start = 0; start < productIds.length; start += NODES_PAGE_SIZE) {
    const ids = productIds.slice(start, start + NODES_PAGE_SIZE);
    const data = await runAdminQuery<{
      nodes: Array<Partial<ProductNode> | null>;
    }>(
      admin,
      `#graphql
      query FetchProductsByIds($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            title
            status
            featuredImage {
              url
              thumbnailUrl: url(transform: { maxWidth: 480, maxHeight: 480 })
            }
          }
        }
      }`,
      { ids },
    );

    for (const node of data.nodes) {
      if (!node?.id || !node.title) continue;
      products.push({
        id: node.id,
        title: node.title,
        status: node.status ?? "ACTIVE",
        imageUrl: node.featuredImage?.url ?? null,
        thumbnailUrl: node.featuredImage?.thumbnailUrl ?? null,
      });
    }
  }

  return products;
}

/**
 * The shop's collections (name + product count), for the dashboard's filter
 * dropdown. Capped at 100, plenty for the filter; empty collections are
 * dropped because there is nothing to show or publish in them.
 */
export async function fetchCollections(
  admin: AdminGraphqlClient,
): Promise<ShopifyCollection[]> {
  const data = await runAdminQuery<{
    collections: {
      nodes: Array<{
        id: string;
        title: string;
        productsCount: { count: number } | null;
      }>;
    };
  }>(
    admin,
    `#graphql
    query FetchCollections {
      collections(first: 100, sortKey: TITLE) {
        nodes {
          id
          title
          productsCount {
            count
          }
        }
      }
    }`,
    {},
  );

  return data.collections.nodes
    .map((node) => ({
      id: node.id,
      title: node.title,
      productCount: node.productsCount?.count ?? 0,
    }))
    .filter((collection) => collection.productCount > 0);
}

/**
 * Counts for the dashboard header: how many products this shop has published
 * to Aeza (from our DB), and how many products exist in the current scope
 * (from Shopify). The Shopify half is best-effort, if it fails the total
 * comes back `null` and the UI simply omits it rather than erroring.
 */
export async function getProductCounts(
  admin: AdminGraphqlClient,
  shop: string,
  collectionId?: string | null,
): Promise<ProductCounts> {
  const publishedPromise = prisma.publishedProduct.count({
    where: { shop, published: true },
  });

  const totalPromise: Promise<number | null> = (async () => {
    try {
      if (collectionId) {
        const data = await runAdminQuery<{
          collection: { productsCount: { count: number } | null } | null;
        }>(
          admin,
          `#graphql
          query CollectionProductCount($id: ID!) {
            collection(id: $id) {
              productsCount {
                count
              }
            }
          }`,
          { id: collectionId },
        );
        return data.collection?.productsCount?.count ?? null;
      }
      const data = await runAdminQuery<{
        productsCount: { count: number } | null;
      }>(
        admin,
        `#graphql
        query ProductCount {
          productsCount {
            count
          }
        }`,
        {},
      );
      return data.productsCount?.count ?? null;
    } catch (error) {
      console.error("Failed to load product count:", error);
      return null;
    }
  })();

  const [published, total] = await Promise.all([publishedPromise, totalPromise]);
  return { published, total };
}

/**
 * Merges live Shopify product data with this shop's stored publish
 * decisions. Products with no stored row default to "not published",
 * publishing is always an explicit, brand-driven choice, never an
 * auto-opt-in.
 */
export async function mergeWithPublishState(
  shop: string,
  products: ShopifyProduct[],
): Promise<DashboardProduct[]> {
  const productIds = products.map((product) => product.id);

  const publishedRows = productIds.length
    ? await prisma.publishedProduct.findMany({
        where: { shop, productId: { in: productIds } },
      })
    : [];

  const byProductId = new Map(
    publishedRows.map((row) => [row.productId, row]),
  );

  return products.map((product) => {
    const row = byProductId.get(product.id);
    return {
      ...product,
      published: row?.published ?? false,
      syncStatus: row?.syncStatus ?? "idle",
    };
  });
}

/**
 * Records a brand's saved selection: each product is set to the publish state
 * the brand chose for it, all in one transaction. Always scoped by `shop`
 * from the authenticated session, callers must never pass a shop value
 * sourced from client input, and `products` must come from Shopify (see
 * fetchShopifyProductsByIds). Products already in the requested state are
 * left untouched, and unpublishing never creates rows (a product with no row
 * is already "not published"). Returns how many products actually changed
 * each way, plus the shop's new published total for the dashboard header.
 */
export async function saveProductSelections({
  shop,
  changes,
}: {
  shop: string;
  changes: Array<{ product: ShopifyProduct; published: boolean }>;
}): Promise<{ published: number; unpublished: number; publishedTotal: number }> {
  const ids = changes.map(({ product }) => product.id);
  const existing = ids.length
    ? await prisma.publishedProduct.findMany({
        where: { shop, productId: { in: ids } },
        select: { productId: true, published: true },
      })
    : [];
  const existingById = new Map(
    existing.map((row) => [row.productId, row.published]),
  );

  const toPublish: string[] = [];
  const toUnpublish: string[] = [];
  const toCreate: ShopifyProduct[] = [];

  for (const { product, published } of changes) {
    const current = existingById.get(product.id);
    if (current === undefined) {
      if (published) toCreate.push(product);
    } else if (current !== published) {
      (published ? toPublish : toUnpublish).push(product.id);
    }
  }

  const now = new Date();
  const recorded = {
    syncStatus: "recorded",
    syncError: null,
    lastSyncedAt: now,
  };
  const operations: Prisma.PrismaPromise<Prisma.BatchPayload>[] = [];

  if (toPublish.length > 0) {
    operations.push(
      prisma.publishedProduct.updateMany({
        where: { shop, productId: { in: toPublish } },
        data: { published: true, ...recorded },
      }),
    );
  }
  if (toUnpublish.length > 0) {
    operations.push(
      prisma.publishedProduct.updateMany({
        where: { shop, productId: { in: toUnpublish } },
        data: { published: false, ...recorded },
      }),
    );
  }
  if (toCreate.length > 0) {
    operations.push(
      prisma.publishedProduct.createMany({
        data: toCreate.map((product) => ({
          shop,
          productId: product.id,
          title: product.title,
          imageUrl: product.imageUrl,
          published: true,
          syncStatus: "recorded",
          lastSyncedAt: now,
        })),
        skipDuplicates: true,
      }),
    );
  }

  if (operations.length > 0) {
    await prisma.$transaction(operations);
  }

  const publishedTotal = await prisma.publishedProduct.count({
    where: { shop, published: true },
  });

  return {
    published: toPublish.length + toCreate.length,
    unpublished: toUnpublish.length,
    publishedTotal,
  };
}

// Applies one page of products to the publish table in a single transaction:
// rows that already exist are flipped (only if they actually change), and
// products Aeza hasn't seen yet are inserted. Unpublishing never creates
// rows, a product with no row is already "not published".
async function applyPublishStateToPage(
  shop: string,
  products: ShopifyProduct[],
  published: boolean,
): Promise<number> {
  if (products.length === 0) return 0;

  const ids = products.map((product) => product.id);
  const existing = await prisma.publishedProduct.findMany({
    where: { shop, productId: { in: ids } },
    select: { productId: true },
  });
  const existingIds = new Set(existing.map((row) => row.productId));
  const now = new Date();

  const operations: Prisma.PrismaPromise<Prisma.BatchPayload>[] = [];

  if (existingIds.size > 0) {
    operations.push(
      prisma.publishedProduct.updateMany({
        where: {
          shop,
          productId: { in: [...existingIds] },
          published: !published,
        },
        data: {
          published,
          syncStatus: "recorded",
          syncError: null,
          lastSyncedAt: now,
        },
      }),
    );
  }

  if (published) {
    const missing = products.filter((product) => !existingIds.has(product.id));
    if (missing.length > 0) {
      operations.push(
        prisma.publishedProduct.createMany({
          data: missing.map((product) => ({
            shop,
            productId: product.id,
            title: product.title,
            imageUrl: product.imageUrl,
            published: true,
            syncStatus: "recorded",
            lastSyncedAt: now,
          })),
          skipDuplicates: true,
        }),
      );
    }
  }

  const results = await prisma.$transaction(operations);
  return results.reduce((sum, result) => sum + result.count, 0);
}

/**
 * Publishes or unpublishes many products at once, either the whole store or
 * everything in one collection. Always scoped by `shop` from the
 * authenticated session. Returns how many products actually changed, and
 * whether the catalog was larger than MAX_BULK_PRODUCTS (so the brand can
 * run it again for the rest).
 */
export async function bulkSetPublishState({
  admin,
  shop,
  published,
  collectionId,
  after: startAfter,
}: {
  admin: AdminGraphqlClient;
  shop: string;
  published: boolean;
  collectionId?: string | null;
  /** Resume from this Shopify cursor (returned as `nextCursor` by a run that hit the limit). */
  after?: string | null;
}): Promise<{
  affected: number;
  truncated: boolean;
  nextCursor: string | null;
}> {
  // Fast path: "unpublish everything" is purely a DB update, no need to
  // page through Shopify at all (only when starting fresh, not resuming).
  if (!published && !collectionId && !startAfter) {
    const result = await prisma.publishedProduct.updateMany({
      where: { shop, published: true },
      data: {
        published: false,
        syncStatus: "recorded",
        syncError: null,
        lastSyncedAt: new Date(),
      },
    });
    return { affected: result.count, truncated: false, nextCursor: null };
  }

  let after: string | null = startAfter ?? null;
  let processed = 0;
  let affected = 0;

  for (;;) {
    const page = await fetchShopifyProducts(admin, {
      first: 100,
      after,
      collectionId,
    });

    affected += await applyPublishStateToPage(shop, page.products, published);
    processed += page.products.length;

    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;

    // Pages are whole, so stopping here means every product up to `after`
    // has been handled and a follow-up run can pick up exactly from it.
    if (processed >= MAX_BULK_PRODUCTS) {
      return { affected, truncated: true, nextCursor: after };
    }
  }

  return { affected, truncated: false, nextCursor: null };
}
