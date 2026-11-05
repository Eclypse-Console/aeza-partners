-- AlterTable: per-store size allowlist. Empty (the default) = every size, so
-- existing stores are unaffected.
ALTER TABLE "shopify_connector"."ShopifyStore" ADD COLUMN     "allowedSizes" TEXT[] DEFAULT ARRAY[]::TEXT[];
