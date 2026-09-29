import { revalidatePath } from "next/cache";
import { log } from "@/lib/log";

/**
 * Invalidates cached public pages after a publish-state or deal change. Runs synchronously
 * inside the request (admin actions, cron routes) so the purge is registered before the
 * response completes. Outside a Next.js request context (CLI scripts, tests) revalidation is
 * unavailable; cached review pages then refresh within their ISR window (5 minutes).
 */
export function revalidateReviewPaths(review: { slug: string; categorySlug?: string | null; brandSlug?: string | null }) {
  const paths = [`/review/${review.slug}`, "/", "/sitemap.xml"];
  if (review.categorySlug) paths.push(`/category/${review.categorySlug}`);
  if (review.brandSlug) paths.push(`/brand/${review.brandSlug}`);
  try {
    for (const p of paths) revalidatePath(p);
  } catch (error) {
    log.debug("path revalidation skipped (no request context)", { error: String(error) });
  }
}
