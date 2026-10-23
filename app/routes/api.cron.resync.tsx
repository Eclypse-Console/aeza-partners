import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { hasValidBearerToken } from "../lib/auth.server";
import { unauthenticated } from "../shopify.server";
import { startFullProductSync } from "../services/product-sync.server";

// Nightly safety net (vercel.json cron). Vercel calls this with
// Authorization: Bearer <CRON_SECRET>. Starts a full bulk re-sync for every
// connected store (results arrive via bulk_operations/finish), and prunes
// old webhook dedupe records.
const WEBHOOK_EVENT_RETENTION_DAYS = 30;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!hasValidBearerToken(request, process.env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const stores = await db.shopifyStore.findMany({
    where: { status: "connected" },
    select: { shop: true },
  });

  const failed: string[] = [];
  for (const { shop } of stores) {
    try {
      const { admin } = await unauthenticated.admin(shop);
      await startFullProductSync(admin, shop);
    } catch (error) {
      console.error(`Nightly re-sync failed to start for ${shop}:`, error);
      failed.push(shop);
    }
  }

  const cutoff = new Date(
    Date.now() - WEBHOOK_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const pruned = await db.webhookEvent.deleteMany({
    where: { receivedAt: { lt: cutoff } },
  });

  return Response.json({
    started: stores.length - failed.length,
    failed,
    prunedWebhookEvents: pruned.count,
  });
};
