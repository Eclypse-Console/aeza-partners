-- CreateTable
CREATE TABLE "shopify_connector"."ShopifyProduct" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT,
    "descriptionHtml" TEXT,
    "vendor" TEXT,
    "productType" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "images" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "shopifyUpdatedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3),
    "syncStatus" TEXT NOT NULL DEFAULT 'idle',
    "syncError" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_connector"."ShopifyVariant" (
    "id" SERIAL NOT NULL,
    "variantId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT,
    "title" TEXT NOT NULL,
    "options" JSONB NOT NULL DEFAULT '{}',
    "price" DECIMAL(12,2) NOT NULL,
    "compareAtPrice" DECIMAL(12,2),
    "inventoryItemId" TEXT,
    "availableQty" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_connector"."ShopifyOrder" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "aezaOrderId" TEXT NOT NULL,
    "shopifyOrderId" TEXT,
    "shopifyOrderName" TEXT,
    "financialStatus" TEXT,
    "fulfillmentStatus" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "trackingCompany" TEXT,
    "trackingNumber" TEXT,
    "trackingUrl" TEXT,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_connector"."WebhookEvent" (
    "webhookId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'received',
    "error" TEXT,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("webhookId")
);

-- CreateIndex
CREATE INDEX "ShopifyProduct_shop_published_idx" ON "shopify_connector"."ShopifyProduct"("shop", "published");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyProduct_shop_productId_key" ON "shopify_connector"."ShopifyProduct"("shop", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyVariant_variantId_key" ON "shopify_connector"."ShopifyVariant"("variantId");

-- CreateIndex
CREATE INDEX "ShopifyVariant_shop_productId_idx" ON "shopify_connector"."ShopifyVariant"("shop", "productId");

-- CreateIndex
CREATE INDEX "ShopifyVariant_inventoryItemId_idx" ON "shopify_connector"."ShopifyVariant"("inventoryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyOrder_shopifyOrderId_key" ON "shopify_connector"."ShopifyOrder"("shopifyOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyOrder_shop_aezaOrderId_key" ON "shopify_connector"."ShopifyOrder"("shop", "aezaOrderId");

-- CreateIndex
CREATE INDEX "WebhookEvent_shop_topic_idx" ON "shopify_connector"."WebhookEvent"("shop", "topic");

-- AddForeignKey
ALTER TABLE "shopify_connector"."ShopifyVariant" ADD CONSTRAINT "ShopifyVariant_shop_productId_fkey" FOREIGN KEY ("shop", "productId") REFERENCES "shopify_connector"."ShopifyProduct"("shop", "productId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Copy the brands' existing publish decisions from the legacy PublishedProduct
-- table. PublishedProduct itself is left untouched (no data is removed).
-- `lastSyncedAt` there recorded the publish decision, not a product sync, so
-- it isn't carried over to `syncedAt`; the first full sync fills the rest.
INSERT INTO "shopify_connector"."ShopifyProduct"
    ("shop", "productId", "title", "images", "published", "syncStatus", "syncError", "updatedAt")
SELECT
    "shop",
    "productId",
    "title",
    CASE WHEN "imageUrl" IS NULL THEN '[]'::jsonb ELSE jsonb_build_array("imageUrl") END,
    "published",
    "syncStatus",
    "syncError",
    "updatedAt"
FROM "shopify_connector"."PublishedProduct"
ON CONFLICT ("shop", "productId") DO NOTHING;
