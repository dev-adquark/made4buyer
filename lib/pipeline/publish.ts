import type { NormalizedReview, ReviewStatus } from "@prisma/client";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { audit, type AuditContext } from "@/lib/security/audit";
import { recordEvent } from "@/lib/analytics/events";
import { recordFailure, resolveFailures } from "./failures";
import { allowed } from "@/lib/automation/settings";
import { evaluateFreshness, freshnessExempt, freshnessMaxDays } from "./freshness";
import { persistPageRenderModel } from "./render-model";
import { revalidateReviewPaths } from "./revalidate-paths";

/**
 * Stage PUBLISH. Automatic QA rules decide whether a review can go live; none of them waits for a
 * person. Hard rules: rejected, too short, no category, no entities, no source date, or not fresh
 * (source date older than FRESHNESS_MAX_DAYS, for content never published before). Every publish/unpublish
 * attempt writes a PublishJob row (used for the page-error-rate metric) and an audit entry.
 */

export type QaFailure = { code: string; message: string };

export async function evaluateQa(reviewId: string): Promise<QaFailure[]> {
  const review = await db.normalizedReview.findUniqueOrThrow({
    where: { id: reviewId },
    include: {
      entities: { select: { id: true } },
      _count: { select: { contentEntities: true } },
      assignments: { where: { active: true, isPrimary: true, tagType: "CATEGORY" }, select: { id: true } },
    },
  });
  // Keyword-to-Blog posts are published as returned (owner's rule): no QA gate on any path
  // (Publish button, bulk publish, publish cycle, restore, reprocess).
  if (review.source === "keyword-to-blog") return [];
  const failures: QaFailure[] = [];
  // An AI guide never waits for editor approval (owner's rule): no approval gate exists.
  if (review.kind !== "AI_GUIDE" && !review.sourcePublishedAt) {
    failures.push({ code: "PUBLICATION_DATE_MISSING", message: "The source did not supply a publication date. Fix it in the Content API: we never guess a date" });
  } else if (review.kind !== "AI_GUIDE" && !review.publishedAt && !freshnessExempt(review.source)) {
    // New external content only: something already live is never pulled for ageing.
    const f = evaluateFreshness({ publishedAt: review.sourcePublishedAt, updatedAt: review.sourceUpdatedAt });
    if (f.status !== "FRESH") failures.push({ code: "FRESHNESS_STALE", message: `The source's newest date is ${f.ageDays ?? "?"} days old; only content at most ${freshnessMaxDays()} days old is published automatically` });
  }
  if (review.status === "REJECTED") failures.push({ code: "REVIEW_REJECTED", message: "Review is rejected; restore it first" });
  if (review.canonicalTitle.length < 8) failures.push({ code: "TITLE_TOO_SHORT", message: "Title must be at least 8 characters" });
  if (review.summary.length < 20) failures.push({ code: "SUMMARY_TOO_SHORT", message: "Summary must be at least 20 characters" });
  if (review.body.length < 120) failures.push({ code: "BODY_TOO_SHORT", message: "Body must be at least 120 characters" });
  const primary = review.assignments[0];
  if (!primary || !review.categorySlug) failures.push({ code: "NO_PRIMARY_CATEGORY", message: "Review has no primary category" });
  if (review.kind === "COMPARISON" && review._count.contentEntities < 2) {
    failures.push({ code: "COMPARISON_ENTITIES_MISSING", message: `A comparison needs at least two products; ${review._count.contentEntities} resolved. Add them under Products in this article` });
  }
  // Low category/entity confidence is shown in Admin as information only; it never holds a review.
  if (!review.entities) failures.push({ code: "ENTITIES_MISSING", message: "Entity extraction has not run" });
  return failures;
}

/** After (re)processing: move NEEDS_REVIEW ↔ QUEUED based on QA. Never changes PUBLISHED/REJECTED/UNPUBLISHED. */
export async function refreshQueueStatus(reviewId: string): Promise<ReviewStatus> {
  const review = await db.normalizedReview.findUniqueOrThrow({ where: { id: reviewId }, select: { status: true } });
  const failures = await evaluateQa(reviewId);
  const qaFailures = failures.length ? failures : undefined;
  if (review.status === "NEEDS_REVIEW" || review.status === "QUEUED") {
    const status: ReviewStatus = failures.length ? "NEEDS_REVIEW" : "QUEUED";
    await db.normalizedReview.update({ where: { id: reviewId }, data: { status, qaFailures: qaFailures ?? [], statusReason: failures.length ? failures.map((f) => f.code).join(", ") : "QA passed" } });
    await db.contentItem.updateMany({ where: { normalizedReviewId: reviewId, processingStatus: { in: ["NORMALIZED", "QUEUED"] } }, data: { processingStatus: status === "QUEUED" ? "QUEUED" : "NORMALIZED" } });
    return status;
  }
  await db.normalizedReview.update({ where: { id: reviewId }, data: { qaFailures: qaFailures ?? [] } });
  return review.status;
}

