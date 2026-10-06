import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { runImageBackfill, type ImageBackfillResult } from "@/lib/jobs/image-backfill";
import { persistPageRenderModel } from "@/lib/pipeline/render-model";
import { revalidateReviewPaths } from "@/lib/pipeline/revalidate-paths";
import { loadSourceContent, runImageStage } from "@/lib/pipeline/stages";

/**
 * Hero correction, run first by the enrich-images job. Finds single-product pages (a REVIEW, or
 * content with a PRIMARY product link) whose primary image is a keyword stock photo, or a
 * neutral placeholder whose product now has a Wikidata image fact, and re-runs the image stage
 * so each gets a licensed photo of the exact product or a neutral category image.
 *
 * Needs no stock-photo provider (it never calls one), so it also runs where Pexels is not
 * configured. Idempotent: corrected pages no longer match the query.
 */
export type HeroCorrectionResult = {
  checked: number;
  commons: number;
  neutral: number;
  other: number;
  failed: number;
  items: Array<{ slug: string; from: string; to: string }>;
};

const SINGLE_PRODUCT: Prisma.NormalizedReviewWhereInput = { OR: [{ kind: "REVIEW" }, { contentEntities: { some: { role: "PRIMARY" } } }] };

export async function runHeroCorrection(trigger: string, opts: { limit?: number } = {}): Promise<HeroCorrectionResult> {
  const out: HeroCorrectionResult = { checked: 0, commons: 0, neutral: 0, other: 0, failed: 0, items: [] };
  const targets = await db.imageAsset.findMany({
    where: {
      isPrimary: true,
      OR: [
        { sourceType: "ENRICHMENT_SERVICE", review: SINGLE_PRODUCT },
        { sourceType: "PLACEHOLDER", review: { ...SINGLE_PRODUCT, contentEntities: { some: { role: "PRIMARY", entity: { facts: { some: { field: "image", source: "WIKIDATA" } } } } } } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 200,
    select: { id: true, sourceType: true, providerPhotoId: true, review: true },
  });
  for (const t of targets) {
    out.checked++;
    const review = t.review;
    try {
      const asset = await runImageStage(review, await loadSourceContent(review));
      if (!asset) {
        out.failed++;
        continue;
      }
      if (asset.sourceType === "WIKIMEDIA_COMMONS") out.commons++;
      else if (asset.isFallback) out.neutral++;
      else out.other++;
      if (asset.id !== t.id) {
        out.items.push({ slug: review.slug, from: t.providerPhotoId ?? t.sourceType, to: asset.imageType ?? asset.sourceType });
        // Live pages show the corrected image straight away.
        if (review.status === "PUBLISHED") {
          await persistPageRenderModel(review.id);
          revalidateReviewPaths(review);
        }
      }
    } catch (error) {
      out.failed++;
      log.error("hero correction failed", { stage: "IMAGE_ENRICHMENT", reviewId: review.id, trigger, error: String(error) });
    }
  }
  if (out.items.length) log.info("hero images corrected", { stage: "IMAGE_ENRICHMENT", trigger, corrected: out.items.length, commons: out.commons, neutral: out.neutral });
  return out;
}

/** The enrich-images job: hero correction first, then the regular image backfill. */
export async function runImageBackfillWithCorrection(trigger: string, opts: { limit?: number; pauseMs?: number } = {}): Promise<ImageBackfillResult & { heroCorrection: HeroCorrectionResult }> {
  const heroCorrection = await runHeroCorrection(trigger);
  const backfill = await runImageBackfill(trigger, opts);
  // Without Pexels the backfill has nothing to do, but corrections still count as work done.
  if (backfill.status === "NOT_CONFIGURED" && heroCorrection.checked > 0) {
    return { ...backfill, status: "OK", reason: `${backfill.reason ?? "stock photos not configured"}; corrected ${heroCorrection.checked} single-product hero image(s)`, heroCorrection };
  }
  return { ...backfill, heroCorrection };
}
