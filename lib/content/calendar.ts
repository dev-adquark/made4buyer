import { db } from "@/lib/db";
import {
  CATEGORIES,
  DEPARTMENTS,
  type CategoryDef,
} from "@/lib/taxonomy/definitions";

/**
 * Content coverage and the content calendar.
 *
 * Coverage is computed from stored data only. The calendar ranks the next legitimate content
 * opportunities from real gaps: categories with nothing published, categories with reviews but
 * no guide, reviewed products without a guide, with a seasonal nudge. It never invents
 * products: category opportunities are educational buying guides ("how to choose"), and
 * product opportunities exist only for products a real source reviewed.
 */

const TECH_DEPARTMENTS = new Set([
  "computing",
  "mobile",
  "audio-video",
  "home",
  "gaming",
  "software",
  "accessories",
  "gadgets",
  "security",
  "business",
  "web",
  "creative",
]);

export function isTechCategory(c: Pick<CategoryDef, "department">): boolean {
  return TECH_DEPARTMENTS.has(c.department);
}

/** Months (1–12) when buyers research a category most; a small priority nudge, not a rule. */
const SEASONS: Record<string, number[]> = {
  "fitness-equipment": [1, 2],
  "luggage-travel": [5, 6, 7, 11, 12],
  "outdoor-garden": [3, 4, 5, 6],
  "kitchen-appliances": [10, 11, 12],
  "home-appliances": [10, 11],
  mattresses: [1, 5, 9, 11],
  "baby-kids": [3, 4, 8],
  "tools-diy": [3, 4, 5, 6],
  gaming: [10, 11, 12],
  "tv-home-entertainment": [1, 2, 10, 11],
  laptops: [7, 8],
  "pet-supplies": [4, 5],
};

export type CategoryCoverage = {
  slug: string;
  name: string;
  department: string;
  departmentName: string;
  tech: boolean;
  reviews: number;
  comparisons: number;
  guides: number;
  aiGuides: number;
  published: number;
  inQa: number;
  products: number;
  verifiedDeals: number;
  realImages: number;
  sourcesCovering: number;
  level: "STRONG" | "WEAK" | "MISSING";
  blockers: string[];
};

export async function categoryCoverage(): Promise<CategoryCoverage[]> {
  const [byKind, qa, products, deals, images, sources, sourceCats] =
    await Promise.all([
      db.normalizedReview.groupBy({
        by: ["categorySlug", "kind"],
        where: { status: "PUBLISHED" },
        _count: { _all: true },
      }),
      db.normalizedReview.groupBy({
        by: ["categorySlug"],
        where: { status: { in: ["NEEDS_REVIEW", "QUEUED"] } },
        _count: { _all: true },
      }),
      db.productEntity.groupBy({
        by: ["categorySlug"],
        where: { content: { some: { review: { status: "PUBLISHED" } } } },
        _count: { _all: true },
      }),
      db.affiliateLink.findMany({
        where: {
          isActive: true,
          verificationStatus: "VERIFIED_OK",
          offerMatch: { matchStatus: "MATCHED" },
          review: { status: "PUBLISHED" },
        },
        select: { review: { select: { categorySlug: true } } },
      }),
      db.imageAsset.findMany({
        where: {
          isPrimary: true,
          isFallback: false,
          review: { status: "PUBLISHED" },
        },
        select: { review: { select: { categorySlug: true } } },
      }),
      db.reviewSource.findMany({
        where: { enabled: true },
        select: { slug: true, categoryHint: true },
      }),
      // Which categories each enabled source has actually produced content for.
      db.normalizedReview.groupBy({
        by: ["source", "categorySlug"],
        where: { source: { startsWith: "apify:" } },
        _count: { _all: true },
      }),
    ]);
  const enabledKeys = new Set(sources.map((s) => `apify:${s.slug}`));
  return CATEGORIES.map((c) => {
    const n = (kind: string) =>
      byKind.find((r) => r.categorySlug === c.slug && r.kind === kind)?._count
        ._all ?? 0;
    const reviews = n("REVIEW");
    const comparisons = n("COMPARISON");
    const guides = n("BUYING_GUIDE");
    const aiGuides = n("AI_GUIDE");
    const published = reviews + comparisons + guides + aiGuides;
    const sourcesCovering = new Set([
      ...sources.filter((s) => s.categoryHint === c.slug).map((s) => s.slug),
      ...sourceCats
        .filter((r) => r.categorySlug === c.slug && enabledKeys.has(r.source))
        .map((r) => r.source),
    ]).size;
    const verifiedDeals = deals.filter(
      (d) => d.review.categorySlug === c.slug,
    ).length;
    const blockers: string[] = [];
    if (!sourcesCovering)
      blockers.push(
        "No enabled source covers this category: reviews need a publisher whose terms allow it",
      );
    if (published > 0 && verifiedDeals === 0)
      blockers.push("No verified offers (Sovrn price comparison not approved)");
    return {
      slug: c.slug,
      name: c.name,
      department: c.department,
      departmentName:
        DEPARTMENTS.find((d) => d.slug === c.department)?.name ?? c.department,
      tech: isTechCategory(c),
      reviews,
      comparisons,
      guides,
      aiGuides,
      published,
      inQa: qa.find((q) => q.categorySlug === c.slug)?._count._all ?? 0,
      products:
        products.find((p) => p.categorySlug === c.slug)?._count._all ?? 0,
      verifiedDeals,
      realImages: images.filter((i) => i.review.categorySlug === c.slug).length,
      sourcesCovering,
      level:
        published >= 5 && reviews + comparisons > 0 && guides + aiGuides > 0
          ? "STRONG"
          : published > 0
            ? "WEAK"
            : "MISSING",
      blockers,
    };
  });
}

