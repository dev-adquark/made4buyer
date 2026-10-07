-- Official brand logos with provenance (lib/commerce/brand-logos.ts). Additive and idempotent:
-- no drops, no data rewrites. The logo file is linked, never re-hosted.
ALTER TABLE "commerce_brands" ADD COLUMN IF NOT EXISTS "logoUrl" TEXT;
ALTER TABLE "commerce_brands" ADD COLUMN IF NOT EXISTS "logoSource" TEXT;
ALTER TABLE "commerce_brands" ADD COLUMN IF NOT EXISTS "logoSourceUrl" TEXT;
ALTER TABLE "commerce_brands" ADD COLUMN IF NOT EXISTS "logoLicense" TEXT;
ALTER TABLE "commerce_brands" ADD COLUMN IF NOT EXISTS "logoWidth" INTEGER;
ALTER TABLE "commerce_brands" ADD COLUMN IF NOT EXISTS "logoHeight" INTEGER;
ALTER TABLE "commerce_brands" ADD COLUMN IF NOT EXISTS "logoMime" TEXT;
ALTER TABLE "commerce_brands" ADD COLUMN IF NOT EXISTS "logoCheckedAt" TIMESTAMP(3);
ALTER TABLE "commerce_brands" ADD COLUMN IF NOT EXISTS "logoVerifiedAt" TIMESTAMP(3);
ALTER TABLE "commerce_brands" ADD COLUMN IF NOT EXISTS "logoStatus" TEXT;
ALTER TABLE "commerce_brands" ADD COLUMN IF NOT EXISTS "logoReason" TEXT;
ALTER TABLE "commerce_brands" ADD COLUMN IF NOT EXISTS "logoLocked" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "commerce_brands_logoStatus_logoCheckedAt_idx" ON "commerce_brands"("logoStatus", "logoCheckedAt");
