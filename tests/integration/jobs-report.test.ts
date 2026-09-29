import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { acquireLock, LockHeldError, releaseLock, withLock } from "@/lib/jobs/lock";
import { runJob } from "@/lib/jobs/registry";
import { runCacheCleanup, runFailedRetry } from "@/lib/jobs/revalidation";
import { runIngestion } from "@/lib/pipeline/ingest";
import { publishReview } from "@/lib/pipeline/publish";
import { buildDay30Report, generateDay30Report } from "@/lib/reports/day30";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";
import { sampleEnvironment } from "../support/pipeline";

let env: Awaited<ReturnType<typeof sampleEnvironment>>;
beforeAll(async () => {
  await seedTaxonomy();
  env = await sampleEnvironment();
});
afterAll(() => env.close());
beforeEach(() => resetDb());

describe("job locking", () => {
  it("is exclusive and recovers stale locks", async () => {
    const owner = await acquireLock("t", 60_000);
    expect(owner).toBeTruthy();
    expect(await acquireLock("t", 60_000)).toBeNull();
    await expect(withLock("t", 60_000, async () => 1)).rejects.toBeInstanceOf(LockHeldError);
    await releaseLock("t", owner!);
    expect(await withLock("t", 60_000, async () => 42)).toBe(42);
    await db.jobLock.create({ data: { name: "stale", owner: "crashed", expiresAt: new Date(Date.now() - 1000) } });
    expect(await acquireLock("stale", 60_000)).toBeTruthy();
  });

  it("cron job runner refuses concurrent runs of the same job", async () => {
    const owner = await acquireLock("job:verify-links", 60_000);
    await expect(runJob("verify-links", "test")).rejects.toBeInstanceOf(LockHeldError);
    await releaseLock("job:verify-links", owner!);
    await expect(runJob("verify-links", "test")).resolves.toBeTruthy();
  });
});

describe("retry and cleanup jobs", () => {
  it("retries due retryable failures and exhausts after maxRetries", async () => {
    await runIngestion({ trigger: "test" });
    const link = await db.affiliateLink.findFirstOrThrow({ where: { verificationStatus: "VERIFIED_OK" } });
    await db.affiliateLink.update({ where: { id: link.id }, data: { verificationStatus: "TIMEOUT" } });
    const failure = await db.pipelineFailure.create({ data: { fingerprint: "f1", stage: "LINK_VERIFICATION", kind: "RETRYABLE_FAILURE", errorCode: "LINK_VERIFICATION_TIMEOUT", message: "t", entityType: "affiliate_link", entityId: link.id, normalizedReviewId: link.normalizedReviewId, nextRetryAt: new Date(Date.now() - 1000) } });
    const exhausted = await db.pipelineFailure.create({ data: { fingerprint: "f2", stage: "OFFER_MATCHING", kind: "RETRYABLE_FAILURE", errorCode: "SOVRN_TIMEOUT", message: "t", entityType: "normalized_review", entityId: "x", retryCount: 5, maxRetries: 5, nextRetryAt: new Date(Date.now() - 1000) } });
    const res = await runFailedRetry({ trigger: "test" });
    expect(res.checked).toBe(2);
    expect((await db.affiliateLink.findUniqueOrThrow({ where: { id: link.id } })).verificationStatus).toBe("VERIFIED_OK");
    expect((await db.pipelineFailure.findUniqueOrThrow({ where: { id: failure.id } })).resolvedAt).not.toBeNull();
    expect(await db.pipelineFailure.findUniqueOrThrow({ where: { id: exhausted.id } })).toMatchObject({ kind: "PERMANENT_FAILURE", nextRetryAt: null });
  });

  it("cleans up expired cache rows, sessions and stale locks", async () => {
    await db.sovrnOfferCache.create({ data: { queryKey: "old", requestHash: "h-old", expiresAt: new Date(Date.now() - 30 * 86_400_000), providerStatus: "OK" } });
    await db.adminSession.create({ data: { id: "s1", email: "a", expiresAt: new Date(Date.now() - 1000) } });
    await db.jobLock.create({ data: { name: "dead", owner: "x", expiresAt: new Date(Date.now() - 1000) } });
    const res = await runCacheCleanup({ trigger: "test" });
    expect(res.reasons).toMatchObject({ sovrn_cache: 1, admin_sessions: 1, stale_locks: 1 });
  });
});

describe("Day-30 report", () => {
  it("reports real counts and never fabricates GSC or CTR data", async () => {
    const r = withEnv({ GSC_SITE_URL: undefined, GSC_SERVICE_ACCOUNT_JSON: undefined });
    await runIngestion({ trigger: "test" });
    for (const rev of await db.normalizedReview.findMany({ where: { status: "QUEUED" } })) await publishReview(rev.id, { actor: "t" });
    const report = await buildDay30Report();
    r();
    expect(report.ingestion).toMatchObject({ totalFetched: 15, duplicates: 1, published: 12, normalized: 13 });
    expect(report.dealCoverage.publishedReviews).toBe(12);
    expect(report.dealCoverage.reviewsWithVerifiedDeal).toBeGreaterThan(0);
    expect(report.linkHealth.checked).toBeGreaterThan(0);
    expect(report.seoIndexing).toMatchObject({ status: "NOT_AVAILABLE_IN_ENVIRONMENT", indexed: "NOT_AVAILABLE_IN_ENVIRONMENT" });
    expect(report.ctr.note).toMatch(/INSUFFICIENT_DATA/);
    expect(report.topFailureReasons.map((f) => f.errorCode)).toContain("SOVRN_NO_MATCH");
    expect(report.categorization.acceptanceRate).toBe("INSUFFICIENT_DATA");

    await db.analyticsEvent.createMany({ data: Array.from({ length: 5 }, () => ({ event: "deal_impression", categorySlug: "phones" })) });
    const withCtr = await buildDay30Report();
    expect(withCtr.ctr.categories).toEqual([expect.objectContaining({ categorySlug: "phones", eligibleImpressions: 5, ctr: "INSUFFICIENT_DATA", dataSufficiency: "INSUFFICIENT_DATA" })]);

    const saved = await generateDay30Report({ actor: "test" });
    const row = await db.day30Report.findUniqueOrThrow({ where: { id: saved.id } });
    expect(row.html).toContain("<!doctype html>");
    expect(row.json).toMatchObject({ reportType: "DAY_30_SUCCESS_REPORT" });
  });
});
