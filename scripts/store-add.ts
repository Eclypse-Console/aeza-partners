// Registers a brand store and its private Shopify app.
//
//   npm run store:add -- --shop brandx.myshopify.com --client-id <id> \
//     [--brand-name "Brand X"] [--update]
//
// The client secret is never a CLI argument (it would end up in shell
// history): it's read from STORE_CLIENT_SECRET if set, otherwise prompted
// for with hidden input.
//
// Encrypts the client secret and inserts the ShopifyStore row (in whichever
// database DATABASE_URL points at), then writes shopify.app.<slug>.toml from
// shopify.app.template.toml. ENCRYPTION_KEY must match the deployment's key.
// --update replaces the credentials of an existing store (secret rotation).
// The secret is never printed.
//
// Runs on Node's built-in TypeScript support (Node >= 22.18).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";
import { encrypt } from "../app/lib/crypto.server.ts";

const { values } = parseArgs({
  options: {
    shop: { type: "string" },
    "client-id": { type: "string" },
    "brand-name": { type: "string" },
    update: { type: "boolean", default: false },
  },
});

function fail(message: string): never {
  console.error(`store:add: ${message}`);
  process.exit(1);
}

// Reads one line from the terminal without echoing it.
function promptHidden(question: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    fail("no terminal to prompt on; set STORE_CLIENT_SECRET instead");
  }

  return new Promise((resolve) => {
    let input = "";
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          resolve(input);
          return;
        }
        if (char === "\u0003") {
          // Ctrl+C
          stdin.setRawMode(false);
          stdout.write("\n");
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") {
          input = input.slice(0, -1);
        } else {
          input += char;
        }
      }
    };
    stdin.on("data", onData);
  });
}

const shop = values.shop?.trim().toLowerCase() ?? "";
const clientId = values["client-id"]?.trim() ?? "";
const brandName = values["brand-name"]?.trim();

if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
  fail("--shop must look like brandx.myshopify.com");
}
if (!/^[A-Za-z0-9]+$/.test(clientId)) fail("--client-id is required");

const clientSecret = (
  process.env.STORE_CLIENT_SECRET ?? (await promptHidden("Client secret: "))
).trim();
if (!clientSecret) fail("client secret is required");

const slug = shop.replace(/\.myshopify\.com$/, "");
const appName = `Aeza Partner - ${brandName || slug}`;
const tomlPath = `shopify.app.${slug}.toml`;

const prisma = new PrismaClient();

try {
  const existing = await prisma.shopifyStore.findUnique({ where: { shop } });
  if (existing && !values.update) {
    fail(`${shop} is already registered. Pass --update to replace its credentials.`);
  }

  const data = { clientId, clientSecretEnc: encrypt(clientSecret) };
  if (existing) {
    await prisma.shopifyStore.update({ where: { shop }, data });
  } else {
    await prisma.shopifyStore.create({ data: { shop, ...data } });
  }
  console.log(`${existing ? "Updated" : "Registered"} ${shop} (client id ${clientId}).`);

  if (existsSync(tomlPath) && !values.update) {
    console.log(`${tomlPath} already exists, left unchanged.`);
  } else {
    const toml = readFileSync("shopify.app.template.toml", "utf8")
      .replaceAll("{{CLIENT_ID}}", clientId)
      .replaceAll("{{APP_NAME}}", appName.replaceAll('"', ""));
    writeFileSync(tomlPath, toml);
    console.log(`Wrote ${tomlPath}.`);
  }

  console.log(`Next: npx shopify app deploy --config ${slug}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  await prisma.$disconnect();
}
