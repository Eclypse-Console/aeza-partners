// Turns Shopify attribute labels and messy legacy values into the vocabulary
// the legacy products table and the Fashion Assistant use: lowercase,
// hyphenated values ("v-neck", "spaghetti-strap", "wide-leg"), several values
// in one text column joined with "; ", colours in Title Case.

const MULTI_SEPARATOR = "; ";

/** "Spaghetti strap" -> "spaghetti-strap", "V neck" -> "v-neck". */
export function slugValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Splits a legacy scalar that may hold several values: "square; halter",
 * "square, halter" or a Postgres array literal stored as text
 * ('{"crew neck","round neck"}').
 */
export function splitLegacyMulti(value: string | null | undefined): string[] {
  if (!value) return [];
  let text = value.trim();
  if (text.startsWith("{") && text.endsWith("}")) {
    text = text.slice(1, -1);
    return text
      .split(",")
      .map((part) => part.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
  }
  return text
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

const NECKLINE_ALIASES: Record<string, string> = {
  "crew-neck": "crew",
  "round-neck": "round",
  "v-neckline": "v-neck",
  collar: "collared",
  "collared-neck": "collared",
};

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** Normalises a multi-valued scalar column (neckline, sleeve length, ...). */
export function normalizeMultiScalar(
  values: string[],
  aliases: Record<string, string> = {},
): string | null {
  const slugs = dedupe(values.map(slugValue).map((v) => aliases[v] ?? v));
  return slugs.length ? slugs.join(MULTI_SEPARATOR) : null;
}

export function normalizeNeckline(values: string[]): string | null {
  return normalizeMultiScalar(values, NECKLINE_ALIASES);
}

/** Cleans a legacy multi-valued scalar in place (array literals, "," vs ";"). */
export function cleanLegacyScalar(
  value: string | null | undefined,
  field?: string,
): string | null {
  const parts = splitLegacyMulti(value);
  if (!parts.length) return null;
  return field === "neckline" ? normalizeNeckline(parts) : normalizeMultiScalar(parts);
}

const FABRIC_ALIASES: Record<string, string> = {
  "poly cotton": "poly-cotton",
  polycotton: "poly-cotton",
  "poly-cotton blend": "poly-cotton",
};

export function normalizeFabric(values: string[]): string[] {
  return dedupe(
    values.map((value) => {
      const lower = value.trim().toLowerCase().replace(/\s+/g, " ");
      return FABRIC_ALIASES[lower] ?? lower;
    }),
  );
}

export function titleCase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/(^|[\s/-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

const GENDER_MAP: Record<string, string> = {
  female: "women",
  women: "women",
  woman: "women",
  male: "men",
  men: "men",
  man: "men",
  unisex: "unisex",
  girls: "kids",
  boys: "kids",
  kids: "kids",
};

/** Shopify target-gender labels -> the set of Aeza genders they allow. */
export function genderSet(labels: string[]): Set<string> {
  return new Set(
    labels.map((label) => GENDER_MAP[label.trim().toLowerCase()]).filter(Boolean),
  );
}

/**
 * Picks one gender. The brand's labels limit the choice; an existing value
 * inside that set wins (it was chosen with more context), otherwise the most
 * specific label does.
 */
export function chooseGender(labels: string[], existing: string | null): string | null {
  const allowed = genderSet(labels);
  if (!allowed.size) return existing;
  if (existing && allowed.has(existing)) return existing;
  if (allowed.size === 1) return [...allowed][0];
  if (allowed.has("women") && allowed.has("men")) return "unisex";
  if (allowed.has("women")) return "women";
  if (allowed.has("men")) return "men";
  return [...allowed][0];
}

// Shopify's "fit" attribute describes the cut (Straight leg, Wide), which the
// legacy table keeps in fit_type; `fit` itself is the body fit enum.
const FIT_TYPE_MAP: Record<string, string> = {
  "straight-leg": "straight",
  straight: "straight",
  wide: "wide-leg",
  "wide-leg": "wide-leg",
};

export function normalizeFitType(labels: string[]): string | null {
  const values = dedupe(labels.map(slugValue).map((v) => FIT_TYPE_MAP[v] ?? v));
  return values.length ? values.join(MULTI_SEPARATOR) : null;
}

const SET_PATTERN = /\bco-?\s?ord\b|\bcoord\b|\bset\b/i;

/**
 * Category for a product without a legacy one. Shopify files co-ord sets
 * under "Trousers", so a title or product type that says "set" wins. Only
 * categories the catalog already uses are accepted; anything else is left for
 * the AI step.
 */
export function categoryFromShopify(
  shopifyCategory: string | null,
  title: string | null,
  productType: string | null,
  knownCategories: ReadonlySet<string>,
): string | null {
  if (SET_PATTERN.test(title ?? "") || SET_PATTERN.test(productType ?? "")) {
    return knownCategories.has("Co-ord Sets") ? "Co-ord Sets" : null;
  }
  if (shopifyCategory && knownCategories.has(shopifyCategory)) return shopifyCategory;
  return null;
}

/** Image URL without Shopify's ?v= cache-buster, for change detection. */
export function imageIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    return parsed.toString();
  } catch {
    return url.split("?")[0];
  }
}

const SIZE_ORDER = ["xxxs", "xxs", "xs", "s", "m", "l", "xl", "xxl", "2xl", "xxxl", "3xl", "4xl", "5xl", "free size", "free"];

/** Orders sizes the way a shopper reads them (XS, S, M, L, XL), numbers ascending. */
export function sortSizes(sizes: string[]): string[] {
  const rank = (size: string) => {
    const lower = size.trim().toLowerCase();
    const index = SIZE_ORDER.indexOf(lower);
    if (index >= 0) return index;
    const number = Number.parseFloat(lower);
    return Number.isFinite(number) ? 100 + number : 1000;
  };
  return [...sizes].sort((a, b) => rank(a) - rank(b));
}
