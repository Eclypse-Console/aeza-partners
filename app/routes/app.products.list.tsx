import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { fetchShopifyProducts, mergeWithPublishState } from "../models/products.server";

// Resource route (no UI) — GET only. Returns the next page of the shop's
// products merged with this shop's stored publish decisions, for the
// dashboard's "Load more" button. Pagination lives here instead of loading
// every product up front, so a brand with a large catalog doesn't pay for
// one huge Admin API call (and one slow, over-limit GraphQL request) on
// every page load.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const after = url.searchParams.get("after");

  try {
    const { products, pageInfo } = await fetchShopifyProducts(admin, {
      after,
    });
    const merged = await mergeWithPublishState(session.shop, products);

    return Response.json({ products: merged, pageInfo, error: null });
  } catch (error) {
    console.error("Failed to load product page:", error);
    return Response.json(
      {
        products: [],
        pageInfo: { hasNextPage: false, endCursor: null },
        error: "Couldn't load more products. Try again.",
      },
      { status: 502 },
    );
  }
};
