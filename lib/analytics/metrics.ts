import { config, INSUFFICIENT_DATA } from "@/lib/config";
import { db } from "@/lib/db";

/**
 * Success metrics as real queries over persisted data. Nothing here is estimated: a
 * metric with no (or too little) data reports INSUFFICIENT_DATA instead of a number that
 * could be mistaken for evidence.
 */

export type Window = { start: Date; end: Date };

export type MetricStatus = "MEETS_TARGET" | "BELOW_TARGET" | typeof INSUFFICIENT_DATA;

export type Metric = {
  key: string;
  label: string;
  formula: string;
  numerator: number;
  denominator: number;
  value: number | null;
  target: number;
  comparator: ">=" | "<=";
  status: MetricStatus;
};

export const MIN_SAMPLE = () => Number(process.env.METRIC_MIN_SAMPLE ?? 10) || 10;

export function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 10000) / 10000 : null;
}

export function evaluateMetric(m: Omit<Metric, "value" | "status">, minSample = MIN_SAMPLE()): Metric {
  const value = ratio(m.numerator, m.denominator);
  let status: MetricStatus;
  if (value === null || m.denominator < minSample) status = INSUFFICIENT_DATA;
  else status = (m.comparator === ">=" ? value >= m.target : value <= m.target) ? "MEETS_TARGET" : "BELOW_TARGET";
  return { ...m, value, status };
}

export function defaultWindow(days = 30, end = new Date()): Window {
  return { start: new Date(end.getTime() - days * 24 * 3_600_000), end };
}

const within = (w: Window) => ({ gte: w.start, lte: w.end });

/** Published reviews that currently have ≥1 active VERIFIED_OK affiliate link on a matched offer. */
export async function reviewsWithVerifiedDeal(where: { status: "PUBLISHED"; createdAt?: { gte: Date; lte: Date } }) {
  return db.normalizedReview.count({
    where: { ...where, affiliateLinks: { some: { isActive: true, verificationStatus: "VERIFIED_OK", offerMatch: { matchStatus: "MATCHED" } } } },
  });
}

export async function successMetrics(w: Window = defaultWindow()): Promise<Metric[]> {
  const threshold = config.taxonomy.autoAcceptThreshold();
  const [validIngested, publishedOfIngested, published, publishedWithDeal, linksChecked, linksOk, runs, publishAttempts, publishFailed, highConfReviewed, highConfAccepted] = await Promise.all([
    db.normalizedReview.count({ where: { createdAt: within(w) } }),
    db.normalizedReview.count({ where: { createdAt: within(w), status: "PUBLISHED" } }),
    db.normalizedReview.count({ where: { status: "PUBLISHED" } }),
    reviewsWithVerifiedDeal({ status: "PUBLISHED" }),
    db.affiliateLink.count({ where: { isActive: true, lastVerifiedAt: within(w) } }),
    db.affiliateLink.count({ where: { isActive: true, lastVerifiedAt: within(w), verificationStatus: "VERIFIED_OK" } }),
    db.ingestionRun.aggregate({ where: { startedAt: within(w) }, _sum: { totalFetched: true, duplicateCount: true } }),
    db.publishJob.count({ where: { action: "PUBLISH", createdAt: within(w) } }),
    db.publishJob.count({ where: { action: "PUBLISH", status: "FAILED", createdAt: within(w) } }),
    db.reviewCategoryAssignment.count({ where: { tagType: "CATEGORY", isOverride: false, confidence: { gte: threshold }, reviewState: { in: ["ACCEPTED", "REJECTED"] }, createdAt: within(w) } }),
    db.reviewCategoryAssignment.count({ where: { tagType: "CATEGORY", isOverride: false, confidence: { gte: threshold }, reviewState: "ACCEPTED", createdAt: within(w) } }),
  ]);

  return [
    evaluateMetric({ key: "publishing_rate", label: "Publishing rate", formula: "published / valid ingested reviews (created in window)", numerator: publishedOfIngested, denominator: validIngested, target: 0.95, comparator: ">=" }),
    evaluateMetric({ key: "deal_coverage", label: "Deal coverage", formula: "published reviews with a verified valid deal / published reviews", numerator: publishedWithDeal, denominator: published, target: 0.9, comparator: ">=" }),
    evaluateMetric({ key: "link_health", label: "Link health", formula: "verified valid links / links revalidated in window", numerator: linksOk, denominator: linksChecked, target: 0.99, comparator: ">=" }),
    evaluateMetric({ key: "duplicate_rate", label: "Duplicate rate", formula: "duplicates / total fetched", numerator: runs._sum.duplicateCount ?? 0, denominator: runs._sum.totalFetched ?? 0, target: 0.05, comparator: "<=" }),
    evaluateMetric({ key: "page_error_rate", label: "Page error rate", formula: "failed publishes / publish attempts", numerator: publishFailed, denominator: publishAttempts, target: 0.02, comparator: "<=" }),
    evaluateMetric({ key: "categorization_acceptance", label: "Categorization acceptance", formula: "accepted high-confidence assignments / reviewed high-confidence assignments", numerator: highConfAccepted, denominator: highConfReviewed, target: 0.9, comparator: ">=" }),
  ];
}

export type CategoryCtr = { categorySlug: string; eligibleImpressions: number; clicks: number; ctr: number | null; dataSufficiency: "SUFFICIENT" | typeof INSUFFICIENT_DATA };

/** Affiliate CTR per category = affiliate clicks / eligible deal impressions. */
export async function ctrByCategory(w: Window = defaultWindow()): Promise<CategoryCtr[]> {
  const rows = await db.analyticsEvent.groupBy({
    by: ["categorySlug", "event"],
    where: { createdAt: within(w), event: { in: ["deal_impression", "affiliate_click"] }, categorySlug: { not: null } },
    _count: { _all: true },
  });
  const min = config.analytics.minImpressionsForCtr();
  const map = new Map<string, { impressions: number; clicks: number }>();
  for (const r of rows) {
    const slug = r.categorySlug!;
    const entry = map.get(slug) ?? { impressions: 0, clicks: 0 };
    if (r.event === "deal_impression") entry.impressions += r._count._all;
    else entry.clicks += r._count._all;
    map.set(slug, entry);
  }
  return [...map.entries()]
    .map(([categorySlug, v]) => ({
      categorySlug,
      eligibleImpressions: v.impressions,
      clicks: v.clicks,
      ctr: v.impressions >= min ? ratio(v.clicks, v.impressions) : null,
      dataSufficiency: (v.impressions >= min ? "SUFFICIENT" : INSUFFICIENT_DATA) as CategoryCtr["dataSufficiency"],
    }))
    .sort((a, b) => b.eligibleImpressions - a.eligibleImpressions || a.categorySlug.localeCompare(b.categorySlug));
}

export async function trafficSummary(w: Window = defaultWindow()) {
  const [pageViews, sessions] = await Promise.all([
    db.analyticsEvent.count({ where: { event: "page_view", createdAt: within(w) } }),
    db.analyticsEvent.findMany({ where: { event: "page_view", createdAt: within(w), sessionId: { not: null } }, distinct: ["sessionId"], select: { sessionId: true } }),
  ]);
  return { pageViews, sessions: sessions.length };
}
