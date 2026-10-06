import { unstable_cache } from "next/cache";
import { cache } from "react";
import { log } from "@/lib/log";
import { categoryCounts } from "@/lib/public/queries";

/**
 * Global navigation (header mega-menu, mobile menu, footer, command palette) lists only categories
 * that have PUBLISHED content. "Empty" uses the same definition as the category page's noindex rule
 * (`categoryCounts()`: published reviews of any kind with that category). Empty categories keep
 * their /category/<slug> route (noindex) for direct visits; they reappear in navigation by
 * themselves once content is published, within the cache window below.
 */

/** Cache tag for the non-empty category set; `revalidateTag(NAV_CATEGORIES_TAG)` refreshes it immediately. */
export const NAV_CATEGORIES_TAG = "nav-categories";
export const NAV_CATEGORIES_REVALIDATE_SECONDS = 300;

/** Keeps only categories whose slug is in `nonEmpty`, preserving the input (taxonomy) order. */
export function filterNavCategories<T extends { slug: string }>(categories: readonly T[], nonEmpty: Iterable<string>): T[] {
  const keep = new Set(nonEmpty);
  return categories.filter((c) => keep.has(c.slug));
}

/** Slugs of categories with at least one PUBLISHED item (uncached; taxonomy order). */
export async function nonEmptyCategorySlugs(): Promise<string[]> {
  return (await categoryCounts()).filter((c) => c.count > 0).map((c) => c.slug);
}

// Shared across requests (data cache), refreshed every 5 minutes or on the tag. The revalidate
// window also propagates to statically rendered pages, so their shell refreshes on the same cadence.
const cachedNonEmptySlugs = unstable_cache(nonEmptyCategorySlugs, ["nav-categories-v1"], { revalidate: NAV_CATEGORIES_REVALIDATE_SECONDS, tags: [NAV_CATEGORIES_TAG] });

/** Cached non-empty slug set, or null when it cannot be computed (database unavailable). Deduped per request. */
const navCategorySlugs = cache(async (): Promise<string[] | null> => {
  try {
    return await cachedNonEmptySlugs();
  } catch (error) {
    log.warn("nav categories unavailable; showing full taxonomy", { error: String(error) });
    return null;
  }
});

/**
 * Categories to show in global navigation: non-empty ones, in taxonomy order, with their issue
 * numbers renumbered to stay consecutive. Departments left without categories disappear because
 * every consumer groups by department from this list. If the set cannot be computed, the full
 * taxonomy is shown rather than an empty navigation.
 */
export async function visibleNavCategories<T extends { slug: string; issue: number }>(categories: readonly T[]): Promise<T[]> {
  const slugs = await navCategorySlugs();
  if (!slugs) return [...categories];
  return filterNavCategories(categories, slugs).map((c, i) => ({ ...c, issue: i + 1 }));
}
