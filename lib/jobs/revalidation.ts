import { Prisma, type RevalidationType } from "@prisma/client";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { recordEvent } from "@/lib/analytics/events";
import { SYSTEM_ACTOR, type AuditContext } from "@/lib/security/audit";
import { processContentItem, type IngestCounters } from "@/lib/pipeline/ingest";
import { processReview, REVIEW_STAGES, type ReviewStage } from "@/lib/pipeline/process";
import { runPublishCycle } from "@/lib/pipeline/publish";
import { persistPageRenderModel } from "@/lib/pipeline/render-model";
import { revalidateReviewPaths } from "@/lib/pipeline/revalidate-paths";
import { verifyLinkRecord } from "@/lib/pipeline/stages";
import { config } from "@/lib/config";

/**
 * Revalidation / maintenance jobs. Each run is recorded in revalidation_runs with checked,
 * success and failure counts plus a reason breakdown.
 */

export type DateRange = { start?: Date; end?: Date };
export type RunResult = { runId: string; checked: number; success: number; failure: number; reasons: Record<string, number> };

async function trackRun(type: RevalidationType, trigger: string, ctx: AuditContext, range: DateRange, fn: (tally: Tally) => Promise<void>): Promise<RunResult> {
  const run = await db.revalidationRun.create({ data: { type, trigger, actor: ctx.actor, rangeStart: range.start, rangeEnd: range.end } });
  const tally = new Tally();
  try {
    await fn(tally);
    await db.revalidationRun.update({
      where: { id: run.id },
      data: {
        status: tally.failure ? "COMPLETED_WITH_ERRORS" : "COMPLETED",
        completedAt: new Date(),
        checkedCount: tally.checked,
        successCount: tally.success,
        failureCount: tally.failure,
        reasonBreakdown: tally.reasons as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    await db.revalidationRun.update({
      where: { id: run.id },
      data: { status: "FAILED", completedAt: new Date(), checkedCount: tally.checked, successCount: tally.success, failureCount: tally.failure, reasonBreakdown: tally.reasons as Prisma.InputJsonValue, errorMessage: String(error).slice(0, 1000) },
    });
    throw error;
  }
  log.info("revalidation run completed", { stage: "REVALIDATION", type, runId: run.id, ...tally });
  return { runId: run.id, checked: tally.checked, success: tally.success, failure: tally.failure, reasons: tally.reasons };
}

class Tally {
  checked = 0;
  success = 0;
  failure = 0;
  reasons: Record<string, number> = {};
  add(ok: boolean, reason: string) {
    this.checked++;
    if (ok) this.success++;
    else this.failure++;
    this.reasons[reason] = (this.reasons[reason] ?? 0) + 1;
  }
}

function reviewRangeFilter(range: DateRange): Prisma.NormalizedReviewWhereInput | undefined {
  if (!range.start && !range.end) return undefined;
  const window = { ...(range.start ? { gte: range.start } : {}), ...(range.end ? { lte: range.end } : {}) };
  return { OR: [{ publishedAt: window }, { AND: [{ publishedAt: null }, { createdAt: window }] }] };
}

/** Re-verifies affiliate links: due links by default, or every active link for reviews in a date range. */
export async function runLinkVerification(opts: { trigger: string; ctx?: AuditContext; range?: DateRange; onlyDue?: boolean; limit?: number }): Promise<RunResult> {
  const range = opts.range ?? {};
  const rangeWhere = reviewRangeFilter(range);
  const onlyDue = opts.onlyDue ?? !rangeWhere;
  return trackRun("LINK_VERIFICATION", opts.trigger, opts.ctx ?? SYSTEM_ACTOR, range, async (tally) => {
    const links = await db.affiliateLink.findMany({
      where: {
        isActive: true,
        ...(onlyDue ? { OR: [{ nextVerificationAt: null }, { nextVerificationAt: { lte: new Date() } }, { verificationStatus: "PENDING" }] } : {}),
        ...(rangeWhere ? { review: rangeWhere } : {}),
      },
      orderBy: [{ nextVerificationAt: "asc" }],
      take: opts.limit ?? config.links.batchSize(),
    });
    const changedReviews = new Set<string>();
    for (let i = 0; i < links.length; i += 6) {
      const batch = links.slice(i, i + 6);
      const results = await Promise.all(batch.map((l) => verifyLinkRecord(l).then((r) => ({ before: l.verificationStatus, ...r }))));
      for (const r of results) {
        tally.add(r.outcome.status === "VERIFIED_OK", r.outcome.status);
        if (r.before !== r.outcome.status) changedReviews.add(r.link.normalizedReviewId);
      }
    }
    for (const reviewId of changedReviews) {
      const review = await db.normalizedReview.findUnique({ where: { id: reviewId }, select: { status: true, slug: true, categorySlug: true, brandSlug: true } });
      if (review?.status === "PUBLISHED") {
        await persistPageRenderModel(reviewId);
        revalidateReviewPaths(review);
      }
    }
    await recordEvent({ event: "verification", metadata: { checked: tally.checked, verified: tally.success, failed: tally.failure, reasons: tally.reasons, trigger: opts.trigger } });
  });
}

/** Refreshes Sovrn matches (and downstream links) for published/queued reviews whose deal data is stale. */
export async function runOfferRefresh(opts: { trigger: string; ctx?: AuditContext; range?: DateRange; limit?: number }): Promise<RunResult> {
  const range = opts.range ?? {};
  const staleBefore = new Date(Date.now() - config.sovrn.cacheTtlMinutes() * 60_000);
  const rangeWhere = reviewRangeFilter(range);
  return trackRun("OFFER_REFRESH", opts.trigger, opts.ctx ?? SYSTEM_ACTOR, range, async (tally) => {
    const reviews = await db.normalizedReview.findMany({
      where: {
        status: { in: ["PUBLISHED", "QUEUED", "NEEDS_REVIEW"] },
        ...(rangeWhere ?? { OR: [{ dealCheckedAt: null }, { dealCheckedAt: { lte: staleBefore } }, { dealStatus: { in: ["PENDING", "STALE", "FAILED"] } }] }),
      },
      orderBy: { dealCheckedAt: { sort: "asc", nulls: "first" } },
      take: opts.limit ?? 50,
      select: { id: true },
    });
    for (const r of reviews) {
      const summary = await processReview(r.id, { from: "OFFER_MATCHING", bypassOfferCache: Boolean(rangeWhere) });
      tally.add(summary.dealStatus === "MATCHED", summary.dealStatus ?? "ERROR");
    }
  });
}

export async function runCacheCleanup(opts: { trigger: string; ctx?: AuditContext }): Promise<RunResult> {
  return trackRun("CACHE_CLEANUP", opts.trigger, opts.ctx ?? SYSTEM_ACTOR, {}, async (tally) => {
    const now = new Date();
    const cache = await db.sovrnOfferCache.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 7 * 24 * 3_600_000) } } });
    const sessions = await db.adminSession.deleteMany({ where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { not: null } }] } });
    const buckets = await db.rateLimitBucket.deleteMany({ where: { windowStart: { lt: new Date(now.getTime() - 24 * 3_600_000) } } });
    const locks = await db.jobLock.deleteMany({ where: { expiresAt: { lt: now } } });
    tally.checked = cache.count + sessions.count + buckets.count + locks.count;
    tally.success = tally.checked;
    tally.reasons = { sovrn_cache: cache.count, admin_sessions: sessions.count, rate_limit_buckets: buckets.count, stale_locks: locks.count };
  });
}

