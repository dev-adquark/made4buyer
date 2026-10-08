-- Every image slot shows a relevant image (lib/pipeline/images.ts). Additive and idempotent.
--
-- 1. Exact product photos from the brand's official product page / an identity-matched retailer page
--    are stored as review heroes with their own source types.
ALTER TYPE "image_source_type" ADD VALUE IF NOT EXISTS 'OFFICIAL_SITE';
ALTER TYPE "image_source_type" ADD VALUE IF NOT EXISTS 'RETAILER_SITE';

-- 2. Provenance: how an image was matched to its product.
ALTER TABLE "image_assets" ADD COLUMN IF NOT EXISTS "matchBasis" TEXT;

-- 3. An on-topic Pexels photo may be the primary image of several articles once every unused
--    on-topic photo is taken (an unused photo is still preferred). The unique partial index is
--    replaced by a non-unique one with the same shape.
DROP INDEX IF EXISTS "image_assets_primary_photo_unique";
CREATE INDEX IF NOT EXISTS "image_assets_primary_photo_idx" ON "image_assets"("providerPhotoId") WHERE "isPrimary" AND "providerPhotoId" IS NOT NULL;
