import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { config } from "@/lib/config";
import { PRODUCT_IMAGE_TYPES } from "./provenance";

/**
 * Admin → Images: what every published page's hero image is, in buyer-facing terms.
 *
 *  missing            published page with no primary image row at all
 *  failed             a remote image marked FAILED (broken URL, or not the exact product): the page shows the category image
 *  categoryFallback   a remote image the public site replaces with the category image (FAILED, or licence unverified and withheld)
 *  placeholder        the stored hero IS our neutral category image
 *  verifiedExact      claims the exact product, licence verified, confidence ≥ LOW_CONFIDENCE, not failed
 *  lowConfidence      claims the exact product with confidence < LOW_CONFIDENCE (or none recorded)
 *  illustrative       a labelled illustrative photo (product type or topic)
 */
export const LOW_CONFIDENCE = 0.85;

export type ImageRow = { sourceType: string; imageType: string | null; licenseState: string; enrichmentStatus: string; matchConfidence: number | null };
export type ImageClass = "failed" | "placeholder" | "verifiedExact" | "lowConfidence" | "illustrative" | "other";
export type ImageCounts = { published: number; missing: number; failed: number; lowConfidence: number; verifiedExact: number; illustrative: number; categoryFallback: number; placeholder: number; other: number };

/** The single bucket an image belongs to (counts add up to the published pages that have an image). */
export function classifyImage(a: ImageRow): ImageClass {
  if (a.sourceType === "PLACEHOLDER" || a.imageType === "neutral-category") return "placeholder";
  if (a.enrichmentStatus === "FAILED") return "failed";
  if (a.imageType?.startsWith("illustrative-")) return "illustrative";
  if (a.imageType && PRODUCT_IMAGE_TYPES.has(a.imageType)) {
    return a.matchConfidence != null && a.matchConfidence >= LOW_CONFIDENCE && a.licenseState === "VERIFIED" ? "verifiedExact" : "lowConfidence";
  }
  return "other";
}

/** Whether the public site shows the category image instead of this (remote) image. */
export function showsCategoryFallback(a: ImageRow, requireLicense = config.images.requireLicense()): boolean {
  if (a.sourceType === "PLACEHOLDER") return false;
  return a.enrichmentStatus === "FAILED" || (requireLicense && a.licenseState === "UNVERIFIED");
}

export function countImages(rows: ImageRow[], published: number, requireLicense?: boolean): ImageCounts {
  const out: ImageCounts = { published, missing: Math.max(0, published - rows.length), failed: 0, lowConfidence: 0, verifiedExact: 0, illustrative: 0, categoryFallback: 0, placeholder: 0, other: 0 };
  for (const r of rows) {
    out[classifyImage(r)]++;
    if (showsCategoryFallback(r, requireLicense)) out.categoryFallback++;
  }
  return out;
}

const PUBLISHED: Prisma.NormalizedReviewWhereInput = { status: "PUBLISHED" };

/** Counts over published pages' primary images. */
export async function loadImageCounts(): Promise<ImageCounts> {
  const [published, groups] = await Promise.all([
    db.normalizedReview.count({ where: PUBLISHED }),
    db.imageAsset.groupBy({
      by: ["sourceType", "imageType", "licenseState", "enrichmentStatus", "matchConfidence"],
      where: { isPrimary: true, review: PUBLISHED },
      _count: { _all: true },
    }),
  ]);
  const rows: ImageRow[] = groups.flatMap((g) => Array.from({ length: g._count._all }, () => ({ sourceType: g.sourceType, imageType: g.imageType, licenseState: g.licenseState, enrichmentStatus: g.enrichmentStatus, matchConfidence: g.matchConfidence })));
  // A review has at most one primary image, but count pages, not rows, for "missing".
  const withImage = await db.normalizedReview.count({ where: { ...PUBLISHED, images: { some: { isPrimary: true } } } });
  const counts = countImages(rows, published);
  return { ...counts, missing: published - withImage };
}

/** Prisma filter for one bucket (Admin → Images list). */
export function imageFilterWhere(filter: string | undefined): Prisma.ImageAssetWhereInput {
  const product = { imageType: { in: [...PRODUCT_IMAGE_TYPES] } };
  switch (filter) {
    case "failed":
      return { sourceType: { not: "PLACEHOLDER" }, enrichmentStatus: "FAILED" };
    case "low":
      return { ...product, enrichmentStatus: { not: "FAILED" }, OR: [{ matchConfidence: null }, { matchConfidence: { lt: LOW_CONFIDENCE } }, { licenseState: { not: "VERIFIED" } }] };
    case "exact":
      return { ...product, enrichmentStatus: { not: "FAILED" }, matchConfidence: { gte: LOW_CONFIDENCE }, licenseState: "VERIFIED" };
    case "illustrative":
      return { imageType: { startsWith: "illustrative-" }, sourceType: { not: "PLACEHOLDER" }, enrichmentStatus: { not: "FAILED" } };
    case "fallback":
      return { sourceType: { not: "PLACEHOLDER" }, OR: [{ enrichmentStatus: "FAILED" }, ...(config.images.requireLicense() ? [{ licenseState: "UNVERIFIED" as const }] : [])] };
    case "placeholder":
      return { OR: [{ sourceType: "PLACEHOLDER" }, { imageType: "neutral-category" }] };
    default:
      return {};
  }
}

/** How the image was matched to the product (Commons via Wikidata: the stored fact's basis). */
export async function matchBasisFor(assets: Array<{ id: string; sourceType: string; sourcePageUrl: string | null; imageType: string | null }>): Promise<Map<string, string>> {
  // Wikidata image facts are keyed by their Commons file page (ImageAsset.sourcePageUrl).
  const pages = assets.filter((a) => a.sourceType === "WIKIMEDIA_COMMONS" && a.sourcePageUrl).map((a) => a.sourcePageUrl!);
  const facts = pages.length ? await db.productFact.findMany({ where: { field: "image", sourceKey: { in: pages } }, select: { sourceKey: true, matchBasis: true } }) : [];
  const byPage = new Map(facts.map((f) => [f.sourceKey, f.matchBasis]));
  return new Map(
    assets.map((a) => {
      if (a.sourceType === "WIKIMEDIA_COMMONS") return [a.id, byPage.get(a.sourcePageUrl ?? "") ?? "commons:file-title"];
      if (a.sourceType === "CONTENT_API") return [a.id, "review source's own image"];
      if (a.sourceType === "ENRICHMENT_SERVICE") return [a.id, a.imageType === "illustrative-product-type" ? "photo description names the product type" : "photo description names the topic"];
      return [a.id, "category placeholder"];
    }),
  );
}
