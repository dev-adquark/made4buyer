-- Platform completion: keyword schedules, brand crawl windows, offer link checks, official verification.
-- Additive and idempotent: no drops, no data rewrites.
ALTER TABLE "content_queue" ADD COLUMN IF NOT EXISTS "frequency" TEXT NOT NULL DEFAULT 'ONCE';
ALTER TABLE "content_queue" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'calendar';
ALTER TABLE "content_queue" ADD COLUMN IF NOT EXISTS "enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "content_queue" ADD COLUMN IF NOT EXISTS "lastRunAt" TIMESTAMP(3);
ALTER TABLE "content_queue" ADD COLUMN IF NOT EXISTS "nextRunAt" TIMESTAMP(3);
ALTER TABLE "content_queue" ADD COLUMN IF NOT EXISTS "lastResult" TEXT;
CREATE INDEX IF NOT EXISTS "content_queue_enabled_nextRunAt_idx" ON "content_queue"("enabled", "nextRunAt");

ALTER TABLE "commerce_brands" ADD COLUMN IF NOT EXISTS "crawlWindowStartHour" INTEGER;
ALTER TABLE "commerce_brands" ADD COLUMN IF NOT EXISTS "crawlWindowHours" INTEGER NOT NULL DEFAULT 24;
ALTER TABLE "commerce_brands" ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT 'America/New_York';
ALTER TABLE "commerce_brands" ADD COLUMN IF NOT EXISTS "officialStoreUrl" TEXT;

ALTER TABLE "commerce_offers" ADD COLUMN IF NOT EXISTS "linkStatus" TEXT NOT NULL DEFAULT 'UNCHECKED';
ALTER TABLE "commerce_offers" ADD COLUMN IF NOT EXISTS "linkCheckedAt" TIMESTAMP(3);
ALTER TABLE "commerce_offers" ADD COLUMN IF NOT EXISTS "linkHttpStatus" INTEGER;
ALTER TABLE "commerce_offers" ADD COLUMN IF NOT EXISTS "linkFinalUrl" TEXT;

ALTER TABLE "product_entities" ADD COLUMN IF NOT EXISTS "officialStatus" TEXT;
ALTER TABLE "product_entities" ADD COLUMN IF NOT EXISTS "officialUrl" TEXT;
ALTER TABLE "product_entities" ADD COLUMN IF NOT EXISTS "officialVerifiedAt" TIMESTAMP(3);
