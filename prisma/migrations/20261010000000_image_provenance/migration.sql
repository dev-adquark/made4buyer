-- Image provenance: what a stored image actually shows and how we know. An exact-product photo
-- comes only from a licensed source (Wikimedia Commons via Wikidata P18); otherwise a single-product
-- page gets a neutral category image. Additive and idempotent.

ALTER TYPE "image_source_type" ADD VALUE IF NOT EXISTS 'WIKIMEDIA_COMMONS';

ALTER TABLE "image_assets" ADD COLUMN IF NOT EXISTS "imageType" TEXT;
ALTER TABLE "image_assets" ADD COLUMN IF NOT EXISTS "matchConfidence" DOUBLE PRECISION;
ALTER TABLE "image_assets" ADD COLUMN IF NOT EXISTS "sourcePageUrl" TEXT;
CREATE INDEX IF NOT EXISTS "image_assets_imageType_idx" ON "image_assets"("imageType");

-- Our own placeholders are neutral category images by definition. Every other legacy row stays
-- NULL, so the enrich-images job re-checks it under the current rules.
UPDATE "image_assets" SET "imageType" = 'neutral-category' WHERE "sourceType" = 'PLACEHOLDER' AND "imageType" IS NULL;
