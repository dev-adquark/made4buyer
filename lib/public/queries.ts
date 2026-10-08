import type { ContentKind, Prisma } from "@prisma/client";
import { cache } from "react";
import { db } from "@/lib/db";
import { publicImageUrl, relevantImage } from "@/lib/pipeline/images";
import { entityKey } from "@/lib/entities/resolve";
import { CATEGORIES } from "@/lib/taxonomy/definitions";
import { publishedFreshOffers } from "./offers";
import { categoryFallbackPhoto, categoryPhotoSrc } from "./category-images";

/** Public read models. Only PUBLISHED reviews are ever returned. */

export const BRAND_PAGE_MIN_REVIEWS = 2;
export const TRENDING_MIN_VIEWS = 5;

/**
 * "Latest" means latest from the source: order by the source's publication date, then by when
 * we published. Old reviews ingested today never jump ahead of genuinely new ones.
 */
export const LATEST_FIRST = [{ sourcePublishedAt: { sort: "desc", nulls: "last" } }, { publishedAt: "desc" }, { id: "asc" }] satisfies Prisma.NormalizedReviewOrderByWithRelationInput[];

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
  generationMeta: true,
  entities: { select: { source: true } },
  images: { where: { isPrimary: true }, take: 1, select: { sourceType: true, sourceUrl: true, cdnUrl: true, licenseState: true, width: true, height: true, altText: true, enrichmentStatus: true, subject: true, searchQuery: true, imageType: true, attribution: true, attributionUrl: true } },
} satisfies Prisma.NormalizedReviewSelect;

export type ReviewCard = Prisma.NormalizedReviewGetPayload<{ select: typeof cardSelect }>;

export type CardImage = {
  url: string;
  /** True only when nothing but our placeholder graphic is left (no stored image, no category photo). */
  isFallback: boolean;
  /** Not the exact product (a Pexels photo of its type or category): shown with the "Representative photo" note. */
  representative: boolean;
  /** @deprecated alias of `representative`. */
  illustrative: boolean;
  /** Photo credit (Pexels photographer) for a representative photo. */
  credit: string | null;
  creditUrl: string | null;
  /** What the photo shows (its own description). */
  alt: string;
  /** Tried in order when `url` fails to load in the browser (SafeImg), before the placeholder graphic. */
  alternates: string[];
};

/** The stored image a card shows (sync, no category photo): see resolveCardImage for the full chain. */
export function cardImage(r: Pick<ReviewCard, "images" | "productName" | "canonicalTitle" | "categorySlug" | "subcategorySlug" | "kind">): CardImage {
  // Same display guard as the review page: only relevant images.
  const asset = relevantImage(r.images[0], { productName: r.productName, title: r.canonicalTitle, categorySlug: r.categorySlug, subcategorySlug: r.subcategorySlug, singleProduct: r.kind === "REVIEW" });
  const pub = publicImageUrl(asset, r.categorySlug);
  const a = asset as (ReviewCard["images"][number] & { attribution?: string | null; attributionUrl?: string | null }) | null | undefined;
  // A stock photo on a single-product card carries the small "Representative photo" note, so it is never read as the product itself.
  const representative = !pub.isFallback && r.kind === "REVIEW" && a?.subject === "ILLUSTRATIVE";
  return { ...pub, representative, illustrative: representative, credit: !pub.isFallback && a?.sourceType === "ENRICHMENT_SERVICE" ? (a.attribution ?? null) : null, creditUrl: !pub.isFallback && a?.sourceType === "ENRICHMENT_SERVICE" ? (a.attributionUrl ?? null) : null, alt: !pub.isFallback ? (a?.altText ?? "") : "", alternates: [] };
}

/**
 * The image a card / hero shows, by priority: its stored image (exact product photo, else a
 * representative Pexels photo), else the category's licensed Pexels photo ("Representative photo",
 * credited); our placeholder graphic only when neither exists. The category photo is also the
 * browser-side alternate when the stored image fails to load.
 */
