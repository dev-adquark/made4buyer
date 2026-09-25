import type { Prisma } from "@prisma/client";
import { cache } from "react";
import { db } from "@/lib/db";
import { publicImageUrl } from "@/lib/pipeline/images";
import { CATEGORIES } from "@/lib/taxonomy/definitions";

/** Public read models. Only PUBLISHED reviews are ever returned. */

export const BRAND_PAGE_MIN_REVIEWS = 2;
export const TRENDING_MIN_VIEWS = 5;

export const VERIFIED_LINK = { isActive: true, verificationStatus: "VERIFIED_OK", offerMatch: { matchStatus: "MATCHED" } } satisfies Prisma.AffiliateLinkWhereInput;

export const cardSelect = {
  id: true,
  slug: true,
  canonicalTitle: true,
  productName: true,
  brand: true,
  summary: true,
  categorySlug: true,
  subcategorySlug: true,
  publishedAt: true,
  images: { where: { isPrimary: true }, take: 1, select: { sourceType: true, sourceUrl: true, cdnUrl: true, licenseState: true, width: true, height: true } },
  // Only a VERIFIED_OK link on a matched offer counts as a verified offer.
  affiliateLinks: { where: VERIFIED_LINK, take: 1, select: { id: true } },
} satisfies Prisma.NormalizedReviewSelect;

export type ReviewCard = Prisma.NormalizedReviewGetPayload<{ select: typeof cardSelect }>;

export function cardImage(r: ReviewCard) {
  return publicImageUrl(r.images[0], r.categorySlug);
}

export const categoryCounts = cache(async () => {
  const rows = await db.normalizedReview.groupBy({ by: ["categorySlug"], where: { status: "PUBLISHED", categorySlug: { not: null } }, _count: { _all: true } });
  const counts = new Map(rows.map((r) => [r.categorySlug!, r._count._all]));
  return CATEGORIES.map((c) => ({ slug: c.slug, name: c.name, description: c.description, count: counts.get(c.slug) ?? 0 }));
});

export async function latestReviews(take = 9) {
  return db.normalizedReview.findMany({ where: { status: "PUBLISHED" }, orderBy: { publishedAt: "desc" }, take, select: cardSelect });
}

