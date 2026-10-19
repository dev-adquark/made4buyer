-- One Apify run may now serve several review sources (one row per source, same apifyRunId).
DROP INDEX IF EXISTS "apify_runs_apifyRunId_key";
CREATE UNIQUE INDEX "apify_runs_apifyRunId_sourceId_key" ON "apify_runs"("apifyRunId", "sourceId");
