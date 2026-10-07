-- Commerce registry (deal/product URLs, currency), persisted deal status, run compute units,
-- verification events. Additive and idempotent: no drops, no data rewrites.
ALTER TABLE "commerce_brands" ADD COLUMN IF NOT EXISTS "dealUrls" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "commerce_brands" ADD COLUMN IF NOT EXISTS "productUrls" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "commerce_brands" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'USD';

ALTER TABLE "commerce_offers" ADD COLUMN IF NOT EXISTS "dealStatus" TEXT;
ALTER TABLE "commerce_offers" ADD COLUMN IF NOT EXISTS "dealStatusReasons" JSONB;
ALTER TABLE "commerce_offers" ADD COLUMN IF NOT EXISTS "dealStatusAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "commerce_offers_dealStatus_idx" ON "commerce_offers"("dealStatus");

ALTER TABLE "commerce_runs" ADD COLUMN IF NOT EXISTS "computeUnits" DOUBLE PRECISION;

CREATE TABLE IF NOT EXISTS "commerce_verification_events" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "reason" TEXT,
    "sourceUrl" TEXT,
    "details" JSONB,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "commerce_verification_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "commerce_verification_events_entityType_entityId_checkedAt_idx" ON "commerce_verification_events"("entityType", "entityId", "checkedAt");
CREATE INDEX IF NOT EXISTS "commerce_verification_events_kind_checkedAt_idx" ON "commerce_verification_events"("kind", "checkedAt");
ALTER TABLE "commerce_verification_events" ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON "commerce_verification_events" FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON "commerce_verification_events" FROM authenticated; END IF;
END $$;
