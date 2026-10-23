// Prints a currently valid Admin API access token for one store, for manual
// testing (e.g. Postman). Treat the output like a password: anyone holding it
// can read that store's products and orders until it expires (~1 hour).
//
//   npm run store:token -- --shop brandx.myshopify.com
//
// Offline tokens here expire hourly. If the stored one is (nearly) expired,
// this refreshes it exactly like the app does and saves the new token and
// the new refresh token back, encrypted. Saving matters: Shopify rotates the
// refresh token on every refresh, so a refresh that isn't saved would leave
// the app holding a dead refresh token.
//
// Runs on Node's built-in TypeScript support (Node >= 22.18).

import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";
import { decrypt, encrypt } from "../app/lib/crypto.server.ts";

const { values } = parseArgs({ options: { shop: { type: "string" } } });
const shop = values.shop?.trim().toLowerCase() ?? "";

function fail(message: string): never {
  console.error(`store:token: ${message}`);
  process.exit(1);
}

if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
  fail("--shop must look like brandx.myshopify.com");
}

// Same margin the app uses before treating a token as expired.
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const prisma = new PrismaClient();

try {
  const session = await prisma.session.findUnique({
    where: { id: `offline_${shop}` },
  });
  if (!session) fail(`no installed session for ${shop}`);

  let accessToken = decrypt(session.accessToken);
  let expires = session.expires;

  if (expires && expires.getTime() - EXPIRY_MARGIN_MS < Date.now()) {
    const store = await prisma.shopifyStore.findUnique({ where: { shop } });
    if (!store || !session.refreshToken) fail("token expired and can't be refreshed");

    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: store.clientId,
        client_secret: decrypt(store.clientSecretEnc),
        refresh_token: decrypt(session.refreshToken),
        grant_type: "refresh_token",
      }),
    });
    if (!response.ok) fail(`refresh failed (HTTP ${response.status})`);

    const body = (await response.json()) as {
      access_token: string;
      scope: string;
      expires_in: number;
      refresh_token: string;
      refresh_token_expires_in: number;
    };
    const now = Date.now();
    accessToken = body.access_token;
    expires = new Date(now + body.expires_in * 1000);

    await prisma.session.update({
      where: { id: session.id },
      data: {
        accessToken: encrypt(body.access_token),
        scope: body.scope,
        expires,
        refreshToken: encrypt(body.refresh_token),
        refreshTokenExpires: new Date(now + body.refresh_token_expires_in * 1000),
      },
    });
  }

  console.error(
    `Access token for ${shop} (valid until ${expires?.toISOString() ?? "no expiry"}). Keep it private:`,
  );
  console.log(accessToken);
} finally {
  await prisma.$disconnect();
}
