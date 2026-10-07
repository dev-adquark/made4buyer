import { db } from "@/lib/db";
import { gscConfigured, inspectUrl } from "@/lib/gsc";
import { recordFailure, resolveFailures } from "@/lib/pipeline/failures";
import { runCollectScrapes, runScrapeSources } from "@/lib/pipeline/apify";
import { runIngestion } from "@/lib/pipeline/ingest";
import { reviewUrl } from "@/lib/pipeline/render-model";
import { config } from "@/lib/config";
import { LockHeldError, withLock } from "./lock";
import { errorSummary, finishJobRun, recordJobRun, runStatusFor, startJobRun } from "./run-log";
import { runDataAudit } from "@/lib/ops/data-audit";
import { runCommerceCollect, runCommerceDiscover } from "@/lib/commerce/pipeline";
import { collectCouponRuns, runCouponCrawl } from "@/lib/commerce/coupons-run";
import { runLinkValidation } from "@/lib/commerce/link-check";
import { runOfficialVerify } from "@/lib/commerce/official";
import { runClassifyDeals } from "@/lib/commerce/classify";
import { pruneVerificationEvents } from "@/lib/commerce/verification-events";
import { continueWeeklyRefresh, runWeeklyRefresh } from "@/lib/commerce/weekly-refresh";
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
  // Also prunes commerce verification events older than 90 days (the latest per entity + kind is always kept).
  "cleanup-cache": {
    lockTtlMs: 10 * 60_000,
    run: async (trigger: string) => {
      const r = await runCacheCleanup({ trigger });
      const pruned = await pruneVerificationEvents(90).catch((error: unknown) => ({ deleted: 0, error: String(error).slice(0, 200) }));
      return { ...r, verificationEventsPruned: pruned.deleted, ...("error" in pruned ? { verificationEventsPruneError: pruned.error } : {}) };
    },
    locked: true,
  },
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
  // Each discover pass first collects finished product and coupon runs, so the every-2-hours
  // passes keep collection current without relying on any other scheduler.
  "commerce-discover": {
    lockTtlMs: 15 * 60_000,
    run: async (trigger: string) => {
      const t0 = Date.now();
      const collected = await runCommerceCollect(trigger);
      const coupons = await collectCouponRuns(trigger);
      const discover = await runCommerceDiscover(trigger);
      // Carries an in-progress weekly deals sweep on with the time this invocation has left (≤ 90 s; one settings read when idle).
      const weekly = await continueWeeklyRefresh(trigger, { budgetMs: Math.min(90_000, 250_000 - (Date.now() - t0)) });
      return { ...discover, collected: { checked: collected.checked, collected: collected.collected, staleOffers: collected.staleOffers }, coupons: { checked: coupons.checked, collected: coupons.collected }, weekly: { status: weekly.status, ...(weekly.reason ? { reason: weekly.reason } : {}) } };
    },
    locked: true,
  },
  "commerce-collect": { lockTtlMs: 20 * 60_000, run: async (trigger: string) => ({ ...(await runCommerceCollect(trigger)), coupons: await collectCouponRuns(trigger) }), locked: true },
  "commerce-coupons": { lockTtlMs: 15 * 60_000, run: (trigger: string) => runCouponCrawl(trigger), locked: true },
  // Commerce verification: offer destination checks (robots.txt respected, ≤ COMMERCE_LINK_CHECKS_PER_RUN) and official-source status.
  "commerce-validate-links": { lockTtlMs: 10 * 60_000, run: (trigger: string) => runLinkValidation(trigger), locked: true },
  "commerce-official-verify": { lockTtlMs: 10 * 60_000, run: (trigger: string) => runOfficialVerify(trigger), locked: true },
  // Persisted deal status (lib/commerce/classify.ts): the /deals decision stored per offer for Admin and history.
  "commerce-classify-deals": { lockTtlMs: 10 * 60_000, run: (trigger: string) => runClassifyDeals(trigger), locked: true },
  // Data-integrity audit (lib/ops/data-audit.ts): flags only, plus two safe audited status fixes.
  "data-audit": { lockTtlMs: 10 * 60_000, run: (trigger: string) => runDataAudit(trigger), locked: true },
  // Weekly deals refresh (lib/commerce/weekly-refresh.ts): called daily; sweeps once per configured weekly slot, resumable.
  "deals-weekly-refresh": { lockTtlMs: 10 * 60_000, run: (trigger: string) => runWeeklyRefresh(trigger), locked: true },
} as const;

export type JobName = keyof typeof JOBS;

export function isJobName(name: string): name is JobName {
  return Object.prototype.hasOwnProperty.call(JOBS, name);
}

/** Admin switches that govern each scheduled job (the master switch always applies). */
export const JOB_SWITCHES: Partial<Record<string, SwitchKey[]>> = {
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
  "commerce-validate-links": ["commerce_engine"],
  "commerce-official-verify": ["commerce_engine"],
  "commerce-classify-deals": ["commerce_engine"],
  "deals-weekly-refresh": ["commerce_engine"],
};

const DID_NOT_RUN = new Set(["PAUSED", "BLOCKED_BY_ENVIRONMENT", "NOT_AVAILABLE_IN_ENVIRONMENT", "NOT_CONFIGURED", "DISABLED", "SKIPPED", "FAILED", "AUTH_FAILED", "NOT_DUE", "BLOCKED", "RETRYING", "REJECTED", "BUDGET_EXHAUSTED"]);

/** Whether a job's result means it actually did its work, so callers never report a no-op as success. */
export function jobOutcome(result: unknown): { ran: boolean; status: string; reason?: string } {
  const r = (result ?? {}) as { status?: unknown; reason?: unknown };
  const status = typeof r.status === "string" ? r.status : "OK";
  return { ran: !DID_NOT_RUN.has(status), status, reason: typeof r.reason === "string" ? r.reason : undefined };
}

/**
 * Runs a job under its lock. Ingestion manages its own lock inside runIngestion. Every execution
 * (including paused, overlapping and failed ones) is recorded as one JobRun row (lib/jobs/run-log.ts).
 */
export async function runJob(name: JobName, trigger: string): Promise<unknown> {
  // Scheduled runs respect the admin switches; a manual "Run now" from Admin always runs.
  if (!trigger.startsWith("admin:")) {
    const gate = await allowed(...(JOB_SWITCHES[name] ?? []));
    if (!gate.ok) {
      await recordJobRun(name, trigger, { status: "PAUSED", outcome: "PAUSED", reason: gate.reason });
      return { status: "PAUSED", reason: gate.reason };
    }
  }
  const job = JOBS[name];
  const run = job.run as (trigger: string) => Promise<unknown>;
  const record = await startJobRun(name, trigger);
  try {
    const result = job.locked ? await withLock(`job:${name}`, job.lockTtlMs, () => run(trigger)) : await run(trigger);
    const outcome = jobOutcome(result);
    await finishJobRun(record, { status: runStatusFor(outcome), outcome: outcome.status, reason: outcome.reason });
    return result;
  } catch (error) {
    await finishJobRun(record, error instanceof LockHeldError ? { status: "LOCK_HELD", error: error.message } : { status: "FAILED", error: errorSummary(error) });
    throw error;
  }
}
