// Helpers shared by the brand:* scripts.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

export function fail(script: string, message: string): never {
  console.error(`${script}: ${message}`);
  process.exit(1);
}

/**
 * A store's permanent *.myshopify.com domain from anything the brand might send:
 * that domain, an alias (aamebyabg.myshopify.com) or their website (shopaame.in).
 * Uses the storefront's public /meta.json. Returns null when it isn't a live store.
 */
export async function resolveShop(
  input: string,
): Promise<{ shop: string; name: string; website: string } | null> {
  const host = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  try {
    const response = await fetch(`https://${host}/meta.json`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const meta = (await response.json()) as {
      name?: string;
      domain?: string;
      myshopify_domain?: string;
    };
    if (!meta.myshopify_domain) return null;
    return {
      shop: meta.myshopify_domain.toLowerCase(),
      name: meta.name ?? "",
      website: meta.domain ?? "",
    };
  } catch {
    return null;
  }
}

export const slugOf = (shop: string) => shop.replace(/\.myshopify\.com$/, "");
export const tomlPathOf = (shop: string) => `shopify.app.${slugOf(shop)}.toml`;

/**
 * Webhook topics Shopify refuses until the app has protected customer data
 * access (it gets it once custom distribution is set, but not always at once).
 */
export const ORDER_TOPICS = [
  "orders/updated",
  "orders/cancelled",
  "fulfillments/create",
  "fulfillments/update",
  "fulfillment_events/create",
];

/** A brand's app config, from shopify.app.template.toml. */
export function renderToml(
  clientId: string,
  appName: string,
  options: { withoutOrderTopics?: boolean } = {},
): string {
  let toml = readFileSync("shopify.app.template.toml", "utf8")
    .replaceAll("{{CLIENT_ID}}", clientId)
    .replaceAll("{{APP_NAME}}", appName.replaceAll('"', ""));
  if (options.withoutOrderTopics) {
    for (const topic of ORDER_TOPICS) {
      toml = toml.replace(new RegExp(`^\\s*"${topic}",\\r?\\n`, "m"), "");
    }
    toml = toml.replace(
      /^# Placeholders:.*$/m,
      (line) =>
        `${line}\n# ORDER WEBHOOKS LEFT OUT: Shopify refused them (no protected customer\n# data access yet). Run npm run brand:deploy again to add them.`,
    );
  }
  return toml;
}

export function tomlValue(toml: string, key: string): string | undefined {
  return toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
}

export const hasOrderTopics = (toml: string) => toml.includes('"orders/updated"');

/**
 * Runs Shopify CLI, showing its output live (it can ask you to log in) and
 * returning it too. Args must already be validated: shell mode is needed for
 * npx on Windows.
 */
export function shopifyCli(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["shopify", ...args], {
      shell: true,
      stdio: ["inherit", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}
