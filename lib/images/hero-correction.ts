import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { runImageBackfill, type ImageBackfillResult } from "@/lib/jobs/image-backfill";
import { persistPageRenderModel } from "@/lib/pipeline/render-model";
import { revalidateReviewPaths } from "@/lib/pipeline/revalidate-paths";
import { loadSourceContent, runImageStage } from "@/lib/pipeline/stages";
import { NOT_EXACT_REASON } from "./integrity";

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

/** When the hero rules last changed: anything checked earlier is re-checked on the next run. */
export const IMAGE_RULES_CHANGED_AT = new Date(process.env.IMAGE_RULES_CHANGED_AT || "2026-10-06T09:45:00Z");

const SINGLE_PRODUCT: Prisma.NormalizedReviewWhereInput = { OR: [{ kind: "REVIEW" }, { contentEntities: { some: { role: "PRIMARY" } } }] };

export async function runHeroCorrection(trigger: string, opts: { limit?: number } = {}): Promise<HeroCorrectionResult> {
  const out: HeroCorrectionResult = { checked: 0, commons: 0, neutral: 0, other: 0, failed: 0, items: [] };
  const targets = await db.imageAsset.findMany({
    where: {
      isPrimary: true,
      OR: [
        // A stock photo that is not a checked photo of the product's type.
        // (Legacy rows have no imageType: NULL must be matched explicitly, NOT(...) would skip it.)
        { sourceType: "ENRICHMENT_SERVICE", review: SINGLE_PRODUCT, OR: [{ imageType: null }, { imageType: { not: "illustrative-product-type" } }] },
        // Any stock photo chosen before the current rules (all content kinds) is re-checked once.
        { sourceType: "ENRICHMENT_SERVICE", OR: [{ verifiedAt: null }, { verifiedAt: { lte: IMAGE_RULES_CHANGED_AT } }] },
        // A product-type photo, once a licensed photo of the exact product is known.
        { sourceType: "ENRICHMENT_SERVICE", imageType: "illustrative-product-type", review: { ...SINGLE_PRODUCT, contentEntities: { some: { role: "PRIMARY", entity: { facts: { some: { field: "image", source: "WIKIDATA" } } } } } } },
        // A Commons "product" photo the image-integrity job found is not the exact product (a group shot): replaced once a day.
        { sourceType: "WIKIMEDIA_COMMONS", enrichmentStatus: "FAILED", failureReason: { startsWith: NOT_EXACT_REASON }, updatedAt: { lte: new Date(Date.now() - 20 * 3_600_000) } },
        // A placeholder: retried for a relevant photo (Commons, then the product type) once a day.
        { sourceType: "PLACEHOLDER", review: SINGLE_PRODUCT, OR: [{ verifiedAt: null }, { verifiedAt: { lte: new Date(Date.now() - 20 * 3_600_000) } }, { verifiedAt: { lte: IMAGE_RULES_CHANGED_AT } }] },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 200,
    select: { id: true, sourceType: true, providerPhotoId: true, enrichmentStatus: true, review: true },
  });
  for (const t of targets) {
    out.checked++;
    const review = t.review;
    try {
      // A FAILED row is never "kept" over its replacement.
      const asset = await runImageStage(review, await loadSourceContent(review), { replaceExisting: t.enrichmentStatus === "FAILED" });
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
