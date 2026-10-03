import type { Prisma } from "@prisma/client";
import { cache } from "react";
import { db } from "@/lib/db";
import { publicImageUrl } from "@/lib/pipeline/images";
import { CATEGORIES } from "@/lib/taxonomy/definitions";

/** Public read models. Only PUBLISHED reviews are ever returned. */

export const BRAND_PAGE_MIN_REVIEWS = 2;
export const TRENDING_MIN_VIEWS = 5;

/**
 * "Latest" means latest from the source: order by the source's publication date, then by when
 * we published. Old reviews ingested today never jump ahead of genuinely new ones.
 */
export const LATEST_FIRST = [{ sourcePublishedAt: { sort: "desc", nulls: "last" } }, { publishedAt: "desc" }, { id: "asc" }] satisfies Prisma.NormalizedReviewOrderByWithRelationInput[];

export const VERIFIED_LINK = { isActive: true, verificationStatus: "VERIFIED_OK", offerMatch: { matchStatus: "MATCHED" } } satisfies Prisma.AffiliateLinkWhereInput;

export const cardSelect = {
  id: true,
  slug: true,
  canonicalTitle: true,
  kind: true,
  productName: true,
  brand: true,
  brandSlug: true,
  summary: true,
  categorySlug: true,
  subcategorySlug: true,
  publishedAt: true,
  sourcePublishedAt: true,
  author: true,
  entities: { select: { source: true } },
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
  return db.normalizedReview.findMany({ where: { status: "PUBLISHED" }, orderBy: LATEST_FIRST, take, select: cardSelect });
}

