// Shared by the store:* scripts: returns a currently valid Admin API access
// token for one store.
//
// Offline tokens here expire hourly. If the stored one is (nearly) expired,
// this refreshes it exactly like the app does and saves the new token and
// the new refresh token back, encrypted. Saving matters: Shopify rotates the
// refresh token on every refresh, so a refresh that isn't saved would leave
// the app holding a dead refresh token.

import type { PrismaClient } from "@prisma/client";
import { decrypt, encrypt } from "../../app/lib/crypto.server.ts";

// Same margin the app uses before treating a token as expired.
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export async function getAccessToken(
  prisma: PrismaClient,
  shop: string,
): Promise<{ accessToken: string; expires: Date | null }> {
  const session = await prisma.session.findUnique({
    where: { id: `offline_${shop}` },
  });
  if (!session) throw new Error(`no installed session for ${shop}`);

  let accessToken = decrypt(session.accessToken);
  let expires = session.expires;

  if (expires && expires.getTime() - EXPIRY_MARGIN_MS < Date.now()) {
    const store = await prisma.shopifyStore.findUnique({ where: { shop } });
    if (!store || !session.refreshToken) {
      throw new Error("token expired and can't be refreshed");
    }

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
    if (!response.ok) throw new Error(`refresh failed (HTTP ${response.status})`);

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

  return { accessToken, expires };
}
