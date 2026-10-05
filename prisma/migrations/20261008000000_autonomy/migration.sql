-- Autonomous operation: admin automation switches, external-content freshness tracking and
-- source health. Additive and idempotent.

CREATE TABLE IF NOT EXISTS "automation_settings" (
  "key" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "updatedBy" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "automation_settings_pkey" PRIMARY KEY ("key")
);

-- Freshness of externally sourced content (source published/updated date, never crawl date).
ALTER TABLE "content_items" ADD COLUMN IF NOT EXISTS "sourceUpdatedAt" TIMESTAMP(3);
ALTER TABLE "content_items" ADD COLUMN IF NOT EXISTS "freshnessStatus" TEXT;
ALTER TABLE "content_items" ADD COLUMN IF NOT EXISTS "freshnessAgeDays" INTEGER;
ALTER TABLE "content_items" ADD COLUMN IF NOT EXISTS "freshnessCheckedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "content_items_freshnessStatus_idx" ON "content_items"("freshnessStatus");
ALTER TABLE "normalized_reviews" ADD COLUMN IF NOT EXISTS "sourceUpdatedAt" TIMESTAMP(3);
ALTER TABLE "normalized_reviews" ADD COLUMN IF NOT EXISTS "freshnessStatus" TEXT;

-- Source health: priority, failure/stale streaks, automatic pause with recovery.
ALTER TABLE "review_sources" ADD COLUMN IF NOT EXISTS "priority" INTEGER NOT NULL DEFAULT 100;
ALTER TABLE "review_sources" ADD COLUMN IF NOT EXISTS "consecutiveFailures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "review_sources" ADD COLUMN IF NOT EXISTS "consecutiveStale" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "review_sources" ADD COLUMN IF NOT EXISTS "freshCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "review_sources" ADD COLUMN IF NOT EXISTS "staleCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "review_sources" ADD COLUMN IF NOT EXISTS "lastFreshAt" TIMESTAMP(3);
ALTER TABLE "review_sources" ADD COLUMN IF NOT EXISTS "lastStaleAt" TIMESTAMP(3);
ALTER TABLE "review_sources" ADD COLUMN IF NOT EXISTS "pausedUntil" TIMESTAMP(3);
ALTER TABLE "review_sources" ADD COLUMN IF NOT EXISTS "healthNote" TEXT;

ALTER TABLE "apify_runs" ADD COLUMN IF NOT EXISTS "freshCount" INTEGER;
ALTER TABLE "apify_runs" ADD COLUMN IF NOT EXISTS "staleCount" INTEGER;
ALTER TABLE "apify_runs" ADD COLUMN IF NOT EXISTS "unknownFreshnessCount" INTEGER;

ALTER TABLE "automation_settings" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON "automation_settings" FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON "automation_settings" FROM authenticated; END IF;
END $$;