async function publishJob(reviewId: string, action: "PUBLISH" | "UNPUBLISH", status: "SUCCEEDED" | "FAILED", trigger: string, ctx: AuditContext, extra: { qaFailures?: QaFailure[]; errorCode?: string; message?: string } = {}) {
  await db.publishJob.create({
    data: { normalizedReviewId: reviewId, action, status, trigger, actor: ctx.actor, qaFailures: extra.qaFailures, errorCode: extra.errorCode, message: extra.message },
  });
}

export type PublishResult = { ok: true; review: NormalizedReview } | { ok: false; failures: QaFailure[] };

export async function publishReview(reviewId: string, ctx: AuditContext, trigger: "admin" | "auto" | "csv" = "admin", opts: { skipQa?: boolean } = {}): Promise<PublishResult> {
  const before = await db.normalizedReview.findUniqueOrThrow({ where: { id: reviewId } });
  // skipQa: the owner's direct-publish mode for AI-generated articles/guides (audited, labelled).
  const failures = opts.skipQa ? [] : await evaluateQa(reviewId);
  if (failures.length) {
    await publishJob(reviewId, "PUBLISH", "FAILED", trigger, ctx, { qaFailures: failures, errorCode: "PUBLISH_QA_FAILED", message: failures.map((f) => f.code).join(", ") });
    await recordFailure({ stage: "PUBLISH", code: "PUBLISH_QA_FAILED", message: failures.map((f) => f.message).join("; "), entityType: "normalized_review", entityId: reviewId, normalizedReviewId: reviewId });
    await db.normalizedReview.update({ where: { id: reviewId }, data: { qaFailures: failures } });
    await audit(ctx, { action: "review.publish_failed", entityType: "normalized_review", entityId: reviewId, metadata: { failures } });
    return { ok: false, failures };
  }
  try {
    // A previous valid publication timestamp is preserved on republish.
    const publishedAt = before.publishedAt ?? new Date();
    const review = await db.normalizedReview.update({
      where: { id: reviewId },
      data: { status: "PUBLISHED", publishedAt, unpublishedAt: null, qaFailures: [], statusReason: `published by ${ctx.actor}` },
    });
    await persistPageRenderModel(reviewId);
    await db.contentItem.updateMany({ where: { normalizedReviewId: reviewId, processingStatus: { not: "DUPLICATE" } }, data: { processingStatus: "PUBLISHED" } });
    await publishJob(reviewId, "PUBLISH", "SUCCEEDED", trigger, ctx);
    await resolveFailures({ stage: "PUBLISH", entityType: "normalized_review", entityId: reviewId });
    await audit(ctx, { action: "review.publish", entityType: "normalized_review", entityId: reviewId, before: { status: before.status, publishedAt: before.publishedAt }, after: { status: review.status, publishedAt: review.publishedAt } });
    await recordEvent({ event: "publish", normalizedReviewId: reviewId, categorySlug: review.categorySlug, metadata: { trigger, actor: ctx.actor } });
    revalidateReviewPaths(review);
    log.info("review published", { stage: "PUBLISH", reviewId, trigger });
    return { ok: true, review };
  } catch (error) {
    await db.normalizedReview.update({ where: { id: reviewId }, data: { status: before.status, publishedAt: before.publishedAt } }).catch(() => undefined);
    await publishJob(reviewId, "PUBLISH", "FAILED", trigger, ctx, { errorCode: "PAGE_RENDER_FAILED", message: String(error).slice(0, 500) });
    await recordFailure({ stage: "PAGE_RENDER", code: "PAGE_RENDER_FAILED", message: String(error), entityType: "normalized_review", entityId: reviewId, normalizedReviewId: reviewId });
    throw error;
  }
}

