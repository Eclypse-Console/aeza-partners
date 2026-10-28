import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";

// Receives WooCommerce webhooks (Nick Domain). WooCommerce signs the raw body
// with the secret we chose when registering the webhook: base64(HMAC-SHA256)
// in X-WC-Webhook-Signature. The product/order payloads are verified and
// acknowledged here; mapping them into our tables is not wired up yet.
export const action = async ({ request }: ActionFunctionArgs) => {
  const secret = process.env.KNITDOMAIN_WOO_WEBHOOK_SECRET;
  if (!secret) return new Response("Not configured", { status: 500 });

  const body = await request.text();
  const expected = createHmac("sha256", secret).update(body).digest();
  const received = Buffer.from(request.headers.get("x-wc-webhook-signature") ?? "", "base64");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return new Response("Invalid signature", { status: 401 });
  }

  // The ping sent on registration is form-encoded, not JSON.
  const topic = request.headers.get("x-wc-webhook-topic") ?? "ping";
  const id = request.headers.get("x-wc-webhook-delivery-id");
  console.log(`[woo webhook] ${topic} delivery=${id} bytes=${body.length}`);

  return new Response(null, { status: 200 });
};
