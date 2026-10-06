import { revalidatePath } from "next/cache";
import { log } from "@/lib/log";

type ReviewRef = { slug: string; categorySlug?: string | null; brandSlug?: string | null };
export type RevalidationTarget = { path: string; type?: "page" };

/**
 * Every cached (ISR) public page a review or one of its offers appears on: the review, the home
 * page, its brand hub and every product hub. Product hubs are purged as a route
 * (`/product/[slug]`: all cached product pages) because a review's product links are not known
 * here; they regenerate lazily on their next request. Category, listing and search pages read
 * the query string and render per request; their paths are purged anyway (a no-op while they
 * are dynamic) so they stay correct if they become cached.
 */
export function reviewRevalidationTargets(review: ReviewRef): RevalidationTarget[] {
  const targets: RevalidationTarget[] = [{ path: `/review/${review.slug}` }, { path: "/" }, { path: "/sitemap.xml" }, { path: "/product/[slug]", type: "page" }];
  if (review.categorySlug) targets.push({ path: `/category/${review.categorySlug}` });
  if (review.brandSlug) targets.push({ path: `/brand/${review.brandSlug}` });
  return targets;
}

/**
 * Invalidates cached public pages after a publish-state or deal change. Runs synchronously
 * inside the request (admin actions, cron routes) so the purge is registered before the
 * response completes. Outside a Next.js request context (CLI scripts, tests) revalidation is
 * unavailable; cached pages then refresh within their ISR window (5 minutes).
 */
export function revalidateReviewPaths(review: ReviewRef) {
  try {
    for (const t of reviewRevalidationTargets(review)) revalidatePath(t.path, t.type);
  } catch (error) {
    log.debug("path revalidation skipped (no request context)", { error: String(error) });
  }
}
