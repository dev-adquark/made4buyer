import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { processReview } from "@/lib/pipeline/process";
import { revalidateReviewPaths } from "@/lib/pipeline/revalidate-paths";

/**
 * reclassify-content: re-runs entity extraction, content-kind detection, product linking and
 * taxonomy for existing content after the taxonomy or entity rules change. Publish state is
 * never changed (QA only moves NEEDS_REVIEW ↔ QUEUED); live pages are rebuilt. Idempotent.
 */
export async function runReclassify(trigger: string, opts: { limit?: number } = {}) {
  const reviews = await db.normalizedReview.findMany({
    where: { status: { in: ["PUBLISHED", "QUEUED", "NEEDS_REVIEW"] } },
    orderBy: { updatedAt: "asc" },
    take: opts.limit ?? 100,
    select: { id: true, slug: true, kind: true, categorySlug: true, brandSlug: true, status: true },
  });
  const changes: Array<{ slug: string; kind: string; category: string | null; products: number }> = [];
  let failed = 0;
  for (const r of reviews) {
    try {
      await processReview(r.id, { from: "ENTITY_EXTRACTION", skipImage: true });
      const after = await db.normalizedReview.findUniqueOrThrow({ where: { id: r.id }, select: { slug: true, kind: true, categorySlug: true, brandSlug: true, _count: { select: { contentEntities: true } } } });
      if (after.kind !== r.kind || after.categorySlug !== r.categorySlug) changes.push({ slug: r.slug, kind: after.kind, category: after.categorySlug, products: after._count.contentEntities });
      if (r.status === "PUBLISHED") {
        revalidateReviewPaths(after);
        // The old category page drops the item too.
        if (r.categorySlug && r.categorySlug !== after.categorySlug) revalidateReviewPaths({ slug: r.slug, categorySlug: r.categorySlug });
      }
    } catch (error) {
      failed++;
      log.error("reclassify failed", { reviewId: r.id, error: String(error) });
    }
  }
  return { status: "OK", trigger, checked: reviews.length, changed: changes.length, failed, changes };
}