/** Related reviews: same subcategory first, then same category, then same brand. Deterministic order. */
export async function relatedReviews(review: { id: string; categorySlug: string | null; subcategorySlug: string | null; brandSlug: string | null }, take = 4) {
  const out: ReviewCard[] = [];
  const seen = new Set([review.id]);
  const tiers: Prisma.NormalizedReviewWhereInput[] = [];
  if (review.subcategorySlug) tiers.push({ subcategorySlug: review.subcategorySlug });
  if (review.categorySlug) tiers.push({ categorySlug: review.categorySlug });
  if (review.brandSlug) tiers.push({ brandSlug: review.brandSlug });
  // Tiers load in parallel; taking `take` (+ overlap) from each keeps the tier-priority result identical.
  const results = await Promise.all(tiers.map((where, i) => db.normalizedReview.findMany({ where: { status: "PUBLISHED", id: { not: review.id }, ...where }, orderBy: LATEST_FIRST, take: take * (i + 1), select: cardSelect })));
  for (const rows of results)
    for (const r of rows) {
      if (out.length >= take) return out;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
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
    orderBy: LATEST_FIRST,
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
    db.normalizedReview.findMany({ where: { status: "PUBLISHED" }, orderBy: LATEST_FIRST, skip: (page - 1) * pageSize, take: pageSize, select: cardSelect }),
  ]);
  return { total, rows, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Published reviews that currently have a verified offer, best-verified first. */
export async function reviewsWithDeals(take = 24, categorySlug?: string) {
  return db.normalizedReview.findMany({
    where: { status: "PUBLISHED", ...(categorySlug ? { categorySlug } : {}), affiliateLinks: { some: VERIFIED_LINK } },
    orderBy: LATEST_FIRST,
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

export type Suggestion = { slug: string; title: string; productName: string; brand: string | null; categorySlug: string | null; image: string; verifiedOffer: boolean; kind: "REVIEW" | "AI_GUIDE" };

/** Instant search suggestions (published reviews only). */
export async function suggest(q: string, take = 6): Promise<Suggestion[]> {
  const rows = await searchReviews(q, take);
  return rows.map((r) => ({ slug: r.slug, title: r.canonicalTitle, productName: r.productName, brand: r.brand, categorySlug: r.categorySlug, image: cardImage(r).url, verifiedOffer: hasVerifiedOffer(r), kind: r.kind }));
}

export const publishedGuides = cache(async (page = 1, pageSize = 24) => {
  const where = { status: "PUBLISHED", kind: "AI_GUIDE" } satisfies Prisma.NormalizedReviewWhereInput;
  const [total, rows] = await Promise.all([
    db.normalizedReview.count({ where }),
    db.normalizedReview.findMany({ where, orderBy: LATEST_FIRST, skip: (page - 1) * pageSize, take: pageSize, select: cardSelect }),
  ]);
  return { total, rows, pages: Math.max(1, Math.ceil(total / pageSize)) };
});

export async function latestByKind(kind: "REVIEW" | "AI_GUIDE", take = 6, categorySlug?: string) {
  return db.normalizedReview.findMany({ where: { status: "PUBLISHED", kind, ...(categorySlug ? { categorySlug } : {}) }, orderBy: LATEST_FIRST, take, select: cardSelect });
}

/** One row per verified offer (VERIFIED_OK link on a matched offer) of a published review. */
export type DealRow = { linkId: string; merchant: string | null; price: number | null; currency: string | null; availability: string | null; verifiedAt: Date; isBest: boolean; review: ReviewCard };

/** Verified offers per category and the newest check, without loading full cards. */
export async function dealLedgerSummary(): Promise<{ counts: Map<string, number>; newest: Date | null }> {
  const links = await db.affiliateLink.findMany({ where: { ...VERIFIED_LINK, review: { status: "PUBLISHED" } }, select: { lastVerifiedAt: true, updatedAt: true, review: { select: { categorySlug: true } } } });
  const counts = new Map<string, number>();
  let newest: Date | null = null;
  for (const l of links) {
    if (l.review.categorySlug) counts.set(l.review.categorySlug, (counts.get(l.review.categorySlug) ?? 0) + 1);
    const at = l.lastVerifiedAt ?? l.updatedAt;
    if (!newest || at > newest) newest = at;
  }
  return { counts, newest };
}

export async function verifiedDealRows({ categorySlug, merchant, q, take = 60 }: { categorySlug?: string; merchant?: string; q?: string; take?: number } = {}): Promise<DealRow[]> {
  const terms = (q ?? "").split(/\s+/).filter((t) => t.length >= 2).slice(0, 6);
  const links = await db.affiliateLink.findMany({
    where: {
      ...VERIFIED_LINK,
      ...(merchant ? { offerMatch: { matchStatus: "MATCHED", merchantName: merchant } } : {}),
      review: {
        status: "PUBLISHED",
        ...(categorySlug ? { categorySlug } : {}),
        ...(terms.length ? { AND: terms.map((t) => ({ OR: [{ productName: { contains: t, mode: "insensitive" as const } }, { brand: { contains: t, mode: "insensitive" as const } }, { canonicalTitle: { contains: t, mode: "insensitive" as const } }] })) } : {}),
      },
    },
    orderBy: [{ lastVerifiedAt: "desc" }, { id: "asc" }],
    take,
    select: { id: true, isBest: true, lastVerifiedAt: true, updatedAt: true, offerMatch: { select: { merchantName: true, price: true, currency: true, availability: true } }, review: { select: cardSelect } },
  });
  return links.map((l) => ({
    linkId: l.id,
    merchant: l.offerMatch?.merchantName ?? null,
    price: l.offerMatch?.price ?? null,
    currency: l.offerMatch?.currency ?? null,
    availability: l.offerMatch?.availability ?? null,
    verifiedAt: l.lastVerifiedAt ?? l.updatedAt,
    isBest: l.isBest,
    review: l.review,
  }));
}

/** Merchants that currently have at least one verified offer, for the deals filter. */
export async function dealMerchants() {
  const rows = await db.sovrnOfferMatch.groupBy({
    by: ["merchantName"],
    where: { matchStatus: "MATCHED", merchantName: { not: null }, review: { status: "PUBLISHED" }, affiliateLinks: { some: { isActive: true, verificationStatus: "VERIFIED_OK" } } },
    _count: { _all: true },
  });
  return rows.map((r) => ({ name: r.merchantName!, count: r._count._all })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Published reviews that had an offer link which is no longer verified (failed re-check or
 * deactivated) and have no verified offer now. Only the last check date is public.
 */
export async function lapsedOffers(take = 12, categorySlug?: string) {
  const reviews = await db.normalizedReview.findMany({
    where: {
      status: "PUBLISHED",
      ...(categorySlug ? { categorySlug } : {}),
      affiliateLinks: { some: { OR: [{ isActive: false }, { verificationStatus: { notIn: ["VERIFIED_OK", "PENDING"] } }] }, none: VERIFIED_LINK },
    },
    orderBy: [{ dealCheckedAt: "desc" }, { id: "asc" }],
    take,
    select: { ...cardSelect, dealCheckedAt: true },
  });
  return reviews;
}

/** Real facet values for a set of published reviews, with counts. */
export async function facetCounts(where: Prisma.NormalizedReviewWhereInput) {
  const [tags, brands, subs] = await Promise.all([
    db.reviewCategoryAssignment.groupBy({ by: ["categoryTagId", "tagType"], where: { active: true, tagType: { in: ["INTENT", "PLATFORM", "PRICE_TIER"] }, review: { status: "PUBLISHED", ...where } }, _count: { _all: true } }),
    db.normalizedReview.groupBy({ by: ["brandSlug", "brand"], where: { status: "PUBLISHED", brandSlug: { not: null }, ...where }, _count: { _all: true } }),
    db.normalizedReview.groupBy({ by: ["subcategorySlug"], where: { status: "PUBLISHED", subcategorySlug: { not: null }, ...where }, _count: { _all: true } }),
  ]);
  const tagRows = tags.length ? await db.categoryTag.findMany({ where: { id: { in: tags.map((t) => t.categoryTagId) } }, select: { id: true, slug: true, name: true, sortOrder: true } }) : [];
  const byId = new Map(tagRows.map((t) => [t.id, t]));
  const of = (type: "INTENT" | "PLATFORM" | "PRICE_TIER") =>
    tags
      .filter((t) => t.tagType === type && byId.has(t.categoryTagId))
      .map((t) => ({ ...byId.get(t.categoryTagId)!, count: t._count._all }))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map(({ slug, name, count }) => ({ slug, name, count }));
  return {
    intent: of("INTENT"),
    platform: of("PLATFORM"),
    tier: of("PRICE_TIER"),
    brand: brands.map((b) => ({ slug: b.brandSlug!, name: b.brand ?? b.brandSlug!, count: b._count._all })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    sub: subs.map((s) => ({ slug: s.subcategorySlug!, count: s._count._all })),
  };
}

export type NavFeed = {
  category: string;
  latest: Array<{ slug: string; title: string; image: string; verifiedOffer: boolean }>;
  guides: Array<{ slug: string; title: string }>;
  deals: Array<{ slug: string; productName: string; merchant: string | null; price: number | null; currency: string | null }>;
  trending: Array<{ slug: string; title: string; views: number }>;
  counts: Record<string, number>;
  total: number;
};

/** Mega-menu feed for one category: everything is real published data (may be empty). */
export async function navFeed(categorySlug: string): Promise<NavFeed> {
  const [latest, guides, deals, trending, subs] = await Promise.all([
    latestByKind("REVIEW", 3, categorySlug),
    latestByKind("AI_GUIDE", 3, categorySlug),
    verifiedDealRows({ categorySlug, take: 3 }),
    trendingReviews(7, 30),
    db.normalizedReview.groupBy({ by: ["subcategorySlug"], where: { status: "PUBLISHED", categorySlug }, _count: { _all: true } }),
  ]);
  const counts: Record<string, number> = {};
  let total = 0;
  for (const s of subs) {
    total += s._count._all;
    if (s.subcategorySlug) counts[s.subcategorySlug] = s._count._all;
  }
  return {
    category: categorySlug,
    latest: latest.map((r) => ({ slug: r.slug, title: r.productName, image: cardImage(r).url, verifiedOffer: hasVerifiedOffer(r) })),
    guides: guides.map((r) => ({ slug: r.slug, title: r.canonicalTitle })),
    deals: deals.map((d) => ({ slug: d.review.slug, productName: d.review.productName, merchant: d.merchant, price: d.price, currency: d.currency })),
    trending: trending.filter((t) => t.review.categorySlug === categorySlug).slice(0, 3).map((t) => ({ slug: t.review.slug, title: t.review.productName, views: t.views })),
    counts,
    total,
  };
}

export type SearchGroups = {
  reviews: Suggestion[];
  guides: Suggestion[];
  deals: Suggestion[];
  categories: Array<{ slug: string; name: string; href: string; parent: string | null }>;
  brands: Array<{ name: string; href: string; count: number }>;
};

/** Grouped instant search across reviews, guides, deals, categories and brands. */
export async function searchGroups(q: string): Promise<SearchGroups> {
  const term = q.trim().toLowerCase();
  const rows = await searchReviews(q, 24);
  const toS = (r: ReviewCard): Suggestion => ({ slug: r.slug, title: r.canonicalTitle, productName: r.productName, brand: r.brand, categorySlug: r.categorySlug, image: cardImage(r).url, verifiedOffer: hasVerifiedOffer(r), kind: r.kind });
  const categories: SearchGroups["categories"] = [];
  for (const c of CATEGORIES) {
    if (c.name.toLowerCase().includes(term) || c.aliases.some((a) => a.includes(term))) categories.push({ slug: c.slug, name: c.name, href: `/category/${c.slug}`, parent: null });
    for (const s of c.subcategories) if (s.name.toLowerCase().includes(term)) categories.push({ slug: s.slug, name: s.name, href: `/category/${c.slug}?sub=${s.slug}`, parent: c.name });
  }
  const brandCounts = new Map<string, { name: string; slug: string | null; count: number }>();
  for (const r of rows) {
    if (!r.brand || !r.brand.toLowerCase().includes(term)) continue;
    const key = r.brandSlug ?? r.brand.toLowerCase();
    const cur = brandCounts.get(key) ?? { name: r.brand, slug: r.brandSlug, count: 0 };
    cur.count++;
    brandCounts.set(key, cur);
  }
  const eligible = new Set(brandCounts.size ? (await eligibleBrands()).map((b) => b.slug) : []);
  // A brand page exists only for brands with enough reviews; otherwise search for the brand.
  const brands = [...brandCounts.values()].slice(0, 3).map((b) => ({ name: b.name, count: b.count, href: b.slug && eligible.has(b.slug) ? `/brand/${b.slug}` : `/search?q=${encodeURIComponent(b.name)}` }));
  return {
    reviews: rows.filter((r) => r.kind === "REVIEW").slice(0, 5).map(toS),
    guides: rows.filter((r) => r.kind === "AI_GUIDE").slice(0, 3).map(toS),
    deals: rows.filter(hasVerifiedOffer).slice(0, 3).map(toS),
    categories: categories.slice(0, 4),
    brands,
  };
}

/** Two recent published products from the same category, with the facts we actually store. */
export async function comparePair() {
  const recent = await db.normalizedReview.findMany({ where: { status: "PUBLISHED", kind: "REVIEW", categorySlug: { not: null } }, orderBy: LATEST_FIRST, take: 24, select: { id: true, categorySlug: true } });
  const seen = new Map<string, string>();
  let pair: [string, string] | null = null;
  for (const r of recent) {
    const other = seen.get(r.categorySlug!);
    if (other) {
      pair = [other, r.id];
      break;
    }
    seen.set(r.categorySlug!, r.id);
  }
  if (!pair) return null;
  const rows = await db.normalizedReview.findMany({
    where: { id: { in: pair } },
    select: { ...cardSelect, entities: { select: { source: true, platform: true, deviceType: true, useCase: true, modelNumber: true } }, assignments: { where: { active: true, tagType: "PRICE_TIER", isPrimary: true }, take: 1, select: { categoryTag: { select: { name: true } } } } },
  });
  return pair.map((id) => rows.find((r) => r.id === id)!).filter(Boolean);
}

/** Stored counts shown on the trust section. Nothing here is estimated. */
export async function trustStats() {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const [published, guides, verifiedOffers, checkedThisWeek, categories] = await Promise.all([
    db.normalizedReview.count({ where: { status: "PUBLISHED", kind: "REVIEW" } }),
    db.normalizedReview.count({ where: { status: "PUBLISHED", kind: "AI_GUIDE" } }),
    db.affiliateLink.count({ where: { ...VERIFIED_LINK, review: { status: "PUBLISHED" } } }),
    db.affiliateLink.count({ where: { lastVerifiedAt: { gte: weekAgo }, review: { status: "PUBLISHED" } } }),
    categoryCounts(),
  ]);
  return { published, guides, verifiedOffers, checkedThisWeek, categoriesCovered: categories.filter((c) => c.count > 0).length };
}

/** Per-category counts of published reviews, guides and live verified offers (all stored data). */
export const categoryLedger = cache(async () => {
  const [byKind, deals] = await Promise.all([
    db.normalizedReview.groupBy({ by: ["categorySlug", "kind"], where: { status: "PUBLISHED", categorySlug: { not: null } }, _count: { _all: true } }),
    db.affiliateLink.findMany({ where: { ...VERIFIED_LINK, review: { status: "PUBLISHED" } }, select: { review: { select: { categorySlug: true } } } }),
  ]);
  return CATEGORIES.map((c) => ({
    slug: c.slug,
    name: c.name,
    description: c.description,
    reviews: byKind.find((r) => r.categorySlug === c.slug && r.kind === "REVIEW")?._count._all ?? 0,
    guides: byKind.find((r) => r.categorySlug === c.slug && r.kind === "AI_GUIDE")?._count._all ?? 0,
    deals: deals.filter((d) => d.review.categorySlug === c.slug).length,
  }));
});
