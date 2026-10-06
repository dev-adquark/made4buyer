-- Commerce + richer source extraction: Sovrn promo codes, source-published commerce data with
-- provenance, extra normalized source data, and source-health run history. Additive and idempotent.

ALTER TYPE "revalidation_type" ADD VALUE IF NOT EXISTS 'COUPON_REFRESH';

CREATE TABLE IF NOT EXISTS "sovrn_coupons" (
  "id" TEXT NOT NULL,
  "normalizedReviewId" TEXT NOT NULL,
  "productUrl" TEXT NOT NULL,
  "sovrnCouponId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "description" TEXT,
  "affiliatedUrl" TEXT NOT NULL,
  "originalPrice" DOUBLE PRECISION,
  "priceWithCode" DOUBLE PRECISION,
  "currency" TEXT NOT NULL,
  "verified" BOOLEAN NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "merchantDomain" TEXT,
  "merchantName" TEXT,
  "rank" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "nextCheckAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sovrn_coupons_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "sovrn_coupons_normalizedReviewId_productUrl_sovrnCouponId_key" ON "sovrn_coupons"("normalizedReviewId", "productUrl", "sovrnCouponId");
CREATE INDEX IF NOT EXISTS "sovrn_coupons_isActive_nextCheckAt_idx" ON "sovrn_coupons"("isActive", "nextCheckAt");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sovrn_coupons_normalizedReviewId_fkey') THEN
    ALTER TABLE "sovrn_coupons" ADD CONSTRAINT "sovrn_coupons_normalizedReviewId_fkey" FOREIGN KEY ("normalizedReviewId") REFERENCES "normalized_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "normalized_reviews" ADD COLUMN IF NOT EXISTS "sourceProductUrl" TEXT;
ALTER TABLE "normalized_reviews" ADD COLUMN IF NOT EXISTS "sourcePrice" DOUBLE PRECISION;
ALTER TABLE "normalized_reviews" ADD COLUMN IF NOT EXISTS "sourceCurrency" TEXT;
ALTER TABLE "normalized_reviews" ADD COLUMN IF NOT EXISTS "sourceAvailability" TEXT;
ALTER TABLE "normalized_reviews" ADD COLUMN IF NOT EXISTS "sourcePriceObservedAt" TIMESTAMP(3);
ALTER TABLE "normalized_reviews" ADD COLUMN IF NOT EXISTS "sourceData" JSONB;

ALTER TABLE "review_sources" ADD COLUMN IF NOT EXISTS "lastSuccessAt" TIMESTAMP(3);
ALTER TABLE "review_sources" ADD COLUMN IF NOT EXISTS "lastFailureAt" TIMESTAMP(3);
ALTER TABLE "review_sources" ADD COLUMN IF NOT EXISTS "lastError" TEXT;
ALTER TABLE "review_sources" ADD COLUMN IF NOT EXISTS "duplicateCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "review_sources" ADD COLUMN IF NOT EXISTS "errorCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "sovrn_coupons" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON "sovrn_coupons" FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON "sovrn_coupons" FROM authenticated; END IF;
END $$;
