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

// Garment nouns that make a title a top/one-piece, so a bottoms word in it is
// only a mention ("shirt with pants"). "dress pants" is still a pant.
const TOP_TITLE_PATTERN =
  /\b(shirts?|t-?shirts?|tees?|tops?|kurtas?|kurtis?|blouses?|jackets?|blazers?|hoodies?|sweatshirts?|tunics?|kaftans?|sarees?|jumpsuits?)\b|\bdress(es)?\b(?!\s+(pants?|trousers?))/i;
const BOTTOM_TITLE_PATTERNS: Array<[RegExp, string]> = [
  [/\bjeans?\b/i, "Jeans"],
  [/\b(shorts|jorts)\b/i, "Shorts"],
  [/\b(pants?|trousers?|joggers?|chinos?|palazzos?|culottes?)\b/i, "Trousers"],
];

/** Categories that a title naming a bottom garment contradicts. */
const TOP_CATEGORIES = new Set([
  "Shirts", "T-Shirts", "Polo Shirts", "Tops", "Tank Tops", "Crop Tops", "Blouses",
  "Kurtas", "Kurtis", "Tunics", "Hoodies & Sweatshirts", "Sweatshirts", "Jackets",
  "Blazers", "Vests & Waistcoats", "Dresses", "Kaftans",
]);

/**
 * "Beige Drawstring Linen Pant" -> "Trousers". Answers only when the title
 * names a bottom garment and no top or set, so it can safely overrule a
 * merchant product type the brand copied from a shirt listing.
 */
export function bottomCategoryFromTitle(title: string | null | undefined): string | null {
  const t = title ?? "";
  if (!t || SET_PATTERN.test(t) || TOP_TITLE_PATTERN.test(t)) return null;
  for (const [pattern, category] of BOTTOM_TITLE_PATTERNS) if (pattern.test(t)) return category;
  return null;
}

/** The bottoms category the title implies when the current category is a top; else null. */
export function titleContradictsCategory(title: string | null | undefined, category: string | null | undefined): string | null {
  const fromTitle = bottomCategoryFromTitle(title);
  if (!fromTitle || !category) return null;
  return TOP_CATEGORIES.has(normalizeCategory(category) ?? category) ? fromTitle : null;
}

// Colour word -> the families it can belong to. Loose on purpose: "sage" is a
// green, "khaki" is a beige or a brown, so near-synonyms never count as a conflict.
const COLOUR_FAMILIES: Record<string, string[]> = {
  black: ["black"], charcoal: ["black", "grey"], onyx: ["black"],
  white: ["white"], ivory: ["white"], cream: ["white"], ecru: ["white"], beige: ["white", "brown"],
  khaki: ["white", "brown", "green"], camel: ["white", "brown"], tan: ["white", "brown"], natural: ["white", "brown"],
  brown: ["brown"], rust: ["brown", "red", "orange"], taupe: ["brown", "grey"], coffee: ["brown"], chocolate: ["brown"],
  grey: ["grey"], gray: ["grey"], silver: ["grey"], smoke: ["grey"], ash: ["grey"],
  navy: ["blue"], blue: ["blue"], teal: ["blue", "green"], turquoise: ["blue", "green"], indigo: ["blue", "purple"],
  denim: ["blue"], azure: ["blue"],
  green: ["green"], olive: ["green", "brown"], sage: ["green", "grey"], mint: ["green"], emerald: ["green"],
  red: ["red"], maroon: ["red", "brown", "purple"], burgundy: ["red", "purple"], wine: ["red", "purple"], crimson: ["red"],
  pink: ["pink"], peach: ["pink", "orange"], coral: ["pink", "orange", "red"], rose: ["pink"], blush: ["pink"], fuchsia: ["pink", "purple"],
  purple: ["purple"], lavender: ["purple"], lilac: ["purple"], mauve: ["purple", "pink"], violet: ["purple"], plum: ["purple"], grape: ["purple"],
  yellow: ["yellow"], mustard: ["yellow", "orange"], gold: ["yellow"], lemon: ["yellow"],
  orange: ["orange"], amber: ["orange", "yellow"],
};