export async function resolveCardImage(r: Parameters<typeof cardImage>[0]): Promise<CardImage> {
  const img = cardImage(r);
  const photo = await categoryFallbackPhoto(r.categorySlug).catch(() => null);
  if (!photo) return img;
  const src = categoryPhotoSrc(photo);
  if (!img.isFallback) return { ...img, alternates: src !== img.url ? [src] : [] };
  return { url: src, isFallback: false, representative: true, illustrative: true, credit: `Photo by ${photo.photographer} on Pexels`, creditUrl: photo.pexelsUrl, alt: photo.alt, alternates: [] };
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

export type SearchKind = "REVIEW" | "COMPARISON" | "GUIDE";

/** Content kinds a search type filter covers ("GUIDE" = source buying guides and AI-assisted guides). */
export function kindsFor(type?: SearchKind | null): ContentKind[] | undefined {
  if (!type) return undefined;
  return type === "GUIDE" ? ["BUYING_GUIDE", "AI_GUIDE"] : [type];
}

export async function searchReviews(q: string, take = 30, opts: { type?: SearchKind | null } = {}) {
  const terms = q.split(/\s+/).filter((t) => t.length >= 2).slice(0, 6);
  if (!terms.length) return [];
  const kinds = kindsFor(opts.type);
  const categorySlugs = CATEGORIES.filter((c) => terms.some((t) => c.name.toLowerCase().includes(t.toLowerCase()) || c.aliases.includes(t.toLowerCase()))).map((c) => c.slug);
  const rows = await db.normalizedReview.findMany({
    where: {
      status: "PUBLISHED",
      ...(kinds ? { kind: { in: kinds } } : {}),
      AND: terms.map((t) => ({
        OR: [
          // Products and services the content covers, including their aliases ("Nord VPN").
          { contentEntities: { some: { entity: { OR: [{ name: { contains: t, mode: "insensitive" as const } }, { aliasKeys: { has: entityKey(t) } }, { matchKey: entityKey(t) }] } } } },
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

export async function publishedReviews(page: number, pageSize = 24, type?: SearchKind | null) {
  const kinds = kindsFor(type);
  const where = { status: "PUBLISHED", ...(kinds ? { kind: { in: kinds } } : {}) } satisfies Prisma.NormalizedReviewWhereInput;
  const [total, rows] = await Promise.all([
    db.normalizedReview.count({ where }),
    db.normalizedReview.findMany({ where, orderBy: LATEST_FIRST, skip: (page - 1) * pageSize, take: pageSize, select: cardSelect }),
  ]);
  return { total, rows, pages: Math.max(1, Math.ceil(total / pageSize)) };
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

export type Suggestion = { slug: string; title: string; productName: string; brand: string | null; categorySlug: string | null; image: string; kind: "REVIEW" | "AI_GUIDE" | "COMPARISON" | "BUYING_GUIDE" };

/** Instant search suggestions (published reviews only). */
export async function suggest(q: string, take = 6): Promise<Suggestion[]> {
  const rows = await searchReviews(q, take);
  return rows.map((r) => ({ slug: r.slug, title: r.canonicalTitle, productName: r.productName, brand: r.brand, categorySlug: r.categorySlug, image: cardImage(r).url, kind: r.kind }));
}

export const publishedGuides = cache(async (page = 1, pageSize = 24) => {
  // Source buying guides and our AI-assisted guides (each labelled on its card).
  const where = { status: "PUBLISHED", kind: { in: ["AI_GUIDE", "BUYING_GUIDE"] } } satisfies Prisma.NormalizedReviewWhereInput;
  const [total, rows] = await Promise.all([
    db.normalizedReview.count({ where }),
    db.normalizedReview.findMany({ where, orderBy: LATEST_FIRST, skip: (page - 1) * pageSize, take: pageSize, select: cardSelect }),
  ]);
  return { total, rows, pages: Math.max(1, Math.ceil(total / pageSize)) };
});

export async function latestByKind(kind: ContentKind | ContentKind[], take = 6, categorySlug?: string) {
  return db.normalizedReview.findMany({ where: { status: "PUBLISHED", kind: { in: Array.isArray(kind) ? kind : [kind] }, ...(categorySlug ? { categorySlug } : {}) }, orderBy: LATEST_FIRST, take, select: cardSelect });
}

/** One row per published review with a fresh commerce offer (its best fresh price). */
export type DealRow = { offerId: string; seller: string; sellerType: string; price: number | null; currency: string | null; availability: string | null; observedAt: Date; affiliated: boolean; review: ReviewCard };

/** Fresh offers per category and the newest observation, without loading full cards. */
export async function dealLedgerSummary(): Promise<{ counts: Map<string, number>; newest: Date | null }> {
  const offers = await publishedFreshOffers();
  const counts = new Map<string, number>();
  let newest: Date | null = null;
  for (const o of offers) {
    if (o.review.categorySlug) counts.set(o.review.categorySlug, (counts.get(o.review.categorySlug) ?? 0) + 1);
    const at = new Date(o.observedAt);
    if (!newest || at > newest) newest = at;
  }
  return { counts, newest };
}

/** Published reviews whose PRIMARY product has a fresh commerce price, newest observation first. */
export async function freshDealRows({ categorySlug, merchant, q, take = 60 }: { categorySlug?: string; merchant?: string; q?: string; take?: number } = {}): Promise<DealRow[]> {
  const terms = (q ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 6);
  const offers = (await publishedFreshOffers({ categorySlug })).filter((o) => !merchant || o.seller === merchant);
  if (!offers.length) return [];
  const cards = await db.normalizedReview.findMany({ where: { id: { in: offers.map((o) => o.review.id) }, status: "PUBLISHED" }, select: cardSelect });
  const byId = new Map(cards.map((c) => [c.id, c]));
  const rows: DealRow[] = [];
  for (const o of offers) {
    const card = byId.get(o.review.id);
    if (!card) continue;
    const hay = `${card.productName} ${card.brand ?? ""} ${card.canonicalTitle}`.toLowerCase();
    if (terms.some((t) => !hay.includes(t))) continue;
    rows.push({ offerId: o.id, seller: o.seller, sellerType: o.sellerType, price: o.price, currency: o.currency, availability: o.availability, observedAt: new Date(o.observedAt), affiliated: o.affiliated, review: card });
    if (rows.length >= take) break;
  }
  return rows;
}

/** Sellers that currently have at least one fresh price on a published review, for the deals filter. */
export async function dealMerchants() {
  const counts = new Map<string, number>();
  for (const o of await publishedFreshOffers()) counts.set(o.seller, (counts.get(o.seller) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Published reviews that had commerce offers whose prices are no longer recent (deal status
 * STALE at the last check). Only the last check date is public.
 */
export async function lapsedOffers(take = 12, categorySlug?: string) {
  return db.normalizedReview.findMany({
    where: { status: "PUBLISHED", kind: "REVIEW", dealStatus: "STALE", ...(categorySlug ? { categorySlug } : {}) },
    orderBy: [{ dealCheckedAt: "desc" }, { id: "asc" }],
    take,
    select: { ...cardSelect, dealCheckedAt: true },
  });
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
  latest: Array<{ slug: string; title: string; image: string }>;
  guides: Array<{ slug: string; title: string }>;
  deals: Array<{ slug: string; productName: string; merchant: string; price: number | null; currency: string | null }>;
  trending: Array<{ slug: string; title: string; views: number }>;
  counts: Record<string, number>;
  total: number;
};

/** Mega-menu feed for one category: everything is real published data (may be empty). */
export async function navFeed(categorySlug: string): Promise<NavFeed> {
  const [latest, guides, deals, trending, subs] = await Promise.all([
    latestByKind("REVIEW", 3, categorySlug),
    latestByKind("AI_GUIDE", 3, categorySlug),
    freshDealRows({ categorySlug, take: 3 }),
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
    latest: latest.map((r) => ({ slug: r.slug, title: r.productName, image: cardImage(r).url })),
    guides: guides.map((r) => ({ slug: r.slug, title: r.canonicalTitle })),
    deals: deals.map((d) => ({ slug: d.review.slug, productName: d.review.productName, merchant: d.seller, price: d.price, currency: d.currency })),
    trending: trending.filter((t) => t.review.categorySlug === categorySlug).slice(0, 3).map((t) => ({ slug: t.review.slug, title: t.review.productName, views: t.views })),
    counts,
    total,
  };
}

/** Products/services with published content whose name or alias matches the query. */
export async function searchProducts(q: string, take = 8) {
  const term = q.trim();
  if (term.length < 2) return [];
  const key = entityKey(term);
  return db.productEntity.findMany({
    where: { content: { some: { review: { status: "PUBLISHED" } } }, OR: [{ name: { contains: term, mode: "insensitive" } }, { matchKey: key }, { aliasKeys: { has: key } }, { brand: { contains: term, mode: "insensitive" } }] },
    orderBy: { name: "asc" },
    take,
    select: { slug: true, name: true, brand: true, categorySlug: true, _count: { select: { content: { where: { review: { status: "PUBLISHED" } } } } } },
  });
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Typo tolerance: when a search finds nothing, the closest published product, brand or category
 * name within a small edit distance ("nordvnp" → "NordVPN"). Only names that exist are suggested.
 */
export async function didYouMean(q: string): Promise<string | null> {
  const term = q.trim().toLowerCase();
  if (term.length < 3 || term.length > 40) return null;
  const [entities, brands] = await Promise.all([
    db.productEntity.findMany({ where: { content: { some: { review: { status: "PUBLISHED" } } } }, select: { name: true }, take: 2000 }),
    db.normalizedReview.findMany({ where: { status: "PUBLISHED", brand: { not: null } }, distinct: ["brand"], select: { brand: true }, take: 500 }),
  ]);
  const names = [...entities.map((e) => e.name), ...brands.map((b) => b.brand!), ...CATEGORIES.map((c) => c.name)];
  const limit = term.length <= 5 ? 1 : 2;
  let best: { name: string; d: number } | null = null;
  for (const name of names) {
    const d = editDistance(term, name.toLowerCase());
    if (d > 0 && d <= limit && (!best || d < best.d)) best = { name, d };
  }
  return best?.name ?? null;
}

export type SearchGroups = {
  reviews: Suggestion[];
  comparisons: Suggestion[];
  products: Array<{ name: string; href: string; count: number }>;
  guides: Suggestion[];
  deals: Suggestion[];
  categories: Array<{ slug: string; name: string; href: string; parent: string | null }>;
  brands: Array<{ name: string; href: string; count: number }>;
};

/** Grouped instant search across reviews, guides, deals, categories and brands. */
export async function searchGroups(q: string): Promise<SearchGroups> {
  const term = q.trim().toLowerCase();
  const [rows, fresh] = await Promise.all([searchReviews(q, 24), publishedFreshOffers()]);
  const priced = new Set(fresh.map((o) => o.review.id));
  const toS = (r: ReviewCard): Suggestion => ({ slug: r.slug, title: r.canonicalTitle, productName: r.productName, brand: r.brand, categorySlug: r.categorySlug, image: cardImage(r).url, kind: r.kind });
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
  const products = await searchProducts(q, 4);
  return {
    reviews: rows.filter((r) => r.kind === "REVIEW").slice(0, 5).map(toS),
    comparisons: rows.filter((r) => r.kind === "COMPARISON").slice(0, 3).map(toS),
    products: products.map((p) => ({ name: p.name, href: `/product/${p.slug}`, count: p._count.content })),
    guides: rows.filter((r) => r.kind === "AI_GUIDE" || r.kind === "BUYING_GUIDE").slice(0, 3).map(toS),
    deals: rows.filter((r) => priced.has(r.id)).slice(0, 3).map(toS),
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
  const [published, comparisons, guides, fresh, categories] = await Promise.all([
    db.normalizedReview.count({ where: { status: "PUBLISHED", kind: "REVIEW" } }),
    db.normalizedReview.count({ where: { status: "PUBLISHED", kind: "COMPARISON" } }),
    db.normalizedReview.count({ where: { status: "PUBLISHED", kind: { in: ["AI_GUIDE", "BUYING_GUIDE"] } } }),
    publishedFreshOffers(),
    categoryCounts(),
  ]);
  // Products with a fresh price (one per review) and how many of those prices were observed this week.
  const pricedProducts = fresh.length;
  const pricesCheckedThisWeek = fresh.filter((o) => Date.parse(o.observedAt) >= weekAgo.getTime()).length;
  return { published, comparisons, guides, pricedProducts, pricesCheckedThisWeek, categoriesCovered: categories.filter((c) => c.count > 0).length };
}

/** Per-category counts of published reviews, guides and products with a fresh price (all stored data). */
export const categoryLedger = cache(async () => {
  const [byKind, deals] = await Promise.all([
    db.normalizedReview.groupBy({ by: ["categorySlug", "kind"], where: { status: "PUBLISHED", categorySlug: { not: null } }, _count: { _all: true } }),
    publishedFreshOffers(),
  ]);
  return CATEGORIES.map((c) => ({
    slug: c.slug,
    name: c.name,
    description: c.description,
    reviews: byKind.find((r) => r.categorySlug === c.slug && r.kind === "REVIEW")?._count._all ?? 0,
    comparisons: byKind.find((r) => r.categorySlug === c.slug && r.kind === "COMPARISON")?._count._all ?? 0,
    guides: byKind.filter((r) => r.categorySlug === c.slug && (r.kind === "AI_GUIDE" || r.kind === "BUYING_GUIDE")).reduce((n, r) => n + r._count._all, 0),
    deals: deals.filter((d) => d.review.categorySlug === c.slug).length,
  }));
});
