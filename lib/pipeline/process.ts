import type { PipelineStage } from "@prisma/client";
import { db } from "@/lib/db";
import { toPipelineError } from "@/lib/errors";
import { log } from "@/lib/log";
import { recordFailure, resolveFailures } from "./failures";
import { refreshQueueStatus } from "./publish";
import { persistPageRenderModel } from "./render-model";
import { revalidateReviewPaths } from "./revalidate-paths";
import { loadSourceContent, runEntityStage, runImageStage, runOfferStage, runTaxonomyStage } from "./stages";
import type { ValidatedContent } from "./validate";

/**
 * Runs the post-normalization stages for one review, in order:
 * ENTITY_EXTRACTION → TAXONOMY → IMAGE_ENRICHMENT → OFFER_MATCHING → PAGE_RENDER, then
 * re-evaluates QA to set NEEDS_REVIEW / QUEUED. OFFER_MATCHING only reads commerce-engine offers
 * (no provider call, no link generation): retailer links stay plain unless a real affiliate
 * provider is configured in the commerce engine (lib/affiliate/provider.ts).
 * A failing stage is recorded and does not prevent independent later stages from running.
 */

export const REVIEW_STAGES = ["ENTITY_EXTRACTION", "TAXONOMY", "IMAGE_ENRICHMENT", "OFFER_MATCHING", "PAGE_RENDER"] as const satisfies readonly PipelineStage[];
export type ReviewStage = (typeof REVIEW_STAGES)[number];

export type ProcessOptions = { from?: ReviewStage; content?: ValidatedContent; skipImage?: boolean };

export type ProcessSummary = {
  reviewId: string;
  stages: Partial<Record<ReviewStage, "SUCCESS" | "FAILED" | "SKIPPED">>;
  dealStatus?: string;
  status: string;
};

export async function processReview(reviewId: string, opts: ProcessOptions = {}): Promise<ProcessSummary> {
  const startIndex = opts.from ? REVIEW_STAGES.indexOf(opts.from) : 0;
  const summary: ProcessSummary = { reviewId, stages: {}, status: "" };
  const shouldRun = (stage: ReviewStage) => REVIEW_STAGES.indexOf(stage) >= startIndex;
  let review = await db.normalizedReview.findUniqueOrThrow({ where: { id: reviewId } });
  const content = opts.content ?? (await loadSourceContent(review));

  const run = async <T>(stage: ReviewStage, fn: () => Promise<T>): Promise<T | undefined> => {
    if (!shouldRun(stage)) {
      summary.stages[stage] = "SKIPPED";
      return undefined;
    }
    try {
      const value = await fn();
      summary.stages[stage] = "SUCCESS";
      await resolveFailures({ stage, entityType: "normalized_review", entityId: reviewId, codes: ["UNEXPECTED_ERROR"] });
      return value;
    } catch (error) {
      const e = toPipelineError(error);
      summary.stages[stage] = "FAILED";
      await recordFailure({ stage, code: e.code, message: e.message, entityType: "normalized_review", entityId: reviewId, normalizedReviewId: reviewId, retryable: e.retryable });
      log.error("stage failed", { stage, reviewId, code: e.code, error: e.message });
      return undefined;
    }
  };

  await run("ENTITY_EXTRACTION", () => runEntityStage(review, content));
  review = await db.normalizedReview.findUniqueOrThrow({ where: { id: reviewId } });
  await run("TAXONOMY", () => runTaxonomyStage(review, content));
  review = await db.normalizedReview.findUniqueOrThrow({ where: { id: reviewId } });
  if (opts.skipImage) summary.stages.IMAGE_ENRICHMENT = "SKIPPED";
  else await run("IMAGE_ENRICHMENT", () => runImageStage(review, content));

  if (shouldRun("OFFER_MATCHING")) {
    const offers = await run("OFFER_MATCHING", () => runOfferStage(reviewId));
    summary.dealStatus = offers?.status;
  }

  const status = await refreshQueueStatus(reviewId);
  summary.status = status;
  await run("PAGE_RENDER", async () => {
    const r = await db.normalizedReview.findUniqueOrThrow({ where: { id: reviewId } });
    if (r.status === "PUBLISHED") {
      await persistPageRenderModel(reviewId);
      revalidateReviewPaths(r);
    }
  });
  log.info("review processed", { stage: "PAGE_RENDER", reviewId, summary });
  return summary;
}
