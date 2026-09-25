import type { NormalizedReview, ReviewStatus } from "@prisma/client";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { audit, type AuditContext } from "@/lib/security/audit";
import { recordEvent } from "@/lib/analytics/events";
import { recordFailure, resolveFailures } from "./failures";
import { persistPageRenderModel } from "./render-model";
import { revalidateReviewPaths } from "./revalidate-paths";

/**
 * Stage PUBLISH. QA gates decide whether a review can go live. Every publish/unpublish
 * attempt writes a PublishJob row (used for the page-error-rate metric) and an audit entry.
 */

export type QaFailure = { code: string; message: string };

export async function evaluateQa(reviewId: string): Promise<QaFailure[]> {
  const review = await db.normalizedReview.findUniqueOrThrow({
    where: { id: reviewId },
    include: {
      entities: { select: { lowConfidenceFields: true } },
      assignments: { where: { active: true, isPrimary: true, tagType: "CATEGORY" }, select: { confidence: true, isOverride: true, reviewState: true } },
    },
  });
  const failures: QaFailure[] = [];
  if (review.status === "REJECTED") failures.push({ code: "REVIEW_REJECTED", message: "Review is rejected; restore it first" });
  if (review.canonicalTitle.length < 8) failures.push({ code: "TITLE_TOO_SHORT", message: "Title must be at least 8 characters" });
  if (review.summary.length < 20) failures.push({ code: "SUMMARY_TOO_SHORT", message: "Summary must be at least 20 characters" });
  if (review.body.length < 120) failures.push({ code: "BODY_TOO_SHORT", message: "Body must be at least 120 characters" });
  const primary = review.assignments[0];
  if (!primary || !review.categorySlug) failures.push({ code: "NO_PRIMARY_CATEGORY", message: "Review has no primary category" });
  else if (!primary.isOverride && primary.reviewState !== "ACCEPTED" && primary.confidence < config.taxonomy.autoAcceptThreshold()) {
    failures.push({ code: "CATEGORY_NEEDS_REVIEW", message: `Category confidence ${primary.confidence} is below ${config.taxonomy.autoAcceptThreshold()} and has not been accepted` });
  }
  const low = review.entities?.lowConfidenceFields ?? [];
  if (!review.entities) failures.push({ code: "ENTITIES_MISSING", message: "Entity extraction has not run" });
  else if (low.length) failures.push({ code: "ENTITIES_NEED_REVIEW", message: `Low-confidence entities need confirmation: ${low.join(", ")}` });
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

export async function publishReview(reviewId: string, ctx: AuditContext, trigger: "admin" | "auto" | "csv" = "admin"): Promise<PublishResult> {
  const before = await db.normalizedReview.findUniqueOrThrow({ where: { id: reviewId } });
  const failures = await evaluateQa(reviewId);
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

/** Publish cycle: publishes QA-passing QUEUED reviews when AUTO_PUBLISH_ENABLED is on. */
export async function runPublishCycle(ctx: AuditContext, limit = 100) {
  if (!config.ingest.autoPublish()) return { enabled: false, attempted: 0, published: 0, failed: 0 };
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
  return { enabled: true, attempted: queued.length, published, failed };
}
