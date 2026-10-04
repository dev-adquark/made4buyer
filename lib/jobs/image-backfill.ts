import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { probeImage } from "@/lib/pipeline/images";
import { stillShowsProduct, type PexelsSearchResult } from "@/lib/pipeline/pexels";
import { persistPageRenderModel } from "@/lib/pipeline/render-model";
import { revalidateReviewPaths } from "@/lib/pipeline/revalidate-paths";
import { imageRank, loadSourceContent, runImageStage } from "@/lib/pipeline/stages";

/**
 * enrich-images: gives every published or QA review a real, licensed image where one exists.
 *
 * - Idempotent: a review whose primary image is a working Pexels/licensed image is skipped.
 * - Broken images (URL no longer loads) are replaced; good images are never downgraded.
 * - Sequential, with one shared search cache per run, so N reviews on one topic cost one search.
 * - Stops the batch on a Pexels rate limit or auth failure and reports it; the next run resumes.
 */
export type ImageBackfillResult = {
  status: "OK" | "RATE_LIMITED" | "AUTH_FAILED" | "NOT_CONFIGURED";
  trigger: string;
  checked: number;
  skippedGood: number;
  enriched: number;
  replaced: number;
  brokenFixed: number;
  fallback: number;
  failed: number;
  reason?: string;
  items: Array<{ slug: string; outcome: string; subject?: string | null; photo?: string | null; query?: string | null }>;
};

const ELIGIBLE = ["PUBLISHED", "QUEUED", "NEEDS_REVIEW"] as const;

export async function runImageBackfill(trigger: string, opts: { limit?: number; pauseMs?: number } = {}): Promise<ImageBackfillResult> {
  const out: ImageBackfillResult = { status: "OK", trigger, checked: 0, skippedGood: 0, enriched: 0, replaced: 0, brokenFixed: 0, fallback: 0, failed: 0, items: [] };
  const { pexelsConfigured } = await import("@/lib/pipeline/pexels");
  if (!pexelsConfigured()) return { ...out, status: "NOT_CONFIGURED", reason: "PEXELS_API_KEY not configured" };

  const reviews = await db.normalizedReview.findMany({
    where: { status: { in: [...ELIGIBLE] } },
    // Published pages first, newest first.
    orderBy: [{ status: "asc" }, { publishedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: opts.limit ?? 60,
    include: { images: { where: { isPrimary: true }, take: 1 } },
  });
  reviews.sort((a, b) => Number(b.status === "PUBLISHED") - Number(a.status === "PUBLISHED"));

  const cache = new Map<string, PexelsSearchResult>();
  const used = new Set((await db.imageAsset.findMany({ where: { isPrimary: true, providerPhotoId: { not: null } }, select: { providerPhotoId: true } })).map((a) => a.providerPhotoId!));

  for (const review of reviews) {
    out.checked++;
    const current = review.images[0];
    const working = current && !current.isFallback && current.sourceUrl ? (await probeImage(current.sourceUrl)).ok : false;
    // A Pexels "product" photo that no longer passes the relevance rule is re-chosen.
    const misidentified = Boolean(current?.subject === "PRODUCT" && current.providerPhotoId?.startsWith("pexels:") && !stillShowsProduct(current.altText ?? "", review.productName, review.brand));
    // Already has a working licensed image (Pexels or a licensed feed image): nothing to do.
    if (working && !misidentified && current.licenseState !== "UNVERIFIED" && imageRank(current) > 0) {
      out.skippedGood++;
      out.items.push({ slug: review.slug, outcome: "kept", subject: current.subject, photo: current.providerPhotoId });
      continue;
    }
    const broken = Boolean(current && !current.isFallback && current.sourceUrl && !working) || misidentified;
    if (current?.providerPhotoId) used.delete(current.providerPhotoId);
    try {
      const content = await loadSourceContent(review);
      const asset = await runImageStage(review, content, { excludePhotoIds: used, searchCache: cache, replaceExisting: broken });
      const stopped = asset && "providerStatus" in asset ? asset.providerStatus : undefined;
      if (stopped === "RATE_LIMITED" || stopped === "AUTH_FAILED") {
        out.status = stopped;
        out.reason = asset?.failureReason ?? undefined;
        out.items.push({ slug: review.slug, outcome: `stopped: ${stopped}` });
        break;
      }
      if (!asset) {
        out.failed++;
        out.items.push({ slug: review.slug, outcome: "failed" });
        continue;
      }
      if (asset.providerPhotoId) used.add(asset.providerPhotoId);
      if (asset.isFallback) out.fallback++;
      else {
        out.enriched++;
        if (current && !current.isFallback) out.replaced++;
        if (broken) out.brokenFixed++;
      }
      out.items.push({ slug: review.slug, outcome: asset.isFallback ? `fallback: ${asset.failureReason ?? ""}`.slice(0, 160) : "enriched", subject: asset.subject, photo: asset.providerPhotoId, query: asset.searchQuery });
      // Live pages pick up the new image straight away.
      if (review.status === "PUBLISHED" && asset.id !== current?.id) {
        await persistPageRenderModel(review.id);
        revalidateReviewPaths(review);
      }
    } catch (error) {
      out.failed++;
      out.items.push({ slug: review.slug, outcome: `failed: ${String(error).slice(0, 160)}` });
      log.error("image backfill failed", { stage: "IMAGE_ENRICHMENT", reviewId: review.id, error: String(error) });
    }
    // Gentle pacing between reviews (Pexels allows 200 requests/hour by default).
    if (opts.pauseMs) await new Promise((r) => setTimeout(r, opts.pauseMs));
  }
  return out;
}
