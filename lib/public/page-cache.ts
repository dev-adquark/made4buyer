import { unstable_cache } from "next/cache";
import { log } from "@/lib/log";
import { DEALS_TAG } from "@/lib/public/deals";
import { NAV_CATEGORIES_TAG } from "@/lib/public/nav-categories";

/** ISR window of the listing pages (seconds); same as the home page, reviews and /deals. */
export const LISTING_REVALIDATE_SECONDS = 300;

/** Content listings: purged on every publish-state change (revalidateReviewPaths revalidates this tag). */
export const LISTING_CONTENT_TAGS = [NAV_CATEGORIES_TAG];
/** Listings that also show prices: purged by the commerce engine too (revalidateCommerce). */
export const LISTING_COMMERCE_TAGS = [NAV_CATEGORIES_TAG, DEALS_TAG];

const marker = unstable_cache(async () => true, ["listing-page-tags-v1"], { revalidate: LISTING_REVALIDATE_SECONDS, tags: LISTING_COMMERCE_TAGS });
const contentMarker = unstable_cache(async () => true, ["listing-page-tags-content-v1"], { revalidate: LISTING_REVALIDATE_SECONDS, tags: LISTING_CONTENT_TAGS });

/**
 * Attaches the existing cache tags to the ISR page being rendered, so `revalidateTag` purges every
 * cached variant of a listing (including the filter-state routes, whose paths a publish cannot
 * know) the moment content or prices change. unstable_cache records its tags on the page that
 * calls it; the cached value itself is a constant (no data is held in the data cache).
 */
export async function tagListingPage(opts: { commerce?: boolean } = {}): Promise<void> {
  try {
    await (opts.commerce ? marker() : contentMarker());
  } catch (error) {
    // Outside a Next.js request (tests, scripts) there is no cache to tag.
    log.debug("listing page tags skipped", { error: String(error).slice(0, 200) });
  }
}