// Words that read as a colour in a title. Excludes words that usually describe
// something else there ("denim", "rose" embroidery, "gold" zari, "smoke").
const TITLE_COLOUR_WORDS = Object.keys(COLOUR_FAMILIES).filter(
  (w) => !["denim", "rose", "gold", "silver", "smoke", "ash", "natural", "wine", "coffee", "chocolate", "lemon", "plum", "amber", "onyx"].includes(w),
);
const TITLE_COLOUR_PATTERN = new RegExp(`\\b(?:off\\s+)?(${TITLE_COLOUR_WORDS.join("|")})\\b`, "gi");

function familiesOf(name: string): Set<string> {
  const out = new Set<string>();
  for (const word of name.toLowerCase().split(/[^a-z]+/)) for (const f of COLOUR_FAMILIES[word] ?? []) out.add(f);
  return out;
}

/**
 * The colour a title names, when it names exactly one colour family
 * ("Midnight Black Classic Shirt" -> Black). Null when it names none, or
 * several that don't share a family ("Black Shirt & White Pant").
 */
export function colourFromTitle(title: string | null | undefined): { name: string; families: Set<string> } | null {
  const matches = [...(title ?? "").matchAll(TITLE_COLOUR_PATTERN)].map((m) => m[0]);
  if (!matches.length) return null;
  let common = familiesOf(matches[0]);
  for (const m of matches.slice(1)) common = new Set([...common].filter((f) => familiesOf(m).has(f)));
  if (!common.size) return null;
  return { name: titleCase(matches[0].toLowerCase().replace(/\s+/g, " ").replace(/\bgray\b/, "grey")), families: common };
}

/**
 * The title's colour, when the brand's colour names clearly contradict it
 * (every name is a recognisable colour and none shares a family with the
 * title's). Null when they agree or either side can't be judged.
 */
export function titleColourOverride(title: string | null | undefined, brandColours: string[]): string | null {
  const fromTitle = colourFromTitle(title);
  if (!fromTitle || !brandColours.length) return null;
  for (const name of brandColours) {
    const fams = familiesOf(name);
    if (!fams.size) return null; // "Deep Taupe"-style names we can't judge
    if ([...fams].some((f) => fromTitle.families.has(f))) return null;
  }
  return fromTitle.name;
}

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

const SIZE_ORDER = ["xxxs", "xxs", "xs", "s", "m", "l", "xl", "xxl", "xxxl", "4xl", "5xl", "free size", "free"];

const JUNK_SIZES = new Set([
  "na", "n/a", "none", "#n/a", "null", "default title", "default", "title",
  "triangle", "square", "custom"
]);
const ONE_SIZE_TOKENS = new Set([
  "one size",
  "one-size",
  "onesize",
  "one size only",
  "os",
  "free size",
  "free-size",
  "freesize",
  "fs",
]);

/** Standardizes size labels (2XL -> XXL, 3XL/3.0XL -> XXXL, 2XS -> XXS, ONE SIZE -> FREE SIZE, junk/prices -> null) */
export function normalizeSizeToken(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const clean = raw.trim();
  const lower = clean.toLowerCase();
  if (!clean || JUNK_SIZES.has(lower)) return null;

  // Filter out price denominations (e.g. ₹500, ₹2,000.00, 2000, 5000, 10000)
  if (/^[₹$€£]|\b\d{4,}\b/.test(clean)) return null;

  let token = clean.toUpperCase();
  token = token.replace(/3\.0XL/g, "XXXL");
  token = token.replace(/(?<!\d)3XL\b/g, "XXXL");
  token = token.replace(/(?<!\d)2XL\b/g, "XXL");
  token = token.replace(/(?<!\d)2XS\b/g, "XXS");

  if (ONE_SIZE_TOKENS.has(lower) || ONE_SIZE_TOKENS.has(token.toLowerCase())) {
    token = "FREE SIZE";
  }
  return token;
}

/**
 * Whether a size may be sold on Aeza under a store's size allowlist
 * (ShopifyStore.allowedSizes). An empty or missing list allows every size.
 * Both sides are normalized, so "2XL", "XXL" and " 2xl" are the same size.
 */
