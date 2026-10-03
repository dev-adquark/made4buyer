import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { recordFailure } from "@/lib/pipeline/failures";

const MONTH_MS = 30.44 * 24 * 3_600_000;

/**
 * Flags published content that is past its freshness window as CONTENT_STALE (Admin → Failures).
 * Nothing is unpublished or edited automatically: an editor decides whether to replace, refresh
 * or retire the page. Flags clear themselves once the content is fresh again or no longer live.
 */
export async function runStaleContentDetection(trigger: string) {
  const now = Date.now();
  const reviewCutoff = new Date(now - config.freshness.reviewMonths() * MONTH_MS);
  const guideCutoff = new Date(now - config.freshness.guideMonths() * MONTH_MS);
  const stale = await db.normalizedReview.findMany({
    where: {
      status: "PUBLISHED",
      OR: [
        { kind: "REVIEW", sourcePublishedAt: { lt: reviewCutoff } },
        { kind: "AI_GUIDE", publishedAt: { lt: guideCutoff } },
      ],
    },
    select: { id: true, kind: true, slug: true, sourcePublishedAt: true, publishedAt: true },
    take: 500,
  });
  for (const r of stale) {
    const since = r.kind === "REVIEW" ? r.sourcePublishedAt : r.publishedAt;
    const months = since ? Math.floor((now - since.getTime()) / MONTH_MS) : 0;
    const message = r.kind === "REVIEW" ? `Source review is ${months} months old: check for a newer review of this product, or unpublish /review/${r.slug}` : `AI-assisted guide published ${months} months ago: refresh it or unpublish /review/${r.slug}`;
    await recordFailure({ stage: "REVALIDATION", code: "CONTENT_STALE", message, entityType: "normalized_review", entityId: r.id, normalizedReviewId: r.id, retryable: false });
  }
  const resolved = await db.pipelineFailure.updateMany({
    where: { errorCode: "CONTENT_STALE", resolvedAt: null, entityId: { notIn: stale.map((r) => r.id) } },
    data: { resolvedAt: new Date(), nextRetryAt: null },
  });
  return { status: "OK", trigger, flagged: stale.length, cleared: resolved.count };
}
