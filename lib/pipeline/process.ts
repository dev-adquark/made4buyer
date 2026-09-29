import type { PipelineStage } from "@prisma/client";
import { db } from "@/lib/db";
import { toPipelineError } from "@/lib/errors";
import { log } from "@/lib/log";
import { recordFailure, resolveFailures } from "./failures";
import { refreshQueueStatus } from "./publish";
import { persistPageRenderModel } from "./render-model";
import { revalidateReviewPaths } from "./revalidate-paths";
import {
  loadSourceContent,
  runAffiliateStage,
  runEntityStage,
  runImageStage,
  runOfferStage,
  runTaxonomyStage,
  runVerificationStage,
  type OfferStageResult,
} from "./stages";
import type { ValidatedContent } from "./validate";

/**
 * Runs the post-normalization stages for one review, in order:
 * ENTITY_EXTRACTION → TAXONOMY → IMAGE_ENRICHMENT → OFFER_MATCHING → AFFILIATE_LINK →
 * LINK_VERIFICATION → PAGE_RENDER, then re-evaluates QA to set NEEDS_REVIEW / QUEUED.
 * A failing stage is recorded and does not prevent independent later stages from running.
 */

export const REVIEW_STAGES = ["ENTITY_EXTRACTION", "TAXONOMY", "IMAGE_ENRICHMENT", "OFFER_MATCHING", "AFFILIATE_LINK", "LINK_VERIFICATION", "PAGE_RENDER"] as const satisfies readonly PipelineStage[];
export type ReviewStage = (typeof REVIEW_STAGES)[number];

export type ProcessOptions = { from?: ReviewStage; bypassOfferCache?: boolean; content?: ValidatedContent; skipImage?: boolean };

export type ProcessSummary = {
  reviewId: string;
  stages: Partial<Record<ReviewStage, "SUCCESS" | "FAILED" | "SKIPPED">>;
  dealStatus?: string;
  linksVerified: number;
  status: string;
};

export async function processReview(reviewId: string, opts: ProcessOptions = {}): Promise<ProcessSummary> {
  const startIndex = opts.from ? REVIEW_STAGES.indexOf(opts.from) : 0;
  const summary: ProcessSummary = { reviewId, stages: {}, linksVerified: 0, status: "" };
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

  let offers: OfferStageResult | undefined;
  if (shouldRun("OFFER_MATCHING")) {
    offers = await run("OFFER_MATCHING", () => runOfferStage(reviewId, { bypassCache: opts.bypassOfferCache }));
    summary.dealStatus = offers?.status;
  }

  if (shouldRun("AFFILIATE_LINK")) {
    // When resuming at AFFILIATE_LINK the current viable matches are used.
    const selected =
      offers?.selected ??
      (await db.sovrnOfferMatch.findMany({ where: { normalizedReviewId: reviewId, matchStatus: "MATCHED" }, orderBy: { rank: "asc" } })).map((m) => ({
        matchId: m.id,
        isBest: m.isBestOffer,
        ranked: {
          offer: { offerId: m.offerId, title: m.title, offerUrl: m.offerUrl, providerAffiliateUrl: m.providerAffiliateUrl ?? undefined, merchantName: m.merchantName ?? undefined },
          breakdown: m.scoreBreakdown as never,
          viable: true,
        },
      }));
    await run("AFFILIATE_LINK", () => runAffiliateStage(reviewId, selected));
  }

  await run("LINK_VERIFICATION", async () => {
    const links = await db.affiliateLink.findMany({ where: { normalizedReviewId: reviewId, isActive: true } });
    const results = await runVerificationStage(links);
    summary.linksVerified = results.filter((r) => r.outcome.status === "VERIFIED_OK").length;
    return results;
  });

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
