import { createHmac } from "node:crypto";

// Forwards Shopify order events (shipped, delivered, cancelled) for orders
// Aeza created to the main Aeza backend, which runs the order pipeline
// (tracking, refunds). The body is signed with HMAC-SHA256 using
// CONNECTOR_EVENTS_SECRET (hex, header X-Aeza-Signature), which the backend
// verifies. Delivery is retried a few times; a final failure throws so the
// WebhookEvent row is marked failed and shows up for follow-up.

export type BackendOrderEvent = {
  /** Shopify topic as the backend knows it, e.g. "orders/cancelled" */
  topic: string;
  shop: string;
  shopifyOrderId: string;
  /** X-Shopify-Webhook-Id of the delivery we're forwarding; the backend's dedupe key */
  eventId: string;
};

const RETRY_DELAYS_MS = [1_000, 3_000, 9_000];

export async function forwardOrderEvent(event: BackendOrderEvent): Promise<void> {
  const url = process.env.BACKEND_EVENTS_URL;
  const secret = process.env.CONNECTOR_EVENTS_SECRET;
  if (!url || !secret) {
    console.warn(
      `[backend-events] not forwarding ${event.topic} for ${event.shop}: BACKEND_EVENTS_URL / CONNECTOR_EVENTS_SECRET not set`,
    );
    return;
  }

  const body = JSON.stringify(event);
  const signature = createHmac("sha256", secret).update(body).digest("hex");

  let lastError = "";
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Aeza-Signature": signature },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
      // 4xx other than 429 won't get better by retrying.
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`Forwarding ${event.topic} to the backend failed: ${lastError}`);
}
