import prisma from "../db.server";

// Loose shape for the authenticated Shopify Admin GraphQL client returned by
// `authenticate.admin(request)` — narrow enough to type-check the calls we
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
};

export type ProductPageInfo = {
  hasNextPage: boolean;
  endCursor: string | null;
};

const PRODUCT_GID_PATTERN = /^gid:\/\/shopify\/Product\/\d+$/;

export function isValidProductGid(value: string): boolean {
  return PRODUCT_GID_PATTERN.test(value);
}

function collectGraphqlErrorMessage(
  errors: Array<{ message: string }> | undefined,
  fallback: string,
): string {
  if (!errors || errors.length === 0) return fallback;
  return errors.map((error) => error.message).join("; ");
}

/**
 * Fetches one page of the shop's products via the Admin GraphQL API, using
 * the already-authenticated admin client (so results are always scoped to
 * whichever shop's session made the request — there is no shop parameter to
 * accidentally trust from a client).
 */
export async function fetchShopifyProducts(
  admin: AdminGraphqlClient,
  { first = 25, after }: { first?: number; after?: string | null } = {},
): Promise<{ products: ShopifyProduct[]; pageInfo: ProductPageInfo }> {
  const response = await admin.graphql(
    `#graphql
    query FetchProducts($first: Int!, $after: String) {
      products(first: $first, after: $after) {
        edges {
          node {
            id
            title
            status
            featuredImage {
              url
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }`,
    { variables: { first, after: after ?? null } },
  );

  const body = (await response.json()) as {
    data?: {
      products?: {
        edges: Array<{
          node: {
            id: string;
            title: string;
            status: string;
            featuredImage: { url: string } | null;
          };
        }>;
        pageInfo: ProductPageInfo;
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (body.errors?.length) {
    throw new Error(
      collectGraphqlErrorMessage(
        body.errors,
        "Unknown error fetching products from Shopify.",
      ),
    );
  }

  const edges = body.data?.products?.edges ?? [];

  return {
    products: edges.map((edge) => ({
      id: edge.node.id,
      title: edge.node.title,
      status: edge.node.status,
      imageUrl: edge.node.featuredImage?.url ?? null,
    })),
    pageInfo: body.data?.products?.pageInfo ?? {
      hasNextPage: false,
      endCursor: null,
    },
  };
}

/**
 * Re-fetches a single product by id, straight from Shopify, using the
 * authenticated admin client. Used to verify a product before recording a
 * publish-state change — the Admin API is scoped to the authenticated shop,
 * so a forged id belonging to a different store simply resolves to `null`
 * rather than leaking another shop's product.
 */
export async function fetchShopifyProductById(
  admin: AdminGraphqlClient,
  productId: string,
): Promise<{ id: string; title: string; imageUrl: string | null } | null> {
  const response = await admin.graphql(
    `#graphql
    query FetchProduct($id: ID!) {
      product(id: $id) {
        id
        title
        featuredImage {
          url
        }
      }
    }`,
    { variables: { id: productId } },
  );

  const body = (await response.json()) as {
    data?: {
      product: {
        id: string;
        title: string;
        featuredImage: { url: string } | null;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };

  if (body.errors?.length) {
    throw new Error(
      collectGraphqlErrorMessage(
        body.errors,
        "Unknown error fetching product from Shopify.",
      ),
    );
  }

  const product = body.data?.product;
  if (!product) return null;

  return {
    id: product.id,
    title: product.title,
    imageUrl: product.featuredImage?.url ?? null,
  };
}

/**
 * Merges live Shopify product data with this shop's stored publish
 * decisions. Products with no stored row default to "not published" —
 * publishing is always an explicit, brand-driven choice, never an
 * auto-opt-in.
 */
export async function mergeWithPublishState(
  shop: string,
  products: ShopifyProduct[],
): Promise<Array<ShopifyProduct & { published: boolean; syncStatus: string }>> {
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
 * Records (or clears) a brand's decision to publish a product to Aeza.
 * Always scoped by `shop` from the authenticated session — callers must
 * never pass a shop value sourced from client input.
 */
export async function setProductPublishState({
  shop,
  productId,
  title,
  imageUrl,
  published,
}: {
  shop: string;
  productId: string;
  title: string;
  imageUrl: string | null;
  published: boolean;
}) {
  return prisma.publishedProduct.upsert({
    where: { shop_productId: { shop, productId } },
    update: {
      title,
      imageUrl,
      published,
      syncStatus: "recorded",
      syncError: null,
      lastSyncedAt: new Date(),
    },
    create: {
      shop,
      productId,
      title,
      imageUrl,
      published,
      syncStatus: "recorded",
      lastSyncedAt: new Date(),
    },
  });
}