export function sizeAllowed(size: string | null | undefined, allowed: readonly string[] | null | undefined): boolean {
  if (!allowed || allowed.length === 0) return true;
  const token = allowlistToken(size);
  if (!token) return false;
  return allowed.some((entry) => allowlistToken(entry) === token);
}

// Spelled-out sizes some brands use ("Small", "Medium"), only for allowlist matching.
const WORD_SIZES: Record<string, string> = { SMALL: "S", MEDIUM: "M", LARGE: "L", "EXTRA LARGE": "XL", "EXTRA SMALL": "XS" };

function allowlistToken(size: string | null | undefined): string | null {
  const token = normalizeSizeToken(size);
  return token ? WORD_SIZES[token] ?? token : null;
}

/** Standardizes and orders sizes the way a shopper reads them (XS, S, M, L, XL), numbers ascending. */
export function sortSizes(sizes: string[]): string[] {
  const normalizedList: string[] = [];
  for (const s of sizes) {
    const norm = normalizeSizeToken(s);
    if (norm && !normalizedList.includes(norm)) {
      normalizedList.push(norm);
    }
  }

  const rank = (size: string) => {
    const lower = size.trim().toLowerCase();
    const index = SIZE_ORDER.indexOf(lower);
    if (index >= 0) return index;
    const number = Number.parseFloat(lower);
    return Number.isFinite(number) ? 100 + number : 1000;
  };
  return normalizedList.sort((a, b) => rank(a) - rank(b));
}

const CATEGORY_SYNONYMS: Record<string, string> = {
  pants: "Trousers",
  polos: "Polo Shirts",
  tshirts: "T-Shirts",
  "t-shirt": "T-Shirts",
  shirt: "Shirts",
  top: "Tops",
  dress: "Dresses",
  skirt: "Skirts",
  short: "Shorts",
};

/** Normalizes product category to canonical taxonomy (category_mapper.py). */
export function normalizeCategory(category: string | null | undefined): string | null {
  if (!category) return null;
  const clean = category.trim();
  const lower = clean.toLowerCase();
  return CATEGORY_SYNONYMS[lower] ?? clean;
}

/**
 * Enforces category field exclusions per Aeza-Product-Enrichment-System category_field_rules.py
 */
export function applyCategoryFieldExclusions(row: Record<string, any>): void {
  const cat = (row.product_category ?? "").trim().toLowerCase();
  if (!cat) return;

  if (["tops", "top", "shirts", "shirt", "t-shirts", "t-shirt", "polo shirts", "crop tops", "tank tops", "blouses"].includes(cat)) {
    row.skirt_dress_length_type = null;
    row.pants_length_type = null;
    row.waist_rise = null;
  } else if (["bottoms", "pants", "trousers", "jeans", "shorts", "skirts", "skorts", "leggings"].includes(cat)) {
    row.neckline = null;
    row.sleeve_length_type = null;
    row.top_length_type = null;
    row.outerwear_features = [];
    if (["pants", "trousers", "jeans", "shorts", "leggings"].includes(cat)) {
      row.skirt_dress_length_type = null;
    }
  } else if (["dresses", "dress", "gowns"].includes(cat)) {
    row.pants_length_type = null;
    row.top_length_type = null;
  } else if (["outerwear", "jackets", "coats", "blazers"].includes(cat)) {
    row.skirt_dress_length_type = null;
    row.pants_length_type = null;
    row.waist_rise = null;
  } else if (["accessories", "bags", "bracelets", "footwear", "scarves"].includes(cat)) {
    row.neckline = null;
    row.sleeve_length_type = null;
    row.top_length_type = null;
    row.skirt_dress_length_type = null;
    row.pants_length_type = null;
    row.waist_rise = null;
    row.outerwear_features = [];
  }
}

