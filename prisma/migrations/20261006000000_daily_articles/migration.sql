-- Daily article automation: a persistent content queue, a per-day slot ledger (morning/evening),
-- and database-level uniqueness for primary images and AI guide titles.
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS "content_queue" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "keyword" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "categorySlug" TEXT NOT NULL,
  "subcategorySlug" TEXT,
  "productName" TEXT,
  "brand" TEXT,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt" TIMESTAMP(3),
  "lockedAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "normalizedReviewId" TEXT,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "content_queue_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "content_queue_key_key" ON "content_queue"("key");
CREATE INDEX IF NOT EXISTS "content_queue_status_priority_idx" ON "content_queue"("status", "priority");

CREATE TABLE IF NOT EXISTS "automation_slots" (
  "id" TEXT NOT NULL,
  "day" TEXT NOT NULL,
  "slot" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "apiCalls" INTEGER NOT NULL DEFAULT 0,
  "queueItemId" TEXT,
  "normalizedReviewId" TEXT,
  "lastError" TEXT,
  "lastAttemptAt" TIMESTAMP(3),
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "automation_slots_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "automation_slots_day_slot_key" ON "automation_slots"("day", "slot");

-- 1 article = 1 image: a provider photo can be the primary image of only one article.
-- Stops (and fails the deploy) rather than silently changing data if duplicates already exist.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "image_assets" WHERE "isPrimary" AND "providerPhotoId" IS NOT NULL
    GROUP BY "providerPhotoId" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'image_assets has a provider photo used as the primary image of several articles; resolve before applying this migration';
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "image_assets_primary_photo_unique" ON "image_assets"("providerPhotoId") WHERE "isPrimary" AND "providerPhotoId" IS NOT NULL;

-- No two AI-assisted guides with the same title (case-insensitive).
CREATE UNIQUE INDEX IF NOT EXISTS "normalized_reviews_ai_guide_title_unique" ON "normalized_reviews"(lower("canonicalTitle")) WHERE "kind" = 'AI_GUIDE';

ALTER TABLE "content_queue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "automation_slots" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "content_queue", "automation_slots" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "content_queue", "automation_slots" FROM authenticated;
  END IF;
END $$;
