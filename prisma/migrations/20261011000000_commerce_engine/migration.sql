-- Commerce intelligence engine (Apify): brands, sources, runs, raw records, products, offers, coupons,
-- match decisions; provenance fields on product_facts. Additive and idempotent.

-- AlterTable
ALTER TABLE "product_facts" ADD COLUMN IF NOT EXISTS "confidence" DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS "discoveredAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "extractionMethod" TEXT,
ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "commerce_brands" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "officialDomain" TEXT NOT NULL,
    "market" TEXT NOT NULL DEFAULT 'US',
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "discoveryUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "productUrlPatterns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "promoUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "crawlFrequencyHours" INTEGER NOT NULL DEFAULT 24,
    "maxProductsPerRun" INTEGER NOT NULL DEFAULT 20,
    "robotsStatus" TEXT,
    "robotsCheckedAt" TIMESTAMP(3),
    "lastCrawlAt" TIMESTAMP(3),
    "nextCrawlAt" TIMESTAMP(3),
    "crawlStatus" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commerce_brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "commerce_sources" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "startUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "urlPatterns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "termsStatus" TEXT NOT NULL DEFAULT 'UNREVIEWED',
    "robotsStatus" TEXT,
    "robotsCheckedAt" TIMESTAMP(3),
    "crawlFrequencyHours" INTEGER NOT NULL DEFAULT 24,
    "lastCrawlAt" TIMESTAMP(3),
    "nextCrawlAt" TIMESTAMP(3),
    "crawlStatus" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commerce_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "commerce_runs" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "brandId" TEXT,
    "sourceId" TEXT,
    "actorId" TEXT NOT NULL,
    "apifyRunId" TEXT,
    "datasetId" TEXT,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startUrls" INTEGER NOT NULL DEFAULT 0,
    "pagesProcessed" INTEGER,
    "extracted" INTEGER,
    "accepted" INTEGER,
    "rejected" INTEGER,
    "errors" JSONB,
    "usageUsd" DOUBLE PRECISION,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "collectedAt" TIMESTAMP(3),

    CONSTRAINT "commerce_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "commerce_raw_records" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_raw_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "commerce_products" (
    "id" TEXT NOT NULL,
    "brandId" TEXT,
    "productEntityId" TEXT,
    "canonicalUrl" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "model" TEXT,
    "mpn" TEXT,
    "sku" TEXT,
    "gtin" TEXT,
    "category" TEXT,
    "data" JSONB,
    "identityStatus" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "identityReason" TEXT,
    "lastRawId" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commerce_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "commerce_offers" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "seller" TEXT NOT NULL,
    "sellerType" TEXT NOT NULL,
    "destinationUrl" TEXT NOT NULL,
    "affiliateUrl" TEXT,
    "affiliateProvider" TEXT,
    "affiliateStatus" TEXT NOT NULL DEFAULT 'NONE',
    "price" DOUBLE PRECISION,
    "listPrice" DOUBLE PRECISION,
    "currency" TEXT,
    "availability" TEXT,
    "shipping" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "sourceRawId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'FRESH',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commerce_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "commerce_coupons" (
    "id" TEXT NOT NULL,
    "brandId" TEXT,
    "merchant" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "discount" TEXT,
    "discountType" TEXT,
    "startsAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "eligibility" TEXT,
    "restrictions" TEXT,
    "sourceUrl" TEXT NOT NULL,
    "merchantUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "verificationEvidence" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "lastVerifiedAt" TIMESTAMP(3),
    "sourceRawId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commerce_coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "commerce_match_logs" (
    "id" TEXT NOT NULL,
    "commerceProductId" TEXT NOT NULL,
    "productEntityId" TEXT,
    "result" TEXT NOT NULL,
    "basis" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_match_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "commerce_brands_slug_key" ON "commerce_brands"("slug");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "commerce_brands_enabled_nextCrawlAt_idx" ON "commerce_brands"("enabled", "nextCrawlAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "commerce_sources_slug_key" ON "commerce_sources"("slug");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "commerce_runs_apifyRunId_key" ON "commerce_runs"("apifyRunId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "commerce_runs_status_startedAt_idx" ON "commerce_runs"("status", "startedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "commerce_runs_brandId_startedAt_idx" ON "commerce_runs"("brandId", "startedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "commerce_raw_records_url_idx" ON "commerce_raw_records"("url");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "commerce_raw_records_runId_url_key" ON "commerce_raw_records"("runId", "url");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "commerce_products_canonicalUrl_key" ON "commerce_products"("canonicalUrl");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "commerce_products_productEntityId_idx" ON "commerce_products"("productEntityId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "commerce_products_brandId_idx" ON "commerce_products"("brandId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "commerce_offers_status_observedAt_idx" ON "commerce_offers"("status", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "commerce_offers_productId_destinationUrl_key" ON "commerce_offers"("productId", "destinationUrl");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "commerce_coupons_status_expiresAt_idx" ON "commerce_coupons"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "commerce_coupons_merchant_code_sourceUrl_key" ON "commerce_coupons"("merchant", "code", "sourceUrl");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "commerce_match_logs_commerceProductId_idx" ON "commerce_match_logs"("commerceProductId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "commerce_match_logs_result_createdAt_idx" ON "commerce_match_logs"("result", "createdAt");

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commerce_runs_brandId_fkey') THEN ALTER TABLE "commerce_runs" ADD CONSTRAINT "commerce_runs_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "commerce_brands"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commerce_runs_sourceId_fkey') THEN ALTER TABLE "commerce_runs" ADD CONSTRAINT "commerce_runs_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "commerce_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commerce_raw_records_runId_fkey') THEN ALTER TABLE "commerce_raw_records" ADD CONSTRAINT "commerce_raw_records_runId_fkey" FOREIGN KEY ("runId") REFERENCES "commerce_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commerce_products_brandId_fkey') THEN ALTER TABLE "commerce_products" ADD CONSTRAINT "commerce_products_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "commerce_brands"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commerce_offers_productId_fkey') THEN ALTER TABLE "commerce_offers" ADD CONSTRAINT "commerce_offers_productId_fkey" FOREIGN KEY ("productId") REFERENCES "commerce_products"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commerce_coupons_brandId_fkey') THEN ALTER TABLE "commerce_coupons" ADD CONSTRAINT "commerce_coupons_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "commerce_brands"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;


-- Not exposed through Supabase's public API roles.
ALTER TABLE "commerce_brands" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "commerce_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "commerce_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "commerce_raw_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "commerce_products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "commerce_offers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "commerce_coupons" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "commerce_match_logs" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON "commerce_brands" FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON "commerce_brands" FROM authenticated; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON "commerce_sources" FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON "commerce_sources" FROM authenticated; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON "commerce_runs" FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON "commerce_runs" FROM authenticated; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON "commerce_raw_records" FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON "commerce_raw_records" FROM authenticated; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON "commerce_products" FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON "commerce_products" FROM authenticated; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON "commerce_offers" FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON "commerce_offers" FROM authenticated; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON "commerce_coupons" FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON "commerce_coupons" FROM authenticated; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON "commerce_match_logs" FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON "commerce_match_logs" FROM authenticated; END IF;
END $$;
