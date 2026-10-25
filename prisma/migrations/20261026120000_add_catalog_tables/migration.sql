-- pgvector holds the text (1536) and SigLIP image (768) embeddings copied from
-- the legacy products table.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "shopify_connector"."CatalogProduct" (
    "id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "shop" TEXT NOT NULL,
    "shopify_product_id" TEXT,
    "color_key" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL,
    "legacy_product_id" UUID,
    "sku_id" TEXT,
    "handle" TEXT,
    "title" TEXT,
    "brand_id" TEXT,
    "brand" TEXT,
    "product_category" TEXT,
    "product_type" TEXT,
    "description" TEXT,
    "ai_description" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "images" JSONB NOT NULL DEFAULT '[]',
    "variants" JSONB NOT NULL DEFAULT '[]',
    "price" DECIMAL(12,2),
    "stock" INTEGER,
    "gender" TEXT,
    "sizes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "primary_colors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "color_family" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "color_hex" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fabric" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fabric_category" TEXT,
    "fit" TEXT,
    "fit_type" TEXT,
    "neckline" TEXT,
    "sleeve_length_type" TEXT,
    "top_length_type" TEXT,
    "skirt_dress_length_type" TEXT,
    "pants_length_type" TEXT,
    "waist_rise" TEXT,
    "outerwear_features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "occasion" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "activity" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "season" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "aesthetic" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "trend_alignment" TEXT,
    "luxury_level" INTEGER,
    "discounted" BOOLEAN,
    "pairs_well_with" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "avoid_pairing_with" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "layering_role" TEXT,
    "breathability" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "primary_image" TEXT,
    "embedding_text" TEXT,
    "multimodal_product_embeddings" vector(1536),
    "last_vectorized_at" TIMESTAMP(3),
    "data_version" TEXT,
    "ingested_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "embedding_model" TEXT,
    "embedding_status" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),
    "collection_name" TEXT,
    "min_price" DECIMAL(12,2),
    "max_price" DECIMAL(12,2),
    "analysis_status" TEXT NOT NULL DEFAULT 'pending',
    "ghost_status" TEXT NOT NULL DEFAULT 'pending',
    "body_part_tag" TEXT,
    "product_image_siglip_embedding" vector(768),
    "product_image_siglip_url" TEXT,
    "product_image_siglip_model" TEXT,
    "product_image_siglip_at" TIMESTAMPTZ(6),
    "base_color" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "live_on_aeza" BOOLEAN NOT NULL DEFAULT false,
    "is_available" BOOLEAN NOT NULL DEFAULT false,
    "sizes_in_stock" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "compare_at_price" DECIMAL(12,2),
    "shopify_status" TEXT,
    "shopify_category" TEXT,
    "shopify_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "product_info" TEXT,
    "rating" DECIMAL(3,2),
    "rating_count" INTEGER,
    "linked_product_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "online_store_url" TEXT,
    "collections" JSONB NOT NULL DEFAULT '[]',
    "field_sources" JSONB NOT NULL DEFAULT '{}',
    "text_hash" TEXT,
    "image_hash" TEXT,
    "synced_at" TIMESTAMP(3),

    CONSTRAINT "CatalogProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_connector"."CatalogVariant" (
    "variantId" TEXT NOT NULL,
    "catalogProductId" UUID NOT NULL,
    "shop" TEXT NOT NULL,
    "sku" TEXT,
    "size" TEXT,
    "options" JSONB NOT NULL DEFAULT '{}',
    "position" INTEGER,
    "price" DECIMAL(12,2) NOT NULL,
    "compareAtPrice" DECIMAL(12,2),
    "availableQty" INTEGER NOT NULL DEFAULT 0,
    "inventoryPolicy" TEXT,
    "tracked" BOOLEAN NOT NULL DEFAULT true,
    "available" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogVariant_pkey" PRIMARY KEY ("variantId")
);

-- CreateTable
CREATE TABLE "shopify_connector"."CatalogProductLink" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "colorKey" TEXT NOT NULL DEFAULT '',
    "legacyProductId" UUID,
    "duplicateLegacyIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "status" TEXT NOT NULL,
    "method" TEXT,
    "confidence" DOUBLE PRECISION,
    "reason" TEXT,
    "candidates" JSONB NOT NULL DEFAULT '[]',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogProductLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_connector"."MetaobjectValue" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "handle" TEXT,
    "label" TEXT,
    "hex" TEXT,
    "taxonomyId" TEXT,
    "fields" JSONB NOT NULL DEFAULT '{}',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetaobjectValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_connector"."EnrichmentJob" (
    "id" SERIAL NOT NULL,
    "catalogProductId" UUID NOT NULL,
    "step" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'fill',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "inputHash" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnrichmentJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CatalogProduct_shop_live_on_aeza_idx" ON "shopify_connector"."CatalogProduct"("shop", "live_on_aeza");

-- CreateIndex
CREATE INDEX "CatalogProduct_handle_idx" ON "shopify_connector"."CatalogProduct"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogProduct_shop_shopify_product_id_color_key_key" ON "shopify_connector"."CatalogProduct"("shop", "shopify_product_id", "color_key");

-- CreateIndex
CREATE INDEX "CatalogVariant_catalogProductId_idx" ON "shopify_connector"."CatalogVariant"("catalogProductId");

-- CreateIndex
CREATE INDEX "CatalogVariant_shop_sku_idx" ON "shopify_connector"."CatalogVariant"("shop", "sku");

-- CreateIndex
CREATE INDEX "CatalogProductLink_status_idx" ON "shopify_connector"."CatalogProductLink"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogProductLink_shop_shopifyProductId_colorKey_key" ON "shopify_connector"."CatalogProductLink"("shop", "shopifyProductId", "colorKey");

-- CreateIndex
CREATE INDEX "MetaobjectValue_shop_idx" ON "shopify_connector"."MetaobjectValue"("shop");

-- CreateIndex
CREATE INDEX "EnrichmentJob_status_step_idx" ON "shopify_connector"."EnrichmentJob"("status", "step");

-- CreateIndex
CREATE UNIQUE INDEX "EnrichmentJob_catalogProductId_step_key" ON "shopify_connector"."EnrichmentJob"("catalogProductId", "step");

-- AddForeignKey
ALTER TABLE "shopify_connector"."CatalogVariant" ADD CONSTRAINT "CatalogVariant_catalogProductId_fkey" FOREIGN KEY ("catalogProductId") REFERENCES "shopify_connector"."CatalogProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopify_connector"."EnrichmentJob" ADD CONSTRAINT "EnrichmentJob_catalogProductId_fkey" FOREIGN KEY ("catalogProductId") REFERENCES "shopify_connector"."CatalogProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

