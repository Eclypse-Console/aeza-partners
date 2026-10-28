// Prints a currently valid Admin API access token for one store, for manual
// testing (e.g. Postman). Treat the output like a password: anyone holding it
// can read that store's products and orders until it expires (~1 hour).
//
//   npm run store:token -- --shop brandx.myshopify.com
//
// An expired token is refreshed and saved back first (see
// scripts/lib/access-token.ts).
//
// Runs on Node's built-in TypeScript support (Node >= 22.18).

import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";
import { getAccessToken } from "./lib/access-token.ts";

const { values } = parseArgs({ options: { shop: { type: "string" } } });
const shop = values.shop?.trim().toLowerCase() ?? "";

function fail(message: string): never {
  console.error(`store:token: ${message}`);
  process.exit(1);
}

if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
  fail("--shop must look like brandx.myshopify.com");
}

const prisma = new PrismaClient();

try {
  const { accessToken, expires } = await getAccessToken(prisma, shop).catch(
    (error: Error) => fail(error.message),
  );

  console.error(
    `Access token for ${shop} (valid until ${expires?.toISOString() ?? "no expiry"}). Keep it private:`,
  );
  console.log(accessToken);
} finally {
  await prisma.$disconnect();
}
