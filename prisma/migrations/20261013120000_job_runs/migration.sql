-- Job runs: one row per execution of a scheduled job (cron, GitHub Actions, Admin "Run now"),
-- written by runJob (lib/jobs/registry.ts). Additive and idempotent: no drops, no data rewrites.
CREATE TABLE IF NOT EXISTS "job_runs" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "outcome" TEXT,
    "reason" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "job_runs_job_startedAt_idx" ON "job_runs"("job", "startedAt");
CREATE INDEX IF NOT EXISTS "job_runs_status_startedAt_idx" ON "job_runs"("status", "startedAt");

-- Not exposed through Supabase's public API roles.
ALTER TABLE "job_runs" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON "job_runs" FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON "job_runs" FROM authenticated; END IF;
END $$;