/** Related reviews: same subcategory first, then same category, then same brand. Deterministic order. */
export async function relatedReviews(review: { id: string; categorySlug: string | null; subcategorySlug: string | null; brandSlug: string | null }, take = 4) {
  const out: ReviewCard[] = [];
  const seen = new Set([review.id]);
  const tiers: Prisma.NormalizedReviewWhereInput[] = [];
  if (review.subcategorySlug) tiers.push({ subcategorySlug: review.subcategorySlug });
  if (review.categorySlug) tiers.push({ categorySlug: review.categorySlug });
  if (review.brandSlug) tiers.push({ brandSlug: review.brandSlug });
  for (const where of tiers) {
    if (out.length >= take) break;
    const rows = await db.normalizedReview.findMany({ where: { status: "PUBLISHED", id: { notIn: [...seen] }, ...where }, orderBy: [{ publishedAt: "desc" }, { id: "asc" }], take: take - out.length, select: cardSelect });
    for (const r of rows) {
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}

export async function brandPageEligible(brandSlug: string | null | undefined): Promise<{ eligible: boolean; count: number }> {
  if (!brandSlug) return { eligible: false, count: 0 };
  const count = await db.normalizedReview.count({ where: { status: "PUBLISHED", brandSlug } });
  return { eligible: count >= BRAND_PAGE_MIN_REVIEWS, count };
}

export async function eligibleBrands() {
  const rows = await db.normalizedReview.groupBy({ by: ["brandSlug"], where: { status: "PUBLISHED", brandSlug: { not: null } }, _count: { _all: true }, _max: { updatedAt: true } });
  return rows.filter((r) => r._count._all >= BRAND_PAGE_MIN_REVIEWS).map((r) => ({ slug: r.brandSlug!, count: r._count._all, updatedAt: r._max.updatedAt }));
}

export async function searchReviews(q: string, take = 30) {
  const terms = q.split(/\s+/).filter((t) => t.length >= 2).slice(0, 6);
  if (!terms.length) return [];
  const categorySlugs = CATEGORIES.filter((c) => terms.some((t) => c.name.toLowerCase().includes(t.toLowerCase()) || c.aliases.includes(t.toLowerCase()))).map((c) => c.slug);
  const rows = await db.normalizedReview.findMany({
    where: {
      status: "PUBLISHED",
      AND: terms.map((t) => ({
        OR: [
          { canonicalTitle: { contains: t, mode: "insensitive" as const } },
          { productName: { contains: t, mode: "insensitive" as const } },
          { brand: { contains: t, mode: "insensitive" as const } },
          { summary: { contains: t, mode: "insensitive" as const } },
          ...(categorySlugs.length ? [{ categorySlug: { in: categorySlugs } }] : []),
        ],
      })),
    },
    orderBy: { publishedAt: "desc" },
    take: 100,
    select: cardSelect,
  });
  // Rank: product/brand hits above title hits above summary-only hits.
  const lower = terms.map((t) => t.toLowerCase());
  const score = (r: ReviewCard) =>
    lower.reduce((n, t) => n + (r.productName.toLowerCase().includes(t) ? 4 : 0) + ((r.brand ?? "").toLowerCase().includes(t) ? 3 : 0) + (r.canonicalTitle.toLowerCase().includes(t) ? 2 : 0) + (r.summary.toLowerCase().includes(t) ? 1 : 0), 0);
  return rows.sort((a, b) => score(b) - score(a)).slice(0, take);
}

export function hasVerifiedOffer(r: ReviewCard): boolean {
  return r.affiliateLinks.length > 0;
}

export async function publishedReviews(page: number, pageSize = 24) {
  const [total, rows] = await Promise.all([
    db.normalizedReview.count({ where: { status: "PUBLISHED" } }),
    db.normalizedReview.findMany({ where: { status: "PUBLISHED" }, orderBy: [{ publishedAt: "desc" }, { id: "asc" }], skip: (page - 1) * pageSize, take: pageSize, select: cardSelect }),
  ]);
  return { total, rows, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Published reviews that currently have a verified offer, best-verified first. */
export async function reviewsWithDeals(take = 24, categorySlug?: string) {
  return db.normalizedReview.findMany({
    where: { status: "PUBLISHED", ...(categorySlug ? { categorySlug } : {}), affiliateLinks: { some: VERIFIED_LINK } },
    orderBy: [{ publishedAt: "desc" }, { id: "asc" }],
    take,
    select: cardSelect,
  });
}

/**
 * Trending = most real page views of published review pages in the last `days` days.
 * Reviews below TRENDING_MIN_VIEWS are excluded so a single visit never "trends".
 */
export async function trendingReviews(days = 7, take = 6) {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db.analyticsEvent.groupBy({
    by: ["path"],
    where: { event: "page_view", createdAt: { gte: since }, path: { startsWith: "/review/" } },
    _count: { _all: true },
    orderBy: { _count: { path: "desc" } },
    take: 50,
  });
  const ranked = rows.filter((r) => r.path && r._count._all >= TRENDING_MIN_VIEWS).map((r) => ({ slug: r.path!.slice("/review/".length), views: r._count._all }));
  if (!ranked.length) return [];
  const reviews = await db.normalizedReview.findMany({ where: { status: "PUBLISHED", slug: { in: ranked.map((r) => r.slug) } }, select: cardSelect });
  const bySlug = new Map(reviews.map((r) => [r.slug, r]));
  return ranked.flatMap((r) => (bySlug.has(r.slug) ? [{ review: bySlug.get(r.slug)!, views: r.views }] : [])).slice(0, take);
}

export type Suggestion = { slug: string; title: string; productName: string; brand: string | null; categorySlug: string | null; image: string; verifiedOffer: boolean };

/** Instant search suggestions (published reviews only). */
export async function suggest(q: string, take = 6): Promise<Suggestion[]> {
  const rows = await searchReviews(q, take);
  return rows.map((r) => ({ slug: r.slug, title: r.canonicalTitle, productName: r.productName, brand: r.brand, categorySlug: r.categorySlug, image: cardImage(r).url, verifiedOffer: hasVerifiedOffer(r) }));
}
