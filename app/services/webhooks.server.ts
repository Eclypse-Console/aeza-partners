import { Prisma } from "@prisma/client";
import { waitUntil } from "@vercel/functions";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export type WebhookContext = Awaited<ReturnType<typeof authenticate.webhook>>;

/**
 * The one pattern every webhook route uses:
 *   1. verify HMAC with the store's own app secret (authenticate.webhook),
 *   2. record the delivery in WebhookEvent; if this X-Shopify-Webhook-Id was
 *      already recorded, it's a redelivery: return 200 and do nothing,
 *   3. return 200 straight away (Shopify expects an answer within seconds)
 *      and do the work in the background with waitUntil, which keeps the
 *      Vercel function alive until it finishes,
 *   4. mark the event done, or failed with the error.
 * Failed events are not retried by Shopify (it already got a 200); the
 * nightly full re-sync repairs any product data a failure left stale.
 */
export async function handleWebhook(
  request: Request,
  handler: (context: WebhookContext) => Promise<void>,
): Promise<Response> {
  const context = await authenticate.webhook(request);
  const { shop, topic, webhookId } = context;

  try {
    await prisma.webhookEvent.create({ data: { webhookId, shop, topic } });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      console.log(`Duplicate ${topic} webhook ${webhookId} for ${shop}, skipped`);
      return new Response();
    }
    throw error;
  }

  waitUntil(runHandler(context, handler));
  return new Response();
}

async function runHandler(
  context: WebhookContext,
  handler: (context: WebhookContext) => Promise<void>,
): Promise<void> {
  const { webhookId, topic, shop } = context;
  try {
    await handler(context);
    await prisma.webhookEvent.updateMany({
      where: { webhookId },
      data: { status: "done", processedAt: new Date() },
    });
  } catch (error) {
    console.error(`${topic} webhook ${webhookId} for ${shop} failed:`, error);
    await prisma.webhookEvent
      .updateMany({
        where: { webhookId },
        data: {
          status: "failed",
          processedAt: new Date(),
          error: (error instanceof Error ? error.message : String(error)).slice(
            0,
            2000,
          ),
        },
      })
      .catch((updateError) =>
        console.error("Couldn't record webhook failure:", updateError),
      );
  }
}
