import type { ActionFunctionArgs } from "react-router";
import { hasValidBearerToken } from "../lib/auth.server";
import { normalizeShopDomain, unauthenticated } from "../shopify.server";
import type { ResolveRequestItem } from "../services/catalog-resolve.server";
import { resolveCartItems } from "../services/catalog-resolve.server";

// POST /api/catalog/resolve, called server-to-server by the main Aeza backend
// when it prices a cart and right before payment.
// Auth: Authorization: Bearer <MAIN_BACKEND_API_KEY>.
// Body: { shop, items: [{ handle, size }] } (max 50 items).
// 200: { items: [ResolvedItem], sizes: { [handle]: [{ size, stock }] } }
// 401 unauthorized, 400 invalid_request, 404 unknown_shop,
// 409 store_not_connected, 502 shopify_unavailable.
const MAX_ITEMS = 50;

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  if (!hasValidBearerToken(request, process.env.MAIN_BACKEND_API_KEY)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { shop?: unknown; items?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const shop = normalizeShopDomain(body.shop as string);
  const items = Array.isArray(body.items) ? body.items : null;
  if (
    !shop ||
    !items ||
    items.length === 0 ||
    items.length > MAX_ITEMS ||
    !items.every(
      (item) =>
        item &&
        typeof item.handle === "string" &&
        item.handle.length > 0 &&
        (item.size === null || item.size === undefined || typeof item.size === "string"),
    )
  ) {
    return Response.json(
      {
        error: "invalid_request",
        message: `shop and 1-${MAX_ITEMS} items of { handle, size } are required`,
      },
      { status: 400 },
    );
  }

  let admin;
  try {
    admin = (await unauthenticated.admin(shop)).admin;
  } catch (error) {
    if (error instanceof Response) {
      return Response.json({ error: "unknown_shop" }, { status: 404 });
    }
    console.error(`Resolve: no session for ${shop}:`, error);
    return Response.json({ error: "store_not_connected" }, { status: 409 });
  }

  try {
    const result = await resolveCartItems(
      admin,
      shop,
      (items as ResolveRequestItem[]).map((item) => ({
        handle: item.handle,
        size: item.size ?? null,
      })),
    );
    return Response.json(result);
  } catch (error) {
    console.error(`Resolve failed for ${shop}:`, error);
    return Response.json({ error: "shopify_unavailable" }, { status: 502 });
  }
};
