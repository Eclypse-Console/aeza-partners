import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { forwardOrderEvent } from "../services/backend-events.server";
import {
  markProductsDeleted,
  processBulkOperation,
  refreshInventoryItem,
  refreshProduct,
} from "../services/product-sync.server";
import type { WebhookContext } from "../services/webhooks.server";
import { handleWebhook } from "../services/webhooks.server";

// Receives every catalog and order topic (see shopify.app.template.toml) and
// keeps our tables in sync. Products and stock are always re-fetched from
// Shopify rather than taken from the payload, so out-of-order deliveries
// can't leave stale data behind. Events on orders Aeza created are also
// forwarded to the main Aeza backend, which runs tracking and refunds.

type Payload = Record<string, unknown>;

const gid = (type: string, id: unknown) => `gid://shopify/${type}/${id}`;

async function adminFor(shop: string) {
  return (await unauthenticated.admin(shop)).admin;
}

const handlers: Record<string, (context: WebhookContext) => Promise<void>> = {
  PRODUCTS_CREATE: onProductChanged,
  PRODUCTS_UPDATE: onProductChanged,

  async PRODUCTS_DELETE({ shop, payload }) {
    await markProductsDeleted(shop, [gid("Product", (payload as Payload).id)]);
  },

  async INVENTORY_LEVELS_UPDATE({ shop, payload }) {
    const itemId = (payload as Payload).inventory_item_id;
    await refreshInventoryItem(
      await adminFor(shop),
      shop,
      gid("InventoryItem", itemId),
    );
  },

  ORDERS_UPDATED: onOrderChanged,
  ORDERS_CANCELLED: onOrderChanged,

  FULFILLMENTS_CREATE: onFulfillmentChanged,
  FULFILLMENTS_UPDATE: onFulfillmentChanged,

  // In transit / out for delivery / delivered: nothing to store here, the
  // backend re-reads the delivery timeline from us.
  async FULFILLMENT_EVENTS_CREATE({ shop, topic, webhookId, payload }) {
    const shopifyOrderId = gid("Order", (payload as Payload).order_id);
    const isAezaOrder = await db.shopifyOrder.count({ where: { shop, shopifyOrderId } });
    if (isAezaOrder) {
      await forwardOrderEvent({ topic: shopifyTopic(topic), shop, shopifyOrderId, eventId: webhookId });
    }
  },

  async BULK_OPERATIONS_FINISH({ shop, payload }) {
    const { admin_graphql_api_id: id, type } = payload as Payload;
    // We only run bulk queries (the full product sync).
    if (type !== "query" || typeof id !== "string") return;
    await processBulkOperation(await adminFor(shop), shop, id);
  },
};

async function onProductChanged({ shop, payload }: WebhookContext) {
  const id = (payload as Payload).admin_graphql_api_id;
  if (typeof id !== "string") return;
  await refreshProduct(await adminFor(shop), shop, id);
}

// "ORDERS_CANCELLED" -> "orders/cancelled", the form the backend expects.
function shopifyTopic(topic: string): string {
  const [resource, ...event] = topic.toLowerCase().split("_");
  // Topics whose resource has an underscore (fulfillment_events/create).
  if (resource === "fulfillment" && event[0] === "events") {
    return `fulfillment_events/${event.slice(1).join("_")}`;
  }
  return `${resource}/${event.join("_")}`;
}

// Orders on the brand's store that Aeza didn't create simply match no row.
async function onOrderChanged({ shop, topic, webhookId, payload }: WebhookContext) {
  const order = payload as Payload;
  const shopifyOrderId = String(order.admin_graphql_api_id);
  const updated = await db.shopifyOrder.updateMany({
    where: { shop, shopifyOrderId },
    data: {
      financialStatus: (order.financial_status as string | null) ?? null,
      fulfillmentStatus: (order.fulfillment_status as string | null) ?? null,
      cancelledAt: order.cancelled_at
        ? new Date(order.cancelled_at as string)
        : null,
    },
  });
  if (updated.count === 0) return;

  // The backend acts on cancellations and completed fulfilment; other order
  // edits (notes, tags...) don't concern it.
  if (topic === "ORDERS_CANCELLED") {
    await forwardOrderEvent({ topic: "orders/cancelled", shop, shopifyOrderId, eventId: webhookId });
  } else if (order.fulfillment_status === "fulfilled") {
    await forwardOrderEvent({ topic: "orders/fulfilled", shop, shopifyOrderId, eventId: webhookId });
  }
}

async function onFulfillmentChanged({ shop, topic, webhookId, payload }: WebhookContext) {
  const fulfillment = payload as Payload;
  const shopifyOrderId = gid("Order", fulfillment.order_id);
  const updated = await db.shopifyOrder.updateMany({
    where: { shop, shopifyOrderId },
    data: {
      trackingCompany: (fulfillment.tracking_company as string | null) ?? null,
      trackingNumber: (fulfillment.tracking_number as string | null) ?? null,
      trackingUrl: (fulfillment.tracking_url as string | null) ?? null,
      shipmentStatus: (fulfillment.shipment_status as string | null) ?? null,
    },
  });
  if (updated.count > 0) {
    await forwardOrderEvent({ topic: shopifyTopic(topic), shop, shopifyOrderId, eventId: webhookId });
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  return handleWebhook(request, async (context) => {
    const handler = handlers[context.topic];
    if (!handler) {
      console.warn(`No handler for ${context.topic} webhook`);
      return;
    }
    await handler(context);
  });
};
