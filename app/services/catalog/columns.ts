// Column types of the products-shaped tables (legacy products, the ops
// CatalogProduct table and the published catalog_products copy), used to
// write rows with raw SQL: Prisma can't write the vector columns itself.

export type SqlType =
  | "uuid"
  | "text"
  | "text[]"
  | "uuid[]"
  | "jsonb"
  | "numeric"
  | "int"
  | "bool"
  | "timestamp"
  | "timestamptz"
  | "vector";

/** Columns the legacy products table has, in its order. */
export const PRODUCT_COLUMNS: Record<string, SqlType> = {
  id: "uuid",
  variant_id: "uuid",
  sku_id: "text",
  handle: "text",
  title: "text",
  brand_id: "text",
  brand: "text",
  product_category: "text",
  product_type: "text",
  description: "text",
  ai_description: "text",
  tags: "text[]",
  images: "jsonb",
  variants: "jsonb",
  price: "numeric",
  stock: "int",
  gender: "text",
  sizes: "text[]",
  primary_colors: "text[]",
  color_family: "text[]",
  color_hex: "text[]",
  fabric: "text[]",
  fabric_category: "text",
  fit: "text",
  fit_type: "text",
  neckline: "text",
  sleeve_length_type: "text",
  top_length_type: "text",
  skirt_dress_length_type: "text",
  pants_length_type: "text",
  waist_rise: "text",
  outerwear_features: "text[]",
  occasion: "text[]",
  activity: "text[]",
  season: "text[]",
  aesthetic: "text[]",
  trend_alignment: "text",
  luxury_level: "int",
  discounted: "bool",
  pairs_well_with: "text[]",
  avoid_pairing_with: "text[]",
  layering_role: "text",
  breathability: "text[]",
  primary_image: "text",
  embedding_text: "text",
  multimodal_product_embeddings: "vector",
  last_vectorized_at: "timestamp",
  data_version: "text",
  ingested_at: "timestamp",
  created_at: "timestamp",
  updated_at: "timestamp",
  embedding_model: "text",
  embedding_status: "text",
  is_active: "bool",
  deleted_at: "timestamp",
  collection_name: "text",
  min_price: "numeric",
  max_price: "numeric",
  analysis_status: "text",
  ghost_status: "text",
  body_part_tag: "text",
  product_image_siglip_embedding: "vector",
  product_image_siglip_url: "text",
  product_image_siglip_model: "text",
  product_image_siglip_at: "timestamptz",
  base_color: "text[]",
};

/** Catalog-only columns, present in CatalogProduct. */
export const CATALOG_ONLY_COLUMNS: Record<string, SqlType> = {
  shop: "text",
  shopify_product_id: "text",
  color_key: "text",
  source: "text",
  legacy_product_id: "uuid",
  live_on_aeza: "bool",
  is_available: "bool",
  sizes_in_stock: "text[]",
  compare_at_price: "numeric",
  shopify_status: "text",
  shopify_category: "text",
  shopify_tags: "text[]",
  product_info: "text",
  rating: "numeric",
  rating_count: "int",
  linked_product_ids: "text[]",
  online_store_url: "text",
  collections: "jsonb",
  field_sources: "jsonb",
  text_hash: "text",
  image_hash: "text",
  synced_at: "timestamp",
};

/** Extra columns the published catalog_products table adds to the products shape. */
export const PUBLISHED_EXTRA_COLUMNS: Record<string, SqlType> = { ...CATALOG_ONLY_COLUMNS };

export const CATALOG_COLUMNS: Record<string, SqlType> = { ...PRODUCT_COLUMNS, ...CATALOG_ONLY_COLUMNS };

// Not-null columns with defaults in CatalogProduct.
const DEFAULTS: Record<string, unknown> = {
  tags: [],
  images: [],
  variants: [],
  sizes: [],
  primary_colors: [],
  color_family: [],
  color_hex: [],
  fabric: [],
  outerwear_features: [],
  occasion: [],
  activity: [],
  season: [],
  aesthetic: [],
  pairs_well_with: [],
  avoid_pairing_with: [],
  breathability: [],
  base_color: [],
  sizes_in_stock: [],
  shopify_tags: [],
  linked_product_ids: [],
  collections: [],
  field_sources: {},
  analysis_status: "pending",
  ghost_status: "pending",
  is_active: false,
  live_on_aeza: false,
  is_available: false,
  color_key: "",
};

/** Columns to SELECT so vectors come back as text ("[0.1,...]"). */
export function selectList(columns: Record<string, SqlType>, alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return Object.entries(columns)
    .map(([name, type]) => (type === "vector" ? `${prefix}"${name}"::text AS "${name}"` : `${prefix}"${name}"`))
    .join(", ");
}

function toParam(value: unknown, type: SqlType): unknown {
  if (value === undefined || value === null) return null;
  if (type === "jsonb") return JSON.stringify(value);
  if (type === "numeric") return String(value);
  if (type === "timestamp" || type === "timestamptz") return value instanceof Date ? value.toISOString() : String(value);
  if (type === "text" && typeof value !== "string") return String(value);
  return value;
}

/**
 * INSERT ... ON CONFLICT (id) DO UPDATE for many rows of one table, as SQL
 * and parameters for $executeRawUnsafe. Missing not-null values get the
 * table's default. `vectorType` is where pgvector lives in that database
 * (shopify_connector.vector in aeza-ops, public's vector in the products
 * database).
 */
export function upsertSql(
  table: string,
  columns: Record<string, SqlType>,
  rows: Array<Record<string, unknown>>,
  { applyDefaults = true, vectorType = "vector" }: { applyDefaults?: boolean; vectorType?: string } = {},
): { sql: string; params: unknown[] } {
  const cast = (type: SqlType) => (type === "int" ? "integer" : type === "bool" ? "boolean" : type === "vector" ? vectorType : type);
  const names = Object.keys(columns);
  const params: unknown[] = [];
  const tuples = rows.map((row) => {
    const placeholders = names.map((name) => {
      const type = columns[name];
      let value = row[name];
      if ((value === undefined || value === null) && applyDefaults && name in DEFAULTS) value = DEFAULTS[name];
      params.push(toParam(value, type));
      return `$${params.length}::${cast(type)}`;
    });
    return `(${placeholders.join(", ")})`;
  });
  const quoted = names.map((n) => `"${n}"`);
  const updates = names.filter((n) => n !== "id").map((n) => `"${n}" = EXCLUDED."${n}"`);
  return {
    sql: `INSERT INTO ${table} (${quoted.join(", ")}) VALUES ${tuples.join(", ")} ON CONFLICT ("id") DO UPDATE SET ${updates.join(", ")}`,
    params,
  };
}
