-- CreateTable
CREATE TABLE "shopify_connector"."ShopifyStore" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretEnc" TEXT NOT NULL,
    "brandProfileId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "publishMode" TEXT NOT NULL DEFAULT 'selected',
    "installedAt" TIMESTAMP(3),
    "uninstalledAt" TIMESTAMP(3),
    "lastFullSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyStore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyStore_shop_key" ON "shopify_connector"."ShopifyStore"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyStore_clientId_key" ON "shopify_connector"."ShopifyStore"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyStore_brandProfileId_key" ON "shopify_connector"."ShopifyStore"("brandProfileId");

-- AddForeignKey
ALTER TABLE "shopify_connector"."ShopifyStore" ADD CONSTRAINT "ShopifyStore_brandProfileId_fkey" FOREIGN KEY ("brandProfileId") REFERENCES "shopify_connector"."BrandProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
