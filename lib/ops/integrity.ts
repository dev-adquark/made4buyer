import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";

/**
 * Read-only data-integrity audit. Every check is a query against stored data; nothing is
 * modified. A non-zero count names a real inconsistency an admin should look at.
 */
export type IntegrityReport = {
  ok: boolean;
  checks: Record<string, { count: number; sample: string[] }>;
};

export async function runIntegrityChecks(): Promise<IntegrityReport> {
  const live: Prisma.NormalizedReviewWhereInput = {
    status: { in: ["PUBLISHED", "QUEUED", "NEEDS_REVIEW"] },
  };
  const [
    dupSource,
    dupCanonical,
    published,
    entityless,
    imagelessPublished,
  ] = await Promise.all([
    db.normalizedReview.groupBy({
      by: ["sourceUrl"],
      where: { ...live, sourceUrl: { not: null } },
      _count: { _all: true },
      having: { sourceUrl: { _count: { gt: 1 } } },
    }),
    db.normalizedReview.groupBy({
      by: ["canonicalUrl"],
      where: { ...live, canonicalUrl: { not: null } },
      _count: { _all: true },
      having: { canonicalUrl: { _count: { gt: 1 } } },
    }),
    db.normalizedReview.findMany({
      where: { status: "PUBLISHED" },
      select: {
        slug: true,
        categorySlug: true,
        subcategorySlug: true,
        kind: true,
        renderModel: { select: { id: true } },
        _count: { select: { contentEntities: true } },
      },
    }),
    db.productEntity.findMany({
      where: { content: { none: {} } },
      select: { slug: true },
      take: 20,
    }),
    db.normalizedReview.findMany({
      where: { status: "PUBLISHED", images: { none: { isPrimary: true } } },
      select: { slug: true },
      take: 20,
    }),
  ]);
  const badCategory = published.filter(
    (r) => r.categorySlug && !CATEGORY_BY_SLUG.has(r.categorySlug),
  );
  const badSub = published.filter(
    (r) =>
      r.categorySlug &&
      r.subcategorySlug &&
      !CATEGORY_BY_SLUG.get(r.categorySlug)?.subcategories.some(
        (s) => s.slug === r.subcategorySlug,
      ),
  );
  const noModel = published.filter((r) => !r.renderModel);
  const thinComparison = published.filter(
    (r) => r.kind === "COMPARISON" && r._count.contentEntities < 2,
  );
  const checks: IntegrityReport["checks"] = {
    duplicateSourceUrls: {
      count: dupSource.length,
      sample: dupSource.slice(0, 5).map((d) => d.sourceUrl ?? ""),
    },
    duplicateCanonicalUrls: {
      count: dupCanonical.length,
      sample: dupCanonical.slice(0, 5).map((d) => d.canonicalUrl ?? ""),
    },
    publishedInvalidCategory: {
      count: badCategory.length,
      sample: badCategory
        .slice(0, 5)
        .map((r) => `${r.slug} → ${r.categorySlug}`),
    },
    publishedInvalidSubcategory: {
      count: badSub.length,
      sample: badSub.slice(0, 5).map((r) => `${r.slug} → ${r.subcategorySlug}`),
    },
    publishedWithoutPageModel: {
      count: noModel.length,
      sample: noModel.slice(0, 5).map((r) => r.slug),
    },
    publishedComparisonUnder2Products: {
      count: thinComparison.length,
      sample: thinComparison.slice(0, 5).map((r) => r.slug),
    },
    publishedWithoutImageRecord: {
      count: imagelessPublished.length,
      sample: imagelessPublished.slice(0, 5).map((r) => r.slug),
    },
    // Informational: products left without any article (e.g. after an editor unlinked them).
    unlinkedProducts: {
      count: entityless.length,
      sample: entityless.slice(0, 5).map((e) => e.slug),
    },
  };
  const ok = Object.entries(checks).every(
    ([k, v]) => k === "unlinkedProducts" || v.count === 0,
  );
  return { ok, checks };
}
