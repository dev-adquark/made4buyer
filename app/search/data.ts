import { unstable_cache } from "next/cache";
import { NAV_CATEGORIES_TAG } from "@/lib/public/nav-categories";
import { categoryCounts, didYouMean, searchGroups, searchReviews, type ReviewCard, type SearchGroups, type SearchKind } from "@/lib/public/queries";

/**
 * Search content lookups, cached in the data cache per normalized query (the trimmed text the page
 * shows, plus the type filter) for a short window and purged on every publish-state change (the
 * same tag revalidateReviewPaths revalidates). Only published content lives here: verified deals
 * and coupons come from searchCommerce(), which reads the deals cache and re-applies the price and
 * coupon windows on every request.
 */
export const SEARCH_REVALIDATE_SECONDS = 120;
const opts = { revalidate: SEARCH_REVALIDATE_SECONDS, tags: [NAV_CATEGORIES_TAG] };

/** The data cache stores JSON: card dates come back as strings and are revived here. */
export function reviveCards(rows: ReviewCard[]): ReviewCard[] {
  return rows.map((r) => ({ ...r, publishedAt: r.publishedAt ? new Date(r.publishedAt) : r.publishedAt, sourcePublishedAt: r.sourcePublishedAt ? new Date(r.sourcePublishedAt) : r.sourcePublishedAt }));
}

const reviews = unstable_cache((q: string, type: SearchKind | null) => searchReviews(q, 30, { type }), ["search-reviews-v1"], opts);
const groups = unstable_cache(async (q: string): Promise<Pick<SearchGroups, "products" | "categories" | "brands">> => {
  const g = await searchGroups(q);
  // Only the groups the page lists (the suggestion groups are for the instant-search dropdown).
  return { products: g.products, categories: g.categories, brands: g.brands };
}, ["search-groups-v1"], opts);
const suggestion = unstable_cache((q: string) => didYouMean(q), ["search-did-you-mean-v1"], opts);
const counts = unstable_cache(() => categoryCounts(), ["search-category-counts-v1"], opts);

/** Falls back to a direct query when the data cache is unavailable (outside a Next.js request). */
async function cached<T>(fromCache: () => Promise<T>, direct: () => Promise<T>): Promise<T> {
  try {
    return await fromCache();
  } catch {
    return direct();
  }
}

export async function cachedSearchReviews(q: string, type: SearchKind | null): Promise<ReviewCard[]> {
  return reviveCards(await cached(() => reviews(q, type), () => searchReviews(q, 30, { type })));
}

export const cachedSearchGroups = (q: string) => cached(() => groups(q), () => searchGroups(q));
export const cachedDidYouMean = (q: string) => cached(() => suggestion(q), () => didYouMean(q));
export const cachedCategoryCounts = () => cached(counts, categoryCounts);
