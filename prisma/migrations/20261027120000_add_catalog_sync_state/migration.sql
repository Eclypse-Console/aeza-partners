-- AlterTable
ALTER TABLE "shopify_connector"."ShopifyStore" ADD COLUMN     "catalogSyncError" TEXT,
ADD COLUMN     "catalogSyncRequestedAt" TIMESTAMP(3),
ADD COLUMN     "catalogSyncingSince" TIMESTAMP(3),
ADD COLUMN     "lastCatalogSyncAt" TIMESTAMP(3),
ADD COLUMN     "legacyBrandId" TEXT,
ADD COLUMN     "legacyBrandName" TEXT;
