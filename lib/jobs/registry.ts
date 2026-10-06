import { db } from "@/lib/db";
import { gscConfigured, inspectUrl } from "@/lib/gsc";
import { recordFailure, resolveFailures } from "@/lib/pipeline/failures";
import { runCollectScrapes, runScrapeSources } from "@/lib/pipeline/apify";
import { runIngestion } from "@/lib/pipeline/ingest";
import { reviewUrl } from "@/lib/pipeline/render-model";
import { config } from "@/lib/config";
import { withLock } from "./lock";
import { runCommerceCollect, runCommerceDiscover } from "@/lib/commerce/pipeline";
import { collectCouponRuns, runCouponCrawl } from "@/lib/commerce/coupons-run";
import { allowed, type SwitchKey } from "@/lib/automation/settings";
import { runDailyArticle } from "@/lib/automation/daily-article";
import { runImageBackfillWithCorrection } from "@/lib/images/hero-correction";
import { runReclassify } from "./reclassify";
import { runStaleContentDetection } from "./stale-content";
import { runTitleYearFix } from "./title-years";
import { runCacheCleanup, runFailedRetry, runPublishCycleJob, runProductEnrichment } from "./revalidation";

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
  // The legacy Content API feed is optional now that editorial reviews come from Apify sources.
  ingest: { lockTtlMs: 20 * 60_000, run: (trigger: string) => (config.contentApi.url() ? runIngestion({ trigger }) : Promise.resolve({ status: "SKIPPED", reason: "CONTENT_API_URL not configured; reviews come from Apify sources" })), locked: false },
  "scrape-sources": { lockTtlMs: 10 * 60_000, run: (trigger: string) => runScrapeSources(trigger), locked: true },
  "collect-scrapes": { lockTtlMs: 20 * 60_000, run: (trigger: string) => runCollectScrapes(trigger), locked: true },
  "retry-failed": { lockTtlMs: 15 * 60_000, run: (trigger: string) => runFailedRetry({ trigger }), locked: true },
  "cleanup-cache": { lockTtlMs: 10 * 60_000, run: (trigger: string) => runCacheCleanup({ trigger }), locked: true },
  "publish-cycle": { lockTtlMs: 10 * 60_000, run: (trigger: string) => runPublishCycleJob({ trigger }), locked: true },
  // 08:00 and 19:00 Asia/Kolkata. Idempotent: acts only when a slot is due and not done.
  "daily-article": { lockTtlMs: 6 * 60_000, run: (trigger: string) => runDailyArticle(trigger), locked: true },
  "reclassify-content": { lockTtlMs: 20 * 60_000, run: (trigger: string) => runReclassify(trigger), locked: true },
  "fix-title-years": { lockTtlMs: 10 * 60_000, run: (trigger: string) => runTitleYearFix(trigger), locked: true },
  "enrich-images": { lockTtlMs: 20 * 60_000, run: (trigger: string) => runImageBackfillWithCorrection(trigger, { limit: 60, pauseMs: 250 }), locked: true },
  "detect-stale": { lockTtlMs: 10 * 60_000, run: (trigger: string) => runStaleContentDetection(trigger), locked: true },
  "inspect-index": { lockTtlMs: 20 * 60_000, run: (trigger: string) => runIndexInspection(trigger), locked: true },
  "enrich-products": { lockTtlMs: 20 * 60_000, run: (trigger: string) => runProductEnrichment({ trigger }), locked: true },
  // Commerce intelligence engine (Apify, budget-capped): discover → start runs; collect → match → offers; first-party coupons.
  "commerce-discover": { lockTtlMs: 15 * 60_000, run: (trigger: string) => runCommerceDiscover(trigger), locked: true },
  "commerce-collect": { lockTtlMs: 20 * 60_000, run: async (trigger: string) => ({ ...(await runCommerceCollect(trigger)), coupons: await collectCouponRuns(trigger) }), locked: true },
  "commerce-coupons": { lockTtlMs: 15 * 60_000, run: (trigger: string) => runCouponCrawl(trigger), locked: true },
} as const;

export type JobName = keyof typeof JOBS;

export function isJobName(name: string): name is JobName {
  return Object.prototype.hasOwnProperty.call(JOBS, name);
}

/** Admin switches that govern each scheduled job (the master switch always applies). */
const JOB_SWITCHES: Partial<Record<string, SwitchKey[]>> = {
  ingest: ["external_ingestion"],
  "scrape-sources": ["external_ingestion"],
  "collect-scrapes": ["external_ingestion"],
  "daily-article": ["keyword_to_blog", "scheduled_publishing"],
  "publish-cycle": ["scheduled_publishing"],
  "enrich-images": ["image_enrichment"],
  "retry-failed": ["retries"],
  "enrich-products": ["product_enrichment"],
  "commerce-discover": ["commerce_engine"],
  "commerce-collect": ["commerce_engine"],
  "commerce-coupons": ["commerce_engine"],
};

const DID_NOT_RUN = new Set(["PAUSED", "BLOCKED_BY_ENVIRONMENT", "NOT_AVAILABLE_IN_ENVIRONMENT", "NOT_CONFIGURED", "DISABLED", "SKIPPED", "FAILED", "AUTH_FAILED", "NOT_DUE", "BLOCKED", "RETRYING", "REJECTED"]);

/** Whether a job's result means it actually did its work, so callers never report a no-op as success. */
export function jobOutcome(result: unknown): { ran: boolean; status: string; reason?: string } {
  const r = (result ?? {}) as { status?: unknown; reason?: unknown };
  const status = typeof r.status === "string" ? r.status : "OK";
  return { ran: !DID_NOT_RUN.has(status), status, reason: typeof r.reason === "string" ? r.reason : undefined };
}

/** Runs a job under its lock. Ingestion manages its own lock inside runIngestion. */
export async function runJob(name: JobName, trigger: string): Promise<unknown> {
  // Scheduled runs respect the admin switches; a manual "Run now" from Admin always runs.
  if (!trigger.startsWith("admin:")) {
    const gate = await allowed(...(JOB_SWITCHES[name] ?? []));
    if (!gate.ok) return { status: "PAUSED", reason: gate.reason };
  }
  const job = JOBS[name];
  const run = job.run as (trigger: string) => Promise<unknown>;
  if (!job.locked) return run(trigger);
  return withLock(`job:${name}`, job.lockTtlMs, () => run(trigger));
}
