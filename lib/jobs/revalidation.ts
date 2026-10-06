import type { Prisma, RevalidationType } from "@prisma/client";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { SYSTEM_ACTOR, type AuditContext } from "@/lib/security/audit";
import { counters as newCounters, processContentItem } from "@/lib/pipeline/ingest";
import { processReview, REVIEW_STAGES, type ReviewStage } from "@/lib/pipeline/process";
import { runPublishCycle } from "@/lib/pipeline/publish";
import { persistPageRenderModel } from "@/lib/pipeline/render-model";
import { revalidateReviewPaths } from "@/lib/pipeline/revalidate-paths";
import { ENRICHMENT_VERSION, enrichProduct } from "@/lib/products/enrich";

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

/**
 * Product-data enrichment. Products on published pages are enriched oldest-first; a product is
 * revisited after PRODUCT_ENRICH_INTERVAL_HOURS (fresh facts are not re-fetched, see refreshDue).
 * Pages showing a product are rebuilt when its resolved data changed.
 */
export async function runProductEnrichment(opts: { trigger: string; ctx?: AuditContext; limit?: number }): Promise<RunResult> {
  const interval = Math.max(1, Number(process.env.PRODUCT_ENRICH_INTERVAL_HOURS ?? 24) || 24) * 3_600_000;
  return trackRun("PRODUCT_ENRICHMENT", opts.trigger, opts.ctx ?? SYSTEM_ACTOR, {}, async (tally) => {
    const due = new Date(Date.now() - interval);
    const entities = await db.productEntity.findMany({
      where: { content: { some: { review: { status: "PUBLISHED" } } }, OR: [{ enrichedAt: null }, { enrichedAt: { lte: due } }, { NOT: { factSummary: { path: ["version"], equals: ENRICHMENT_VERSION } } }] },
      orderBy: { enrichedAt: { sort: "asc", nulls: "first" } },
      take: opts.limit ?? 25,
      select: { id: true, factSummary: true, content: { where: { review: { status: "PUBLISHED" } }, select: { review: { select: { id: true, slug: true, status: true, categorySlug: true, brandSlug: true } } } } },
    });
    for (const e of entities) {
      try {
        const before = JSON.stringify((e.factSummary as { fields?: unknown } | null)?.fields ?? null);
        const r = await enrichProduct(e.id);
        tally.add(true, r.status);
        for (const o of r.outcomes) tally.reasons[o.split(" ")[0].split(":")[0]] = (tally.reasons[o.split(" ")[0].split(":")[0]] ?? 0) + 1;
        const after = await db.productEntity.findUnique({ where: { id: e.id }, select: { factSummary: true } });
        if (JSON.stringify((after?.factSummary as { fields?: unknown } | null)?.fields ?? null) !== before) {
          for (const { review } of e.content) {
            await persistPageRenderModel(review.id);
            revalidateReviewPaths(review);
          }
        }
      } catch (error) {
        tally.add(false, "ERROR");
        log.warn("product enrichment failed", { stage: "ENTITY_EXTRACTION", entityId: e.id, error: String(error).slice(0, 300) });
      }
    }
  });
}

export async function runCacheCleanup(opts: { trigger: string; ctx?: AuditContext }): Promise<RunResult> {
  return trackRun("CACHE_CLEANUP", opts.trigger, opts.ctx ?? SYSTEM_ACTOR, {}, async (tally) => {
    const now = new Date();
    const sessions = await db.adminSession.deleteMany({ where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { not: null } }] } });
    const buckets = await db.rateLimitBucket.deleteMany({ where: { windowStart: { lt: new Date(now.getTime() - 24 * 3_600_000) } } });
    const locks = await db.jobLock.deleteMany({ where: { expiresAt: { lt: now } } });
    tally.checked = sessions.count + buckets.count + locks.count;
    tally.success = tally.checked;
    tally.reasons = { admin_sessions: sessions.count, rate_limit_buckets: buckets.count, stale_locks: locks.count };
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
        if (f.entityType === "affiliate_link" || f.stage === "AFFILIATE_LINK" || f.stage === "LINK_VERIFICATION") {
          // Legacy affiliate-link failures: that pipeline no longer exists, so there is nothing to retry.
          await db.pipelineFailure.update({ where: { id: f.id }, data: { resolvedAt: new Date(), nextRetryAt: null } });
        } else if (f.entityType === "content_item") {
          const item = await db.contentItem.findUnique({ where: { id: f.entityId }, select: { id: true, processingStatus: true } });
          if (item?.processingStatus === "FAILED") {
            await db.contentItem.update({ where: { id: item.id }, data: { processingStatus: "INGESTED" } });
            await processContentItem(item.id, newCounters());
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
