-- Editorial review sources scraped with the Apify Web Scraper, and their runs.
CREATE TYPE "content_rights" AS ENUM ('LICENSED', 'EXCERPT_ONLY');

CREATE TABLE "review_sources" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "homepageUrl" TEXT NOT NULL,
  "allowedDomains" TEXT[],
  "startUrls" TEXT[],
  "reviewUrlPatterns" TEXT[],
  "categoryHint" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "crawlFrequencyHours" INTEGER NOT NULL DEFAULT 24,
  "maxPagesPerRun" INTEGER NOT NULL DEFAULT 20,
  "rights" "content_rights" NOT NULL DEFAULT 'EXCERPT_ONLY',
  "extractionProfile" JSONB,
  "notes" TEXT,
  "lastRunAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "review_sources_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "review_sources_slug_key" ON "review_sources"("slug");
CREATE INDEX "review_sources_enabled_lastRunAt_idx" ON "review_sources"("enabled", "lastRunAt");

CREATE TABLE "apify_runs" (
  "id" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "apifyRunId" TEXT NOT NULL,
  "datasetId" TEXT,
  "status" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "itemCount" INTEGER,
  "accepted" INTEGER,
  "rejected" INTEGER,
  "ingestRunId" TEXT,
  "error" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "collectedAt" TIMESTAMP(3),
  CONSTRAINT "apify_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "apify_runs_apifyRunId_key" ON "apify_runs"("apifyRunId");
CREATE INDEX "apify_runs_status_startedAt_idx" ON "apify_runs"("status", "startedAt");
CREATE INDEX "apify_runs_sourceId_startedAt_idx" ON "apify_runs"("sourceId", "startedAt");
ALTER TABLE "apify_runs" ADD CONSTRAINT "apify_runs_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "review_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same lockdown as every other table: no Supabase REST/GraphQL access (Prisma is the owner).
ALTER TABLE "review_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "apify_runs" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "review_sources", "apify_runs" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "review_sources", "apify_runs" FROM authenticated;
  END IF;
END $$;
