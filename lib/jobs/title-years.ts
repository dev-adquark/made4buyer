import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { honestTitle, KEYWORD_TO_BLOG_SOURCE, newestSourceDate } from "@/lib/content/honest-title";
import { persistPageRenderModel } from "@/lib/pipeline/render-model";
import { revalidateReviewPaths } from "@/lib/pipeline/revalidate-paths";
import { audit, SYSTEM_ACTOR } from "@/lib/security/audit";

/**
 * fix-title-years: removes years from existing external titles that are newer than every date
 * the source gave us ("ExpressVPN Review 2026" on a review dated 2019). Only canonicalTitle
 * changes — never the slug (URLs and inbound links stay valid), never the body. The publisher's
 * title is kept in sourceData.originalTitle. Keyword-to-Blog posts, AI guides, undated items and
 * editor-locked items are skipped. Idempotent: a cleaned title has no misleading year left.
 */
export async function runTitleYearFix(trigger: string, opts: { limit?: number } = {}) {
  const where: Prisma.NormalizedReviewWhereInput = {
    source: { not: KEYWORD_TO_BLOG_SOURCE },
    kind: { not: "AI_GUIDE" },
    manualEditLocked: false,
    // A 19xx/20xx year is somewhere in the title (the cleaner decides precisely).
    OR: [{ canonicalTitle: { contains: "19" } }, { canonicalTitle: { contains: "20" } }],
    AND: [{ OR: [{ sourcePublishedAt: { not: null } }, { sourceUpdatedAt: { not: null } }] }],
  };
  const select = { id: true, slug: true, status: true, canonicalTitle: true, categorySlug: true, brandSlug: true, sourcePublishedAt: true, sourceUpdatedAt: true, sourceData: true } as const;
  // Page by id so titles that legitimately keep their year never starve later rows.
  const reviews: Array<Prisma.NormalizedReviewGetPayload<{ select: typeof select }>> = [];
  const max = opts.limit ?? 20_000;
  let cursor: string | undefined;
  while (reviews.length < max) {
    const page = await db.normalizedReview.findMany({ where: cursor ? { ...where, id: { gt: cursor } } : where, orderBy: { id: "asc" }, take: Math.min(500, max - reviews.length), select });
    reviews.push(...page);
    if (page.length < 500) break;
    cursor = page[page.length - 1].id;
  }
  const changes: Array<{ slug: string; from: string; to: string; removedYears: number[] }> = [];
  let failed = 0;
  let republished = 0;
  for (const r of reviews) {
    const result = honestTitle(r.canonicalTitle, newestSourceDate(r.sourcePublishedAt, r.sourceUpdatedAt));
    if (!result.changed) continue;
    try {
      const prior = r.sourceData && typeof r.sourceData === "object" && !Array.isArray(r.sourceData) ? (r.sourceData as Record<string, unknown>) : {};
      // Never overwrite an original title recorded earlier (at ingestion or by a previous run).
      const originalTitle = typeof prior.originalTitle === "string" && prior.originalTitle ? prior.originalTitle : r.canonicalTitle;
      const sourceData = { ...prior, originalTitle } as Prisma.InputJsonValue;
      // Guarded write: skip if an editor locked the row or the title changed since we read it.
      const updated = await db.normalizedReview.updateMany({
        where: { id: r.id, manualEditLocked: false, canonicalTitle: r.canonicalTitle },
        data: { canonicalTitle: result.title, sourceData },
      });
      if (updated.count === 0) continue;
      await audit(SYSTEM_ACTOR, {
        action: "review.title.misleading_year_removed",
        entityType: "normalized_review",
        entityId: r.id,
        before: { canonicalTitle: r.canonicalTitle },
        after: { canonicalTitle: result.title },
        metadata: { trigger, removedYears: result.removedYears, sourcePublishedAt: r.sourcePublishedAt, sourceUpdatedAt: r.sourceUpdatedAt, slug: r.slug },
      });
      changes.push({ slug: r.slug, from: r.canonicalTitle, to: result.title, removedYears: result.removedYears });
      if (r.status === "PUBLISHED") {
        await persistPageRenderModel(r.id);
        revalidateReviewPaths(r);
        republished++;
      }
    } catch (error) {
      failed++;
      log.error("title year fix failed", { reviewId: r.id, error: String(error) });
    }
  }
  return { status: "OK", trigger, checked: reviews.length, changed: changes.length, republished, failed, changes: changes.slice(0, 200) };
}
