import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { runImageBackfill, type ImageBackfillResult } from "@/lib/jobs/image-backfill";
import { persistPageRenderModel } from "@/lib/pipeline/render-model";
import { revalidateReviewPaths } from "@/lib/pipeline/revalidate-paths";
import { loadSourceContent, runImageStage } from "@/lib/pipeline/stages";
import { revalidateCommerce } from "@/lib/commerce/revalidate";
import { runDealCardImages, type DealCardImagesResult } from "./deal-card-images";
import { NOT_EXACT_REASON } from "./integrity";
import { exactImagesFromProducts } from "./review-exact-image";
import { runOfficialProductUrlSearch, type OfficialUrlSearchResult } from "./official-product-urls";
import { config } from "@/lib/config";
import { commerceEngineOn } from "@/lib/commerce/admin-actions";

/**
 * Hero correction, run first by the enrich-images job. Finds pages whose primary image can be
 * better and re-runs the image stage:
 *  - a keyword stock photo on a single-product page (a REVIEW, or content with a PRIMARY product link);
 *  - a representative photo once an exact product photo is known (a Wikidata image fact, or the
 *    brand's own / an identity-matched retailer's product page photo from the commerce engine);
 *  - a category photo on a single-product page (daily: a photo of its type may be found);
 *  - our placeholder graphic, on EVERY run (not once a day): with on-topic photo reuse the stock
 *    pool never runs dry, so a placeholder only remains while no provider can answer.
 *
 * Idempotent: corrected pages no longer match the query (or match again only after their gate).
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

const HOUR = 3_600_000;

/** Product entities with an identity-matched commerce product whose stored page photos qualify as exact (official / retailer). */
export async function entitiesWithExactImages(): Promise<string[]> {
  // Only products that are some page's PRIMARY product can change a hero.
  const primaries = [...new Set((await db.contentEntity.findMany({ where: { role: "PRIMARY" }, select: { productEntityId: true }, take: 5000 })).map((c) => c.productEntityId))];
  if (!primaries.length) return [];
  const rows = await db.commerceProduct.findMany({
    where: { identityStatus: "MATCHED", productEntityId: { in: primaries } },
    select: { productEntityId: true, canonicalUrl: true, data: true, name: true, identityStatus: true, brand: { select: { officialDomain: true, name: true } } },
    take: 5000,
  });
  return [...new Set(rows.filter((r) => exactImagesFromProducts([r]).length > 0).map((r) => r.productEntityId!))];
}

export async function runHeroCorrection(trigger: string, opts: { limit?: number; now?: number } = {}): Promise<HeroCorrectionResult> {
  const out: HeroCorrectionResult = { checked: 0, commons: 0, neutral: 0, other: 0, failed: 0, items: [] };
  const now = opts.now ?? Date.now();
  const exactEntities = await entitiesWithExactImages().catch(() => [] as string[]);
  const targets = await db.imageAsset.findMany({
    where: {
      isPrimary: true,
      OR: [
        // A stock photo that is not a checked photo of the product's type (or its category).
        // (Legacy rows have no imageType: NULL must be matched explicitly, NOT(...) would skip it.)
        { sourceType: "ENRICHMENT_SERVICE", review: SINGLE_PRODUCT, OR: [{ imageType: null }, { imageType: { notIn: ["illustrative-product-type", "illustrative-category"] } }] },
        // A category photo on a single-product page: once a day, a photo of its type (or the exact product) may be found.
        { sourceType: "ENRICHMENT_SERVICE", imageType: "illustrative-category", review: SINGLE_PRODUCT, OR: [{ verifiedAt: null }, { verifiedAt: { lte: new Date(now - 20 * HOUR) } }] },
        // Any image that is not the brand's own photo, once the commerce engine has the exact product's official / retailer photo.
        ...(exactEntities.length
          ? [{ OR: [{ imageType: null }, { imageType: { notIn: ["official-product", "retailer-product"] } }], review: { contentEntities: { some: { role: "PRIMARY" as const, productEntityId: { in: exactEntities } } } }, AND: [{ OR: [{ verifiedAt: null }, { verifiedAt: { lte: new Date(now - 6 * HOUR) } }] }] }]
          : []),
        // Any stock photo chosen before the current rules (all content kinds) is re-checked once.
        { sourceType: "ENRICHMENT_SERVICE", OR: [{ verifiedAt: null }, { verifiedAt: { lte: IMAGE_RULES_CHANGED_AT } }] },
        // A product-type photo, once a licensed photo of the exact product is known.
        { sourceType: "ENRICHMENT_SERVICE", imageType: { in: ["illustrative-product-type", "illustrative-category"] }, review: { ...SINGLE_PRODUCT, contentEntities: { some: { role: "PRIMARY", entity: { facts: { some: { field: "image", source: "WIKIDATA" } } } } } } },
        // A Commons "product" photo the image-integrity job found is not the exact product (a group shot): replaced once a day.
        { sourceType: "WIKIMEDIA_COMMONS", enrichmentStatus: "FAILED", failureReason: { startsWith: NOT_EXACT_REASON }, updatedAt: { lte: new Date(now - 20 * HOUR) } },
        // A placeholder (any content): retried on every run, since the stock pool never runs dry any more.
        { sourceType: "PLACEHOLDER", OR: [{ verifiedAt: null }, { verifiedAt: { lte: new Date(now - 0.5 * HOUR) } }, { verifiedAt: { lte: IMAGE_RULES_CHANGED_AT } }] },
      ],
    },
    // Placeholders first (they are the visible gaps), then the oldest.
    orderBy: [{ isFallback: "desc" }, { createdAt: "asc" }],
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

/**
 * The enrich-images job: queue official product pages for reviewed products (bounded sitemap search,
 * only when the commerce engine can crawl them), hero correction, then the regular image backfill,
 * then deal-card photos.
 */
export async function runImageBackfillWithCorrection(trigger: string, opts: { limit?: number; pauseMs?: number } = {}): Promise<ImageBackfillResult & { heroCorrection: HeroCorrectionResult; dealCards: DealCardImagesResult | null; officialPages: OfficialUrlSearchResult | null }> {
  const officialPages =
    config.apify.token() && (await commerceEngineOn().catch(() => false))
      ? await runOfficialProductUrlSearch(trigger).catch((error: unknown) => {
          log.error("official product page search failed", { stage: "IMAGE_ENRICHMENT", trigger, error: String(error) });
          return null;
        })
      : null;
  const heroCorrection = await runHeroCorrection(trigger);
  const backfill = await runImageBackfill(trigger, opts);
  // Deal / price cards without an exact photo get a labelled photo of their product type (skipped after a Pexels stop).
  const stopped = backfill.status === "RATE_LIMITED" || backfill.status === "AUTH_FAILED";
  const dealCards = stopped
    ? null
    : await runDealCardImages(trigger, { limit: 60 }).catch((error: unknown) => {
        log.error("deal card images failed", { stage: "IMAGE_ENRICHMENT", trigger, error: String(error) });
        return null;
      });
  if (dealCards?.attached) await revalidateCommerce().catch(() => undefined);
  // Without Pexels the backfill has nothing to do, but corrections still count as work done.
  if (backfill.status === "NOT_CONFIGURED" && heroCorrection.checked > 0) {
    return { ...backfill, status: "OK", reason: `${backfill.reason ?? "stock photos not configured"}; corrected ${heroCorrection.checked} single-product hero image(s)`, heroCorrection, dealCards, officialPages };
  }
  return { ...backfill, heroCorrection, dealCards, officialPages };
}