export type Opportunity = {
  /** Stable key: one opportunity is never generated twice. */
  key: string;
  kind: "CATEGORY_GUIDE" | "PRODUCT_GUIDE";
  subject: string;
  categorySlug: string;
  subcategorySlug?: string;
  brand?: string | null;
  score: number;
  why: string;
};

/** Normalised subject used for de-duplication against existing guides. */
export function subjectKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The next best legitimate content opportunities, highest score first, at most one per category
 * in the top of the list so no single category (or tech overall) dominates the queue.
 */
export async function contentOpportunities(
  opts: { now?: Date; limit?: number } = {},
): Promise<Opportunity[]> {
  const month = (opts.now ?? new Date()).getUTCMonth() + 1;
  const [coverage, guides, reviewed] = await Promise.all([
    categoryCoverage(),
    // Every guide ever drafted, including rejected ones: a rejected topic is never regenerated.
    db.normalizedReview.findMany({
      where: { kind: { in: ["AI_GUIDE", "BUYING_GUIDE"] } },
      select: { productName: true },
    }),
    db.normalizedReview.findMany({
      where: {
        kind: "REVIEW",
        status: { in: ["PUBLISHED", "QUEUED", "NEEDS_REVIEW"] },
        categorySlug: { not: null },
        // Only reviews whose product was identified with confidence (a PRIMARY product link),
        // so a headline fragment is never sent as a "product" topic.
        contentEntities: { some: { role: "PRIMARY" } },
      },
      orderBy: [
        { sourcePublishedAt: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
      ],
      take: 300,
      select: { productName: true, brand: true, categorySlug: true },
    }),
  ]);
  const covered = new Set(guides.map((g) => subjectKey(g.productName)));
  const byCat = new Map(coverage.map((c) => [c.slug, c]));
  const out: Opportunity[] = [];
  const seasonal = (slug: string) => (SEASONS[slug]?.includes(month) ? 15 : 0);

  for (const c of CATEGORIES) {
    const cov = byCat.get(c.slug)!;
    const gap =
      cov.published === 0 ? 40 : cov.guides + cov.aiGuides === 0 ? 25 : 5;
    // Under-covered non-tech categories first; tech keeps a healthy share.
    const balance = cov.tech ? 0 : 20;
    const subs = c.subcategories.filter((s) => !s.legacy);
    for (const [i, s] of subs.entries()) {
      const subject = s.name;
      if (covered.has(subjectKey(subject))) continue;
      out.push({
        key: `guide:${c.slug}:${s.slug}`,
        kind: "CATEGORY_GUIDE",
        subject,
        categorySlug: c.slug,
        subcategorySlug: s.slug,
        score: gap + balance + seasonal(c.slug) - i * 2,
        why: `${cov.published ? `${cov.published} published, ${cov.guides + cov.aiGuides} guides` : "nothing published yet"} in ${c.name}${seasonal(c.slug) ? "; in season" : ""}`,
      });
    }
  }
  for (const r of reviewed) {
    if (!r.categorySlug || covered.has(subjectKey(r.productName))) continue;
    covered.add(subjectKey(r.productName));
    const cov = byCat.get(r.categorySlug);
    out.push({
      key: `product:${subjectKey(r.productName)}`,
      kind: "PRODUCT_GUIDE",
      subject: r.productName,
      brand: r.brand,
      categorySlug: r.categorySlug,
      score: 30 + (cov && !cov.tech ? 20 : 0) + seasonal(r.categorySlug),
      why: `reviewed by a source, no guide yet`,
    });
  }
  out.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  // Round-robin by category so the head of the queue is diverse.
  const seen = new Set<string>();
  const head: Opportunity[] = [];
  const tail: Opportunity[] = [];
  for (const o of out)
    (seen.has(o.categorySlug) ? tail : (seen.add(o.categorySlug), head)).push(
      o,
    );
  return [...head, ...tail].slice(0, opts.limit ?? 50);
}