export async function unpublishReview(reviewId: string, ctx: AuditContext, reason = "unpublished by admin") {
  const before = await db.normalizedReview.findUniqueOrThrow({ where: { id: reviewId } });
  if (before.status !== "PUBLISHED") return before;
  const review = await db.normalizedReview.update({ where: { id: reviewId }, data: { status: "UNPUBLISHED", unpublishedAt: new Date(), statusReason: reason } });
  await db.contentItem.updateMany({ where: { normalizedReviewId: reviewId, processingStatus: "PUBLISHED" }, data: { processingStatus: "QUEUED" } });
  await publishJob(reviewId, "UNPUBLISH", "SUCCEEDED", "admin", ctx, { message: reason });
  await audit(ctx, { action: "review.unpublish", entityType: "normalized_review", entityId: reviewId, before: { status: before.status }, after: { status: review.status }, metadata: { reason } });
  revalidateReviewPaths(review);
  return review;
}

export async function rejectReview(reviewId: string, ctx: AuditContext, reason = "rejected by admin") {
  const before = await db.normalizedReview.findUniqueOrThrow({ where: { id: reviewId } });
  if (before.status === "PUBLISHED") await publishJob(reviewId, "UNPUBLISH", "SUCCEEDED", "admin", ctx, { message: `rejected: ${reason}` });
  const review = await db.normalizedReview.update({ where: { id: reviewId }, data: { status: "REJECTED", rejectedAt: new Date(), statusReason: reason } });
  await db.contentItem.updateMany({ where: { normalizedReviewId: reviewId, processingStatus: { not: "DUPLICATE" } }, data: { processingStatus: "REJECTED" } });
  // Rejecting counts as an admin rejection of an unreviewed automatic category assignment.
  await db.reviewCategoryAssignment.updateMany({ where: { normalizedReviewId: reviewId, tagType: "CATEGORY", active: true, reviewState: "UNREVIEWED", isOverride: false }, data: { reviewState: "REJECTED", reviewedAt: new Date(), reviewedBy: ctx.actor } });
  await audit(ctx, { action: "review.reject", entityType: "normalized_review", entityId: reviewId, before: { status: before.status }, after: { status: review.status }, metadata: { reason } });
  revalidateReviewPaths(review);
  return review;
}

export async function restoreReview(reviewId: string, ctx: AuditContext) {
  const before = await db.normalizedReview.findUniqueOrThrow({ where: { id: reviewId } });
  if (before.status !== "REJECTED" && before.status !== "UNPUBLISHED") return before;
  await db.normalizedReview.update({ where: { id: reviewId }, data: { status: "NEEDS_REVIEW", rejectedAt: null, statusReason: `restored by ${ctx.actor}` } });
  await db.contentItem.updateMany({ where: { normalizedReviewId: reviewId, processingStatus: { in: ["REJECTED", "PUBLISHED", "QUEUED"] } }, data: { processingStatus: "NORMALIZED" } });
  const status = await refreshQueueStatus(reviewId);
  await audit(ctx, { action: "review.restore", entityType: "normalized_review", entityId: reviewId, before: { status: before.status }, after: { status } });
  return db.normalizedReview.findUniqueOrThrow({ where: { id: reviewId } });
}

/**
 * Publish cycle: re-checks parked reviews (so a review held by a rule that no longer applies moves
 * on by itself), then publishes every QA-passing QUEUED review. On unless AUTO_PUBLISH_ENABLED=false
 * or Admin → Automation pauses scheduled publishing.
 */
export async function runPublishCycle(ctx: AuditContext, limit = 100) {
  if (!config.ingest.autoPublish() || !(await allowed("scheduled_publishing")).ok || !(await allowed("review_publishing")).ok) return { enabled: false, attempted: 0, published: 0, failed: 0, ready: 0 };
  let ready = 0;
  const parked = await db.normalizedReview.findMany({ where: { status: { in: ["NEEDS_REVIEW", "QUEUED"] }, source: { not: "keyword-to-blog" } }, select: { id: true }, orderBy: { updatedAt: "asc" }, take: 200 });
  // Re-check QUEUED too, so one that has since aged out is parked quietly instead of failing a publish every cycle.
  for (const p of parked) if ((await refreshQueueStatus(p.id).catch(() => "NEEDS_REVIEW")) === "QUEUED") ready++;
  const queued = await db.normalizedReview.findMany({ where: { status: "QUEUED" }, select: { id: true }, orderBy: { createdAt: "asc" }, take: limit });
  let published = 0;
  let failed = 0;
  for (const r of queued) {
    try {
      const res = await publishReview(r.id, ctx, "auto");
      if (res.ok) published++;
      else failed++;
    } catch {
      failed++;
    }
  }
  return { enabled: true, attempted: queued.length, published, failed, ready };
}
