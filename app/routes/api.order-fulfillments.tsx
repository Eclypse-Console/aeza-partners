import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { hasValidBearerToken } from "../lib/auth.server";
import { runAdminQuery } from "../models/products.server";
import { normalizeShopDomain, unauthenticated } from "../shopify.server";

// GET /api/order-fulfillments?shop=<shop>&aezaOrderId=<id>, called by the main
// Aeza backend to show tracking and delivery status. Read live from Shopify,
// in the same shape the backend's own fetchOrderFulfillments() returns.
// Auth: Authorization: Bearer <MAIN_BACKEND_API_KEY>.
// 200 { cancelledAt, fulfillments: [...] }, 404 { error: "not_found" } when
// Aeza has no Shopify order for that id (or Shopify no longer has it).

type FulfillmentNode = {
  id: string;
  displayStatus: string | null;
  createdAt: string | null;
  inTransitAt: string | null;
  estimatedDeliveryAt: string | null;
  deliveredAt: string | null;
  trackingInfo: Array<{ company: string | null; number: string | null; url: string | null }> | null;
  events: { nodes: Array<{ status: string; happenedAt: string; message: string | null }> } | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!hasValidBearerToken(request, process.env.MAIN_BACKEND_API_KEY)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const shop = normalizeShopDomain(url.searchParams.get("shop"));
  const aezaOrderId = url.searchParams.get("aezaOrderId") ?? "";
  if (!shop || !aezaOrderId) {
    return Response.json(
      { error: "invalid_request", message: "shop and aezaOrderId are required" },
      { status: 400 },
    );
  }

  const order = await db.shopifyOrder.findUnique({
    where: { shop_aezaOrderId: { shop, aezaOrderId } },
    select: { shopifyOrderId: true },
  });
  if (!order?.shopifyOrderId) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const { admin } = await unauthenticated.admin(shop);
    const data = await runAdminQuery<{
      order: { cancelledAt: string | null; fulfillments: FulfillmentNode[] } | null;
    }>(
      admin,
      `#graphql
      query AezaOrderFulfillments($id: ID!) {
        order(id: $id) {
          cancelledAt
          fulfillments(first: 10) {
            id displayStatus createdAt inTransitAt estimatedDeliveryAt deliveredAt
            trackingInfo { company number url }
            events(first: 50) { nodes { status happenedAt message } }
          }
        }
      }`,
      { id: order.shopifyOrderId },
    );

    if (!data.order) return Response.json({ error: "not_found" }, { status: 404 });

    return Response.json({
      cancelledAt: data.order.cancelledAt,
      fulfillments: data.order.fulfillments.map((f) => ({
        id: f.id,
        displayStatus: f.displayStatus,
        createdAt: f.createdAt,
        inTransitAt: f.inTransitAt,
        estimatedDeliveryAt: f.estimatedDeliveryAt,
        deliveredAt: f.deliveredAt,
        tracking: (f.trackingInfo ?? []).map((t) => ({
          company: t.company ?? null,
          number: t.number ?? null,
          url: t.url ?? null,
        })),
        events: (f.events?.nodes ?? []).map((e) => ({
          status: e.status,
          happenedAt: e.happenedAt,
          message: e.message ?? null,
        })),
      })),
    });
  } catch (error) {
    if (error instanceof Response) {
      return Response.json({ error: "unknown_shop" }, { status: 404 });
    }
    console.error(`Fulfillments lookup failed for ${shop} ${aezaOrderId}:`, error);
    return Response.json({ error: "shopify_unavailable" }, { status: 502 });
  }
};
