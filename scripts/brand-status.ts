// Where every brand stands, from our database and their config files.
//
//   npm run brand:status                                   (all brands)
//   npm run brand:status -- --shop brandx.myshopify.com    (one brand)
//
// Read-only. Never prints tokens or secrets.
//
// Runs on Node's built-in TypeScript support (Node >= 22.18).

import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";
import { hasOrderTopics, tomlPathOf } from "./brand-lib.ts";

const { values } = parseArgs({ options: { shop: { type: "string" } } });
const only = values.shop?.trim().toLowerCase();
const prisma = new PrismaClient();
const ago = (d: Date | null | undefined) =>
  d ? `${Math.round((Date.now() - d.getTime()) / 60_000)} min ago` : "never";

try {
  const stores = await prisma.shopifyStore.findMany({
    where: only ? { shop: only } : undefined,
    orderBy: { createdAt: "asc" },
  });
  if (stores.length === 0) console.log(only ? `${only} is not registered.` : "No brands registered.");

  for (const store of stores) {
    const { shop } = store;
    const [session, products, live, variants, lastEvent, failed] = await Promise.all([
      prisma.session.findUnique({
        where: { id: `offline_${shop}` },
        select: { refreshTokenExpires: true, scope: true },
      }),
      prisma.shopifyProduct.count({ where: { shop, deletedAt: null } }),
      prisma.shopifyProduct.count({ where: { shop, deletedAt: null, status: "ACTIVE", published: true } }),
      prisma.shopifyVariant.count({ where: { shop } }),
      prisma.webhookEvent.findFirst({ where: { shop }, orderBy: { receivedAt: "desc" } }),
      prisma.webhookEvent.count({ where: { shop, status: "failed" } }),
    ]);
    const tomlPath = tomlPathOf(shop);
    const toml = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : "";

    // Scopes in the config the brand hasn't approved yet (a write scope covers its read).
    const granted = new Set((session?.scope ?? "").split(",").map((x) => x.trim()));
    const pendingScopes = (toml.match(/^scopes\s*=\s*"([^"]*)"/m)?.[1] ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x && !granted.has(x) && !(x.startsWith("read_") && granted.has(`write_${x.slice(5)}`)));

    const next =
      !toml
        ? "config file missing: run brand:onboard"
        : store.status === "pending"
          ? "waiting for the brand to install (deploy done? link sent?)"
          : store.status === "uninstalled"
            ? "brand uninstalled the app"
            : !hasOrderTopics(toml)
              ? `order webhooks missing: npm run brand:deploy -- --shop ${shop}`
              : session && pendingScopes.length
                ? "deployed new scopes: the brand must open the Aeza app once and approve them"
                : products === 0
                  ? "connected, catalog import still running (or empty store)"
                  : "ready";

    console.log(`
${shop}
  status          ${store.status}${store.installedAt ? ` (installed ${store.installedAt.toISOString().slice(0, 10)})` : ""}
  token           ${session ? `ok, refresh valid until ${session.refreshTokenExpires?.toISOString().slice(0, 10) ?? "?"}` : "none yet"}
  products        ${products} (${live} live on Aeza, mode "${store.publishMode}"), ${variants} variants
  last full sync  ${store.lastFullSyncAt?.toISOString() ?? "never"}
  webhooks        last ${lastEvent ? `${lastEvent.topic} ${ago(lastEvent.receivedAt)}` : "none"}${failed ? `, ${failed} FAILED` : ""}
  order webhooks  ${toml ? (hasOrderTopics(toml) ? "in config" : "NOT in config") : "-"}
  scopes          ${!session ? "-" : pendingScopes.length ? `awaiting approval: ${pendingScopes.join(", ")}` : "all approved"}
  next            ${next}`);
  }
} finally {
  await prisma.$disconnect();
}
