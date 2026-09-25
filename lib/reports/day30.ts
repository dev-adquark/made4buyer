import type { Prisma } from "@prisma/client";
import { config, INSUFFICIENT_DATA, integrationStatus, NOT_AVAILABLE_IN_ENVIRONMENT, releaseInfo } from "@/lib/config";
import { db } from "@/lib/db";
import { gscConfigured } from "@/lib/gsc";
import { ctrByCategory, defaultWindow, ratio, reviewsWithVerifiedDeal, successMetrics, type Window } from "@/lib/analytics/metrics";
import { renderDay30Html } from "./day30-html";
import releaseNotes from "./release-notes.json";

/**
 * Day-30 success report. Every figure is a query over persisted records for the window.
 * Integrations that are not configured are reported as NOT_AVAILABLE_IN_ENVIRONMENT /
 * BLOCKED_BY_ENVIRONMENT, never as zero or as an estimate.
 */

export type Day30Report = Awaited<ReturnType<typeof buildDay30Report>>;

const pct = (n: number, d: number) => ratio(n, d);

export async function buildDay30Report(window: Window = defaultWindow(30)) {
  const w = { gte: window.start, lte: window.end };
  const threshold = config.taxonomy.autoAcceptThreshold();

  const [runs, contentStatus, reviewStatus, published, reviewsCreated] = await Promise.all([
    db.ingestionRun.aggregate({ where: { startedAt: w }, _sum: { totalFetched: true, normalizedCount: true, duplicateCount: true, failedNormalizationCount: true, failureCount: true, unchangedCount: true }, _count: { _all: true } }),
    db.contentItem.groupBy({ by: ["processingStatus"], where: { createdAt: w }, _count: { _all: true } }),
    db.normalizedReview.groupBy({ by: ["status"], where: { createdAt: w }, _count: { _all: true } }),
    db.normalizedReview.count({ where: { status: "PUBLISHED" } }),
    db.normalizedReview.count({ where: { createdAt: w } }),
  ]);
  const byReview = (s: string) => reviewStatus.find((r) => r.status === s)?._count._all ?? 0;
  const byContent = (s: string) => contentStatus.find((r) => r.processingStatus === s)?._count._all ?? 0;
  const publishedInWindow = byReview("PUBLISHED");

  // Deal coverage over currently published reviews.
  const [matched, withVerified, noMatch, unavailable] = await Promise.all([
    db.normalizedReview.count({ where: { status: "PUBLISHED", dealStatus: "MATCHED" } }),
    reviewsWithVerifiedDeal({ status: "PUBLISHED" }),
    db.normalizedReview.count({ where: { status: "PUBLISHED", dealStatus: "NO_MATCH" } }),
    db.normalizedReview.count({ where: { status: "PUBLISHED", dealStatus: "UNAVAILABLE" } }),
  ]);

  const linkGroups = await db.affiliateLink.groupBy({ by: ["verificationStatus"], where: { isActive: true, lastVerifiedAt: w }, _count: { _all: true } });
  const link = (s: string) => linkGroups.find((g) => g.verificationStatus === s)?._count._all ?? 0;
  const linksChecked = linkGroups.reduce((n, g) => n + g._count._all, 0);

  const [assignTotal, assignHigh, assignLow, assignAccepted, assignRejected] = await Promise.all([
    db.reviewCategoryAssignment.count({ where: { tagType: "CATEGORY", createdAt: w } }),
    db.reviewCategoryAssignment.count({ where: { tagType: "CATEGORY", createdAt: w, confidence: { gte: threshold } } }),
    db.reviewCategoryAssignment.count({ where: { tagType: "CATEGORY", createdAt: w, confidence: { lt: threshold } } }),
    db.reviewCategoryAssignment.count({ where: { tagType: "CATEGORY", createdAt: w, reviewState: "ACCEPTED", isOverride: false } }),
    db.reviewCategoryAssignment.count({ where: { tagType: "CATEGORY", createdAt: w, reviewState: "REJECTED" } }),
  ]);

  const imageGroups = await db.imageAsset.groupBy({ by: ["enrichmentStatus", "licenseState", "isFallback"], where: { isPrimary: true, createdAt: w }, _count: { _all: true } });
  const imgSum = (f: (g: (typeof imageGroups)[number]) => boolean) => imageGroups.filter(f).reduce((n, g) => n + g._count._all, 0);

  let seo: Record<string, unknown>;
  if (!gscConfigured()) {
    seo = { status: NOT_AVAILABLE_IN_ENVIRONMENT, indexed: NOT_AVAILABLE_IN_ENVIRONMENT, notIndexed: NOT_AVAILABLE_IN_ENVIRONMENT, indexingPercentage: NOT_AVAILABLE_IN_ENVIRONMENT };
  } else {
    const checks = await db.searchIndexCheck.findMany({ where: { checkedAt: w, verdict: { in: ["INDEXED", "NOT_INDEXED"] } }, orderBy: { checkedAt: "desc" }, distinct: ["url"], select: { verdict: true } });
    const indexed = checks.filter((c) => c.verdict === "INDEXED").length;
    seo = checks.length
      ? { status: "OK", inspectedUrls: checks.length, publishedReviews: published, indexed, notIndexed: checks.length - indexed, indexingPercentage: pct(indexed, checks.length) }
      : { status: INSUFFICIENT_DATA, inspectedUrls: 0, note: "Search Console is configured but no URL inspections ran in this window (see /api/cron/inspect-index)." };
  }

  const ctr = await ctrByCategory(window);
  const failures = await db.pipelineFailure.groupBy({ by: ["errorCode", "stage"], where: { lastOccurredAt: w }, _sum: { occurrences: true }, _max: { lastOccurredAt: true } });
  const totalOccurrences = failures.reduce((n, f) => n + (f._sum.occurrences ?? 0), 0);

  const integrations = integrationStatus();
  const release = releaseInfo();

  return {
    reportType: "DAY_30_SUCCESS_REPORT",
    generatedAt: new Date().toISOString(),
    period: { start: window.start.toISOString(), end: window.end.toISOString() },
    environment: { ...release, integrations },
    ingestion: {
      runs: runs._count._all,
      totalFetched: runs._sum.totalFetched ?? 0,
      unchangedRefetches: runs._sum.unchangedCount ?? 0,
      totalIngested: byContent("INGESTED") + byContent("NORMALIZED") + byContent("QUEUED") + byContent("PUBLISHED") + byContent("REJECTED") + byContent("DUPLICATE") + byContent("FAILED"),
      normalized: reviewsCreated,
      duplicates: runs._sum.duplicateCount ?? 0,
      failures: (runs._sum.failedNormalizationCount ?? 0) + (runs._sum.failureCount ?? 0),
      publishQueue: byReview("QUEUED"),
      needsReview: byReview("NEEDS_REVIEW"),
      published: publishedInWindow,
      publicationPercentage: pct(publishedInWindow, reviewsCreated),
    },
    dealCoverage: {
      sovrnIntegration: integrations.sovrn,
      publishedReviews: published,
      matchedReviews: matched,
      reviewsWithVerifiedDeal: withVerified,
      unmatchedReviews: noMatch,
      providerUnavailable: unavailable,
      coveragePercentage: pct(withVerified, published),
    },
    linkHealth: {
      checked: linksChecked,
      verified: link("VERIFIED_OK"),
      invalid: link("INVALID"),
      blocked: link("BLOCKED") + link("FORBIDDEN"),
      mismatch: link("REDIRECT_MISMATCH"),
      unavailable: link("UNAVAILABLE"),
      timeout: link("TIMEOUT"),
      providerError: link("PROVIDER_ERROR"),
      verificationPercentage: pct(link("VERIFIED_OK"), linksChecked),
    },
    categorization: {
      totalAssignments: assignTotal,
      highConfidence: assignHigh,
      lowConfidence: assignLow,
      adminAccepted: assignAccepted,
      adminRejected: assignRejected,
      acceptanceRate: assignAccepted + assignRejected > 0 ? pct(assignAccepted, assignAccepted + assignRejected) : INSUFFICIENT_DATA,
      autoAcceptThreshold: threshold,
    },
    images: {
      enriched: imgSum((g) => g.enrichmentStatus === "ENRICHED"),
      fallback: imgSum((g) => g.isFallback),
      licenseSafe: imgSum((g) => g.licenseState === "VERIFIED" || g.licenseState === "OWNED_PLACEHOLDER"),
      providerAssertedLicense: imgSum((g) => g.licenseState === "PROVIDER_ASSERTED"),
      licenseUnverified: imgSum((g) => g.licenseState === "UNVERIFIED"),
      unavailable: imgSum((g) => g.enrichmentStatus === "FAILED"),
      imageProvider: integrations.imageProvider,
    },
    seoIndexing: seo,
    ctr: {
      minimumImpressions: config.analytics.minImpressionsForCtr(),
      categories: ctr.map((c) => ({ ...c, ctr: c.ctr ?? INSUFFICIENT_DATA })),
      note: ctr.length ? undefined : `${INSUFFICIENT_DATA}: no deal impressions recorded in this window`,
    },
    successMetrics: await successMetrics(window),
    topFailureReasons: failures
      .map((f) => ({ errorCode: f.errorCode, stage: f.stage, count: f._sum.occurrences ?? 0, percentage: pct(f._sum.occurrences ?? 0, totalOccurrences), latestOccurrence: f._max.lastOccurredAt?.toISOString() ?? null }))
      .sort((a, b) => b.count - a.count || a.errorCode.localeCompare(b.errorCode))
      .slice(0, 15),
    fixesShipped: {
      commit: release.commit,
      source: (releaseNotes as { source?: string }).source ?? "unavailable",
      changes: ((releaseNotes as { changes?: Array<{ sha: string; date: string; subject: string }> }).changes ?? []).filter((c) => new Date(c.date) >= window.start),
    },
  };
}

export async function generateDay30Report(opts: { actor: string; window?: Window }) {
  const report = await buildDay30Report(opts.window);
  const html = renderDay30Html(report);
  const row = await db.day30Report.create({
    data: { periodStart: new Date(report.period.start), periodEnd: new Date(report.period.end), generatedBy: opts.actor, json: report as unknown as Prisma.InputJsonValue, html },
  });
  return { id: row.id, report, html };
}
