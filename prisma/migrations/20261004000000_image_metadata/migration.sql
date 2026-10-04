-- Image provenance: what the photo shows (the product itself, or an illustrative topic photo),
-- the provider's photo id (for de-duplication), the query that found it and its alt text.
ALTER TABLE "image_assets" ADD COLUMN IF NOT EXISTS "subject" TEXT;
ALTER TABLE "image_assets" ADD COLUMN IF NOT EXISTS "providerPhotoId" TEXT;
ALTER TABLE "image_assets" ADD COLUMN IF NOT EXISTS "searchQuery" TEXT;
ALTER TABLE "image_assets" ADD COLUMN IF NOT EXISTS "altText" TEXT;
ALTER TABLE "image_assets" ADD COLUMN IF NOT EXISTS "photographerUrl" TEXT;
CREATE INDEX IF NOT EXISTS "image_assets_providerPhotoId_idx" ON "image_assets"("providerPhotoId");
