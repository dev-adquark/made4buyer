import { db } from "@/lib/db";
import { gscConfigured, inspectUrl } from "@/lib/gsc";
import { recordFailure, resolveFailures } from "@/lib/pipeline/failures";
import { runIngestion } from "@/lib/pipeline/ingest";
import { reviewUrl } from "@/lib/pipeline/render-model";
import { config } from "@/lib/config";
import { withLock } from "./lock";
import { runCacheCleanup, runFailedRetry, runLinkVerification, runOfferRefresh, runPublishCycleJob } from "./revalidation";

/**
 * Scheduled jobs exposed at /api/cron/<name>. Every job runs under a DB lock (concurrent
 * invocations get HTTP 409) and is idempotent: re-running only re-checks due work.
 */

async function runIndexInspection(trigger: string) {
  if (!gscConfigured()) return { status: "NOT_AVAILABLE_IN_ENVIRONMENT", inspected: 0 };
  const cutoff = new Date(Date.now() - 7 * 24 * 3_600_000);
  const reviews = await db.normalizedReview.findMany({
    where: { status: "PUBLISHED", indexChecks: { none: { checkedAt: { gte: cutoff } } } },
    orderBy: { publishedAt: "asc" },
    take: config.gsc.inspectionsPerRun(),
    select: { id: true, slug: true },
  });
  let inspected = 0;
  let errors = 0;
  for (const r of reviews) {
    const url = reviewUrl(r.slug);
    try {
      const result = await inspectUrl(url);
      await db.searchIndexCheck.create({ data: { normalizedReviewId: r.id, url, verdict: result.verdict, coverageState: result.coverageState, lastCrawlTime: result.lastCrawlTime } });
      await resolveFailures({ stage: "INDEX_INSPECTION", entityType: "search_index", entityId: r.id });
      inspected++;
    } catch (error) {
      errors++;
      await db.searchIndexCheck.create({ data: { normalizedReviewId: r.id, url, verdict: "ERROR", error: String(error).slice(0, 500) } });
      await recordFailure({ stage: "INDEX_INSPECTION", code: "GSC_INSPECTION_FAILED", message: String(error), entityType: "search_index", entityId: r.id, normalizedReviewId: r.id });
    }
  }
  return { status: "OK", inspected, errors, trigger };
}

export const JOBS = {
  ingest: { lockTtlMs: 20 * 60_000, run: (trigger: string) => runIngestion({ trigger }), locked: false },
  "verify-links": { lockTtlMs: 20 * 60_000, run: (trigger: string) => runLinkVerification({ trigger }), locked: true },
  "revalidate-offers": { lockTtlMs: 20 * 60_000, run: (trigger: string) => runOfferRefresh({ trigger }), locked: true },
  "retry-failed": { lockTtlMs: 15 * 60_000, run: (trigger: string) => runFailedRetry({ trigger }), locked: true },
  "cleanup-cache": { lockTtlMs: 10 * 60_000, run: (trigger: string) => runCacheCleanup({ trigger }), locked: true },
  "publish-cycle": { lockTtlMs: 10 * 60_000, run: (trigger: string) => runPublishCycleJob({ trigger }), locked: true },
  "inspect-index": { lockTtlMs: 20 * 60_000, run: (trigger: string) => runIndexInspection(trigger), locked: true },
} as const;

export type JobName = keyof typeof JOBS;

export function isJobName(name: string): name is JobName {
  return Object.prototype.hasOwnProperty.call(JOBS, name);
}

/** Runs a job under its lock. Ingestion manages its own lock inside runIngestion. */
export async function runJob(name: JobName, trigger: string): Promise<unknown> {
  const job = JOBS[name];
  const run = job.run as (trigger: string) => Promise<unknown>;
  if (!job.locked) return run(trigger);
  return withLock(`job:${name}`, job.lockTtlMs, () => run(trigger));
}
