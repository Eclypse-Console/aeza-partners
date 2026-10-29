-- BrandProfile.id (and ShopifyStore.brandProfileId, which references it) are
-- UUIDs. Production was converted by hand, so this only runs where the column
-- is still the old SERIAL integer (fresh or local databases) and is a no-op
-- everywhere else. Existing store -> profile links are not carried over on
-- such databases; they are re-linked when the onboarding form is saved.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'shopify_connector'
        AND table_name = 'BrandProfile'
        AND column_name = 'id') <> 'uuid' THEN
    ALTER TABLE "shopify_connector"."ShopifyStore" DROP CONSTRAINT IF EXISTS "ShopifyStore_brandProfileId_fkey";
    ALTER TABLE "shopify_connector"."ShopifyStore" ALTER COLUMN "brandProfileId" TYPE UUID USING NULL;

    ALTER TABLE "shopify_connector"."BrandProfile" ALTER COLUMN "id" DROP DEFAULT;
    ALTER TABLE "shopify_connector"."BrandProfile" ALTER COLUMN "id" TYPE UUID USING gen_random_uuid();
    ALTER TABLE "shopify_connector"."BrandProfile" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
    DROP SEQUENCE IF EXISTS "shopify_connector"."BrandProfile_id_seq";

    ALTER TABLE "shopify_connector"."ShopifyStore" ADD CONSTRAINT "ShopifyStore_brandProfileId_fkey" FOREIGN KEY ("brandProfileId") REFERENCES "shopify_connector"."BrandProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