const ACCESSORY_KEYWORDS = [
  "accessories", "accessory", "bags", "bag", "duffle bag", "denim bag",
  "sunglasses", "sunglass", "glasses", "eyewear", "belts", "belt",
  "bracelets", "bracelet", "rings", "ring", "pendants", "pendant",
  "watches", "watch", "chains & necklaces", "chains", "necklace", "necklaces",
  "hats & caps", "hat", "cap", "dupattas", "dupatta", "scarves & bandanas",
  "scarves", "scarf", "jewelry", "jewellery", "keychains", "keychain",
  "earrings", "earring", "bag accessories", "footwear", "shoes",
  "bookmarks", "bookmark", "gift card", "gift cards", "wallets", "wallet",
  "pocket charm", "utility charm"
];
const ACCESSORY_SET = new Set(ACCESSORY_KEYWORDS);

/**
 * Determines whether a product is strictly "Clothing" or "Accessories".
 * Categories like Bags, Sunglasses, Bracelets, Belts, Jewelry, Scarves, Bookmarks, Gift Cards -> Accessories.
 * Everything else -> Clothing.
 */
export function determineProductType(
  category: string | null | undefined,
  rawProductType: string | null | undefined,
  title: string | null | undefined,
): "Clothing" | "Accessories" {
  const cat = (category ?? "").trim().toLowerCase();
  const rawType = (rawProductType ?? "").trim().toLowerCase();
  const t = (title ?? "").trim().toLowerCase();

  if (ACCESSORY_SET.has(cat) || ACCESSORY_SET.has(rawType)) {
    return "Accessories";
  }

  // Check if title or rawType names an accessory, unless the title explicitly describes a clothing item (e.g. jorts with detachable bag)
  const isGarmentTitle = /\b(jorts|shorts|pants|trousers|dress|dresses|jacket|jackets|shirt|shirts|top|tops|skirt|skirts|jeans|hoodie|kaftan|saree|kurta|set|blazer|coat|swimsuit|swimwear|blouse)\b/i.test(t);

  if (!isGarmentTitle) {
    for (const kw of ACCESSORY_KEYWORDS) {
      const re = new RegExp(`\\b${kw}\\b`, "i");
      if (re.test(t) || re.test(rawType)) return "Accessories";
    }
  }

  return "Clothing";
}

const KNOWN_GARMENT_CATEGORIES: Record<string, string> = {
  dress: "Dresses",
  dresses: "Dresses",
  "co-ord set": "Co-ord Sets",
  "co-ord sets": "Co-ord Sets",
  "coord set": "Co-ord Sets",
  "coord sets": "Co-ord Sets",
  coord: "Co-ord Sets",
  coords: "Co-ord Sets",
  sets: "Co-ord Sets",
  jean: "Jeans",
  jeans: "Jeans",
  shirt: "Shirts",
  shirts: "Shirts",
  jacket: "Jackets",
  jackets: "Jackets",
  trouser: "Trousers",
  trousers: "Trousers",
  pant: "Trousers",
  pants: "Trousers",
  bottoms: "Trousers",
  top: "Tops",
  tops: "Tops",
  "top & blouses": "Blouses",
  blouse: "Blouses",
  blouses: "Blouses",
  "t-shirt": "T-Shirts",
  "t-shirts": "T-Shirts",
  tshirt: "T-Shirts",
  tshirts: "T-Shirts",
  tee: "T-Shirts",
  skirt: "Skirts",
  skirts: "Skirts",
  sleepwear: "Co-ord Sets",
  vest: "Vests & Waistcoats",
  vests: "Vests & Waistcoats",
  kaftan: "Kaftans",
  kaftans: "Kaftans",
  hoodie: "Hoodies & Sweatshirts",
  hoodies: "Hoodies & Sweatshirts",
  kurta: "Kurtas",
  kurtas: "Kurtas",
  saree: "Sarees",
  sarees: "Sarees",
  swimwear: "Swimwear",
  bikini: "Bikini Sets",
  activewear: "Activewear",
  jumpsuit: "Jumpsuits",
  jumpsuits: "Jumpsuits",
  overcoats: "Outerwear",
  overlay: "Outerwear",
};

/**
 * Checks if raw merchant productType or title is a valid garment category.
 */
export function categoryFromMerchantType(rawType: string | null | undefined): string | null {
  if (!rawType) return null;
  const lower = rawType.trim().toLowerCase();
  return KNOWN_GARMENT_CATEGORIES[lower] ?? null;
}

