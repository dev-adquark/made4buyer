import { db } from "@/lib/db";
import { publicImageUrl, relevantImage } from "@/lib/pipeline/images";
import { cachedCategoryPhotosForCheck } from "@/lib/public/category-images";
import { officialDeals, recentlyVerifiedPrices } from "@/lib/public/deals";
import { CATEGORIES } from "@/lib/taxonomy/definitions";
import { storedCardImage, type DealCardImage } from "./deal-card-image";
import { INTEGRITY_PREFIX, NOT_EXACT_REASON } from "./integrity";
import { PRODUCT_IMAGE_TYPES } from "./provenance";

/**
 * Admin → Images "Image slots": every image slot the public design gives, per entity, in the same
 * buckets as the production audit (scratchpad audit.ts):
 *
 *   exactOfficial     the brand's own photo of the exact product (deal cards)
 *   retailer          a retailer page's own photo of the exact, identity-matched product (deal cards)
 *   internal          our verified exact-product ImageAsset (Commons / licensed source photo)
 *   pexels            a labelled illustrative Pexels photo (product type, or the topic for guides)
 *   categoryFallback  our neutral category image on a deal card / a category feature without its photo
 *   missing           a slot showing our placeholder SVG on a review / guide card, or nothing at all
 *   broken            the image-integrity job found the image no longer loads (the slot already shows the next fallback)
 *   mismatched        an image found not to be this product's (Commons group shot, stock photo off-topic, a stored card photo of another product / type)
 */

export type SlotBuckets = { required: number; exactOfficial: number; retailer: number; internal: number; pexels: number; categoryFallback: number; missing: number; broken: number; mismatched: number };
export type SlotCounts = { reviews: SlotBuckets; deals: SlotBuckets; categoryFeatures: SlotBuckets; total: SlotBuckets };

export const emptyBuckets = (): SlotBuckets => ({ required: 0, exactOfficial: 0, retailer: 0, internal: 0, pexels: 0, categoryFallback: 0, missing: 0, broken: 0, mismatched: 0 });

/** Pure: one deal-card image → its bucket. */
export function dealBucket(img: DealCardImage | null | undefined): keyof SlotBuckets {
  if (!img || !img.src) return "missing";
  switch (img.kind) {
    case "official":
      return "exactOfficial";
    case "retailer":
      return "retailer";
    case "internal":
      return "internal";
    case "illustrative":
      return "pexels";
    default:
      return "categoryFallback";
  }
}

/** Pure: a review card's shown image → its bucket (what /review cards render). */
export function reviewBucket(shown: { url: string; isFallback: boolean }, asset: { sourceType: string; imageType: string | null } | null): keyof SlotBuckets {
  if (shown.isFallback || shown.url.startsWith("/placeholders/")) return "missing";
  if (asset?.sourceType === "ENRICHMENT_SERVICE") return "pexels";
  if (asset?.imageType && PRODUCT_IMAGE_TYPES.has(asset.imageType)) return asset.imageType === "official-product" ? "exactOfficial" : asset.imageType === "retailer-product" ? "retailer" : "internal";
  return "internal";
}

function add(t: SlotBuckets, b: SlotBuckets) {
  for (const k of Object.keys(t) as Array<keyof SlotBuckets>) t[k] += b[k];
}

export async function loadImageSlotCounts(now = Date.now()): Promise<SlotCounts> {
  const reviews = emptyBuckets();
  const rows = await db.normalizedReview.findMany({
    where: { status: "PUBLISHED" },
    select: { productName: true, canonicalTitle: true, categorySlug: true, subcategorySlug: true, kind: true, contentEntities: { where: { role: "PRIMARY" }, select: { id: true }, take: 1 }, images: { where: { isPrimary: true }, take: 1, select: { sourceType: true, sourceUrl: true, cdnUrl: true, licenseState: true, enrichmentStatus: true, failureReason: true, imageType: true, altText: true, subject: true, searchQuery: true } } },
  });
  for (const r of rows) {
    reviews.required++;
    const a = r.images[0] ?? null;
    const single = r.kind === "REVIEW" || r.contentEntities.length > 0;
    const asset = relevantImage(a, { productName: r.productName, title: r.canonicalTitle, categorySlug: r.categorySlug, subcategorySlug: r.subcategorySlug, singleProduct: single });
    reviews[reviewBucket(publicImageUrl(asset, r.categorySlug), asset)]++;
    if (a && a.enrichmentStatus === "FAILED" && (a.failureReason ?? "").startsWith(NOT_EXACT_REASON)) reviews.mismatched++;
    else if (a && a.enrichmentStatus === "FAILED" && (a.failureReason ?? "").startsWith(INTEGRITY_PREFIX)) reviews.broken++;
    else if (a && !asset) reviews.mismatched++; // a stored stock photo that fails today's relevance rule
  }

  const deals = emptyBuckets();
  const [od, prices] = await Promise.all([officialDeals(now).catch(() => ({ drops: [], codes: [], checkedAt: null })), recentlyVerifiedPrices(now).catch(() => [])]);
  for (const d of [...od.drops, ...prices]) {
    deals.required++;
    deals[dealBucket(d.image)]++;
  }
  // Broken / mismatched among live commerce products (their cards already show the next fallback).
  const products = await db.$queryRaw<Array<{ id: string; name: string; data: unknown; categories: string[] | null }>>`
    SELECT p.id, p.name, p.data, b.categories FROM "commerce_products" p LEFT JOIN "commerce_brands" b ON b.id = p."brandId"
    WHERE jsonb_typeof(p."data") = 'object' AND (jsonb_exists(p."data", 'brokenImages') OR jsonb_exists(p."data", 'cardImage'))
      AND EXISTS (SELECT 1 FROM "commerce_offers" o WHERE o."productId" = p.id AND o."observedAt" > ${new Date(now - 48 * 3_600_000)})`;
  for (const p of products) {
    const data = (p.data ?? {}) as { brokenImages?: Record<string, string>; cardImage?: unknown };
    if (data.brokenImages && Object.keys(data.brokenImages).length) deals.broken++;
    if (data.cardImage && !storedCardImage(p, p.categories ?? [])) deals.mismatched++;
  }

  const categoryFeatures = emptyBuckets();
  const photos = await cachedCategoryPhotosForCheck(CATEGORIES.map((c) => c.slug));
  const known = Object.keys(photos).length > 0;
  for (const c of CATEGORIES) {
    categoryFeatures.required++;
    // A category photo is the intended content of a category feature; without one the panel shows its category fallback.
    if (known && photos[c.slug]) categoryFeatures.pexels++;
    else categoryFeatures.categoryFallback++;
  }

  const total = emptyBuckets();
  add(total, reviews);
  add(total, deals);
  add(total, categoryFeatures);
  return { reviews, deals, categoryFeatures, total };
}
