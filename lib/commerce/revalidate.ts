import { revalidatePath, revalidateTag } from "next/cache";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { persistPageRenderModel } from "@/lib/pipeline/render-model";
import { revalidateReviewPaths } from "@/lib/pipeline/revalidate-paths";

/** Cache tag of the public Deals section (built from CommerceOffer price/listPrice and coupons). */
export const DEALS_TAG = "deals";

/**
 * After a job changed a public offer or coupon: purge the Deals tag, product pages and the published
 * reviews of the touched products so the site updates without a deploy. Outside a Next.js request
 * context (tests, scripts) revalidation is unavailable and is skipped; ISR then refreshes on its own.
 */
export async function revalidateCommerce(entityIds: Iterable<string> = []): Promise<void> {
  const ids = [...new Set(entityIds)].slice(0, 50);
  // Rebuild the stored page models of touched published reviews first (works without a request
  // context), so new, conflicting or withdrawn facts reach the page now, not at the next enrichment.
  if (ids.length) {
    try {
      const reviews = await db.contentEntity.findMany({ where: { productEntityId: { in: ids }, review: { status: "PUBLISHED" } }, select: { normalizedReviewId: true }, take: 40 });
      for (const reviewId of new Set(reviews.map((r) => r.normalizedReviewId))) await persistPageRenderModel(reviewId).catch((error) => log.warn("page model rebuild failed", { stage: "COMMERCE", reviewId, error: String(error).slice(0, 200) }));
    } catch (error) {
      log.warn("commerce page model rebuild failed", { stage: "COMMERCE", error: String(error).slice(0, 200) });
    }
  }
  try {
    revalidateTag(DEALS_TAG, { expire: 0 });
    revalidatePath("/product/[slug]", "page");
  } catch (error) {
    log.debug("commerce revalidation skipped (no request context)", { error: String(error).slice(0, 200) });
    return;
  }
  if (!ids.length) return;
  try {
    const links = await db.contentEntity.findMany({
      where: { productEntityId: { in: ids }, review: { status: "PUBLISHED" } },
      select: { review: { select: { slug: true, categorySlug: true, brandSlug: true } } },
      take: 40,
    });
    const seen = new Set<string>();
    for (const { review } of links) {
      if (seen.has(review.slug)) continue;
      seen.add(review.slug);
      revalidateReviewPaths(review);
    }
  } catch (error) {
    log.warn("commerce review revalidation failed", { stage: "COMMERCE", error: String(error).slice(0, 200) });
  }
}
