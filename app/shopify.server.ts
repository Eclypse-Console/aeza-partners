import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  LoginErrorType,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { decrypt } from "./lib/crypto.server";
import { EncryptedSessionStorage } from "./lib/session-storage.server";
import { markStoreConnected } from "./services/store.server";

// Custom distribution: every brand has its own private Shopify app (its own
// client id + secret), all served by this one deployment. Instead of a single
// shopifyApp() built from env, each store's credentials live in the
// ShopifyStore table and we build (and cache) one shopifyApp() per store.
// There is deliberately no fallback to env credentials: a shop that isn't in
// ShopifyStore is rejected.

export const apiVersion = ApiVersion.July26;

// Shared by every app instance. Session ids are "offline_<shop>", and each
// store has exactly one app, so one table serves them all.
const sessionStorage = new EncryptedSessionStorage(
  new PrismaSessionStorage(prisma),
);

function createShopifyApp(clientId: string, clientSecret: string) {
  return shopifyApp({
    apiKey: clientId,
    apiSecretKey: clientSecret,
    apiVersion,
    scopes: process.env.SCOPES?.split(","),
    appUrl: process.env.SHOPIFY_APP_URL || "",
    authPathPrefix: "/auth",
    sessionStorage,
    distribution: AppDistribution.SingleMerchant,
    future: {
      expiringOfflineAccessTokens: true,
    },
    hooks: {
      afterAuth: async ({ session, admin }) => {
        await markStoreConnected(session.shop, admin);
      },
    },
  });
}

export type ShopifyAppInstance = ReturnType<typeof createShopifyApp>;

// Keyed by shop. The cached entry remembers which credentials it was built
// from, so rotating a store's client id/secret takes effect on the next request.
const appCache = new Map<
  string,
  { clientId: string; clientSecretEnc: string; app: ShopifyAppInstance }
>();

const SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function normalizeShopDomain(
  value: string | null | undefined,
): string | null {
  const shop = value?.trim().toLowerCase();
  return shop && SHOP_DOMAIN_PATTERN.test(shop) ? shop : null;
}

/** The shopifyApp() for this store, or null if the shop isn't registered. */
export async function getShopifyForShop(
  shop: string,
): Promise<ShopifyAppInstance | null> {
  const store = await prisma.shopifyStore.findUnique({
    where: { shop },
    select: { clientId: true, clientSecretEnc: true },
  });
  if (!store) return null;

  const cached = appCache.get(shop);
  if (
    cached &&
    cached.clientId === store.clientId &&
    cached.clientSecretEnc === store.clientSecretEnc
  ) {
    return cached.app;
  }

  const app = createShopifyApp(store.clientId, decrypt(store.clientSecretEnc));
  appCache.set(shop, { ...store, app });
  return app;
}

/** The client id (App Bridge apiKey) for a registered store. */
export async function getClientIdForShop(shop: string): Promise<string> {
  const store = await prisma.shopifyStore.findUnique({
    where: { shop },
    select: { clientId: true },
  });
  if (!store) throw unknownShopResponse(shop);
  return store.clientId;
}

/**
 * Works out which shop an embedded admin request is for, so we know which
 * app's secret to verify it with:
 *  - fetch/XHR requests carry the App Bridge session token as a Bearer header,
 *  - document loads carry it as ?id_token=, plus ?shop=.
 * The token is only decoded here, not trusted: the chosen app instance then
 * verifies its signature with that store's secret, so a token for one shop
 * can never authenticate against another shop's app.
 */
function getShopFromAdminRequest(request: Request): string | null {
  const url = new URL(request.url);
  const token =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    url.searchParams.get("id_token");

  const tokenShop = token ? getShopFromSessionToken(token) : null;
  return tokenShop ?? normalizeShopDomain(url.searchParams.get("shop"));
}

function getShopFromSessionToken(token: string): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { dest?: unknown };
    return typeof payload.dest === "string"
      ? normalizeShopDomain(new URL(payload.dest).hostname)
      : null;
  } catch {
    return null;
  }
}

function unknownShopResponse(shop: string | null): Response {
  const message = shop
    ? `The store ${shop} isn't set up for Aeza yet. Please contact the Aeza team.`
    : "Please open Aeza from your Shopify admin.";

  return new Response(
    `<div style="font-family: sans-serif; padding: 2rem;"><h1>Aeza Partner</h1><p>${message}</p></div>`,
    {
      status: shop ? 403 : 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    },
  );
}

async function requireShopifyForShop(
  shop: string | null,
): Promise<ShopifyAppInstance> {
  const app = shop ? await getShopifyForShop(shop) : null;
  if (!app) throw unknownShopResponse(shop);
  return app;
}

// Drop-in replacements for the template's single-instance exports, so route
// code keeps calling authenticate.admin(request) etc. unchanged; each call is
// routed to the requesting store's own app instance.
export const authenticate = {
  admin: async (request: Request) => {
    const app = await requireShopifyForShop(getShopFromAdminRequest(request));
    return app.authenticate.admin(request);
  },
  webhook: async (request: Request) => {
    const shop = normalizeShopDomain(
      request.headers.get("x-shopify-shop-domain"),
    );
    const app = shop ? await getShopifyForShop(shop) : null;
    if (!app) {
      console.warn(`Rejected webhook for unknown shop: ${shop ?? "(missing)"}`);
      throw new Response(undefined, { status: shop ? 404 : 400 });
    }
    return app.authenticate.webhook(request);
  },
};

export const unauthenticated = {
  admin: async (shop: string) => {
    const normalized = normalizeShopDomain(shop);
    const app = await requireShopifyForShop(normalized);
    return app.unauthenticated.admin(normalized!);
  },
};

/** Dev-only manual login (see routes/auth.login). */
export async function login(request: Request) {
  const url = new URL(request.url);
  const rawShop =
    url.searchParams.get("shop") ??
    (request.method === "POST"
      ? String((await request.clone().formData()).get("shop") ?? "")
      : "");
  if (!rawShop) return {};

  const withDomain = rawShop.includes(".")
    ? rawShop.replace(/^https?:\/\//, "").replace(/\/$/, "")
    : `${rawShop}.myshopify.com`;
  const shop = normalizeShopDomain(withDomain);
  const app = shop ? await getShopifyForShop(shop) : null;
  if (!app) return { shop: LoginErrorType.InvalidShop };

  return app.login(request);
}

/** Sets the embedded-app CSP/preload headers for document responses. */
export async function addDocumentResponseHeaders(
  request: Request,
  headers: Headers,
) {
  const shop = normalizeShopDomain(
    new URL(request.url).searchParams.get("shop"),
  );
  const app = shop ? await getShopifyForShop(shop) : null;
  app?.addDocumentResponseHeaders(request, headers);
}
