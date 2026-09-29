-- CreateTable
CREATE TABLE "shopify_connector"."PublishedProduct" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "imageUrl" TEXT,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "syncStatus" TEXT NOT NULL DEFAULT 'idle',
    "syncError" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublishedProduct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PublishedProduct_shop_idx" ON "shopify_connector"."PublishedProduct"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "PublishedProduct_shop_productId_key" ON "shopify_connector"."PublishedProduct"("shop", "productId");

