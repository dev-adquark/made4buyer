-- Multi-entity content: comparisons ("A vs B vs C") and source buying guides become first-class
-- kinds, and any content item can reference many products/services (ProductEntity).
-- Additive and idempotent: safe to run more than once.
ALTER TYPE "content_kind" ADD VALUE IF NOT EXISTS 'COMPARISON';
ALTER TYPE "content_kind" ADD VALUE IF NOT EXISTS 'BUYING_GUIDE';

CREATE TABLE IF NOT EXISTS "product_entities" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "matchKey" TEXT NOT NULL,
  "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "aliasKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "brand" TEXT,
  "brandSlug" TEXT,
  "categorySlug" TEXT,
  "subcategorySlug" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "product_entities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "product_entities_slug_key" ON "product_entities"("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "product_entities_matchKey_key" ON "product_entities"("matchKey");
CREATE INDEX IF NOT EXISTS "product_entities_brandSlug_idx" ON "product_entities"("brandSlug");
CREATE INDEX IF NOT EXISTS "product_entities_categorySlug_idx" ON "product_entities"("categorySlug");
CREATE INDEX IF NOT EXISTS "product_entities_aliasKeys_idx" ON "product_entities" USING GIN ("aliasKeys");

CREATE TABLE IF NOT EXISTS "content_entities" (
  "id" TEXT NOT NULL,
  "normalizedReviewId" TEXT NOT NULL,
  "productEntityId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "confidence" DOUBLE PRECISION NOT NULL,
  "source" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "content_entities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "content_entities_normalizedReviewId_productEntityId_key" ON "content_entities"("normalizedReviewId", "productEntityId");
CREATE INDEX IF NOT EXISTS "content_entities_productEntityId_idx" ON "content_entities"("productEntityId");
DO $$ BEGIN
  ALTER TABLE "content_entities" ADD CONSTRAINT "content_entities_normalizedReviewId_fkey" FOREIGN KEY ("normalizedReviewId") REFERENCES "normalized_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "content_entities" ADD CONSTRAINT "content_entities_productEntityId_fkey" FOREIGN KEY ("productEntityId") REFERENCES "product_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Same lockdown as every other table: the app connects as the owner; Supabase's public roles get nothing.
ALTER TABLE "product_entities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "content_entities" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "product_entities", "content_entities" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "product_entities", "content_entities" FROM authenticated;
  END IF;
END $$;