/** Retries due retryable failures with bounded attempts; exhausted failures become permanent. */
export async function runFailedRetry(opts: { trigger: string; ctx?: AuditContext; limit?: number }): Promise<RunResult> {
  return trackRun("FAILED_RETRY", opts.trigger, opts.ctx ?? SYSTEM_ACTOR, {}, async (tally) => {
    const due = await db.pipelineFailure.findMany({
      where: { resolvedAt: null, kind: "RETRYABLE_FAILURE", nextRetryAt: { lte: new Date() } },
      orderBy: { nextRetryAt: "asc" },
      take: opts.limit ?? 25,
    });
    const done = new Set<string>();
    for (const f of due) {
      if (f.retryCount >= f.maxRetries) {
        await db.pipelineFailure.update({ where: { id: f.id }, data: { kind: "PERMANENT_FAILURE", nextRetryAt: null, message: `${f.message} (retries exhausted after ${f.retryCount})` } });
        tally.add(false, `${f.errorCode}:EXHAUSTED`);
        continue;
      }
      await db.pipelineFailure.update({ where: { id: f.id }, data: { retryCount: { increment: 1 } } });
      const key = `${f.stage}|${f.entityType}|${f.entityId}`;
      if (done.has(key)) continue;
      done.add(key);
      try {
        if (f.entityType === "affiliate_link") {
          const link = await db.affiliateLink.findUnique({ where: { id: f.entityId } });
          if (link?.isActive) await verifyLinkRecord(link);
          else await db.pipelineFailure.update({ where: { id: f.id }, data: { resolvedAt: new Date(), nextRetryAt: null } });
        } else if (f.entityType === "content_item") {
          const item = await db.contentItem.findUnique({ where: { id: f.entityId }, select: { id: true, processingStatus: true } });
          if (item?.processingStatus === "FAILED") {
            await db.contentItem.update({ where: { id: item.id }, data: { processingStatus: "INGESTED" } });
            await processContentItem(item.id, { totalFetched: 0, normalized: 0, duplicate: 0, unchanged: 0, updated: 0, failedNormalization: 0, queued: 0, failure: 0, reasons: {}, duplicates: [] } as IngestCounters);
          }
        } else if (f.normalizedReviewId && (REVIEW_STAGES as readonly string[]).includes(f.stage)) {
          await processReview(f.normalizedReviewId, { from: f.stage as ReviewStage });
        } else if (f.stage === "CONTENT_FETCH") {
          // The next scheduled ingestion run retries the fetch; nothing to do per-entity.
          tally.add(true, "CONTENT_FETCH:DEFERRED_TO_INGESTION");
          continue;
        }
        const still = await db.pipelineFailure.findUnique({ where: { id: f.id }, select: { resolvedAt: true } });
        tally.add(Boolean(still?.resolvedAt), `${f.errorCode}:${still?.resolvedAt ? "RESOLVED" : "STILL_FAILING"}`);
      } catch (error) {
        tally.add(false, `${f.errorCode}:RETRY_ERROR`);
        log.error("retry failed", { stage: f.stage, failureId: f.id, error });
      }
    }
  });
}

export async function runPublishCycleJob(opts: { trigger: string; ctx?: AuditContext }): Promise<RunResult> {
  return trackRun("PUBLISH_CYCLE", opts.trigger, opts.ctx ?? SYSTEM_ACTOR, {}, async (tally) => {
    const r = await runPublishCycle(opts.ctx ?? SYSTEM_ACTOR);
    tally.checked = r.attempted;
    tally.success = r.published;
    tally.failure = r.failed;
    tally.reasons = r.enabled ? { published: r.published, qa_failed: r.failed } : { AUTO_PUBLISH_DISABLED: 1 };
  });
}
