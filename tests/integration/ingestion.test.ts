import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { runIngestion } from "@/lib/pipeline/ingest";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { startStubServer } from "../../scripts/support/stub-server";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

let stub: Awaited<ReturnType<typeof startStubServer>>;
let restore: () => void;
let override: (() => unknown) | undefined;

beforeAll(async () => {
  await seedTaxonomy();
  stub = await startStubServer({ contentKey: "content-key", contentOverride: () => override?.() ?? undefined });
  restore = withEnv({ CONTENT_API_URL: `${stub.base}/content`, CONTENT_API_KEY: "content-key", CONTENT_API_SOURCE_NAME: "sample-fixture", SOVRN_API_URL: undefined, SOVRN_API_KEY: undefined, AUTO_PUBLISH_ENABLED: undefined });
});
afterAll(async () => {
  restore();
  await stub.close();
});
beforeEach(async () => {
  override = undefined;
  await resetDb();
});

describe("Content API ingestion", () => {
  it("persists raw snapshots, isolates malformed items, dedupes and records the run", async () => {
    const summary = await runIngestion({ trigger: "test" });
    expect(summary.status).toBe("COMPLETED_WITH_ERRORS");
    expect(summary.totalFetched).toBe(15);
    expect(summary.failedNormalization).toBe(1);
    expect(summary.duplicates).toBe(1);
    expect(summary.normalized).toBe(13);

    const run = await db.ingestionRun.findUniqueOrThrow({ where: { id: summary.runId } });
    expect(run).toMatchObject({ totalFetched: 15, normalizedCount: 13, duplicateCount: 1, failedNormalizationCount: 1, source: "sample-fixture" });
    expect(run.completedAt).not.toBeNull();
    expect(run.failureReasonSummary).toMatchObject({ CONTENT_SCHEMA_INVALID: 1, DUPLICATE_REVIEW: 1 });

    const items = await db.contentItem.groupBy({ by: ["processingStatus"], _count: { _all: true } });
    const count = (s: string) => items.find((i) => i.processingStatus === s)?._count._all ?? 0;
    expect(count("FAILED")).toBe(1);
    expect(count("DUPLICATE")).toBe(1);
    expect(count("QUEUED") + count("NORMALIZED")).toBe(13);

    const dup = await db.contentItem.findFirstOrThrow({ where: { sourceId: "s-013-dup" }, include: { normalizedReview: true } });
    expect(dup.errorCode).toBe("DUPLICATE_REVIEW");
    expect(dup.normalizedReview?.sourceId).toBe("s-004");
    const bad = await db.contentItem.findFirstOrThrow({ where: { processingStatus: "FAILED" } });
    expect(bad.errorCode).toBe("CONTENT_SCHEMA_INVALID");
    expect(bad.rawPayload).toMatchObject({ title: "Broken item" });
    expect(await db.pipelineFailure.count({ where: { stage: "VALIDATION", errorCode: "CONTENT_SCHEMA_INVALID" } })).toBe(1);
  });

  it("runs every review stage and persists their records", async () => {
    await runIngestion({ trigger: "test" });
    const reviews = await db.normalizedReview.findMany({ include: { entities: true, assignments: { where: { active: true, tagType: "CATEGORY" } }, images: true } });
    expect(reviews).toHaveLength(13);
    for (const r of reviews) {
      expect(r.entities).not.toBeNull();
      expect(r.images.filter((i) => i.isPrimary)).toHaveLength(1);
      expect(r.dealStatus).toBe("UNAVAILABLE"); // Sovrn not configured in this test → honest state
      expect(r.assignments.length).toBe(1);
    }
    const categories = new Set(reviews.map((r) => r.categorySlug));
    expect(categories.size).toBeGreaterThanOrEqual(3);
    const ambiguous = reviews.find((r) => r.sourceId === "s-014")!;
    expect(ambiguous.status).toBe("NEEDS_REVIEW");
    expect(ambiguous.entities?.lowConfidenceFields).toEqual(expect.arrayContaining(["productName", "brand"]));
    const mba = reviews.find((r) => r.sourceId === "s-001")!;
    expect(mba.status).toBe("QUEUED");
    expect(mba.images[0]).toMatchObject({ sourceType: "CONTENT_API", licenseState: "PROVIDER_ASSERTED", isFallback: false });
    const pixel = reviews.find((r) => r.sourceId === "s-004")!;
    expect(pixel.images[0]).toMatchObject({ sourceType: "CONTENT_API", licenseState: "UNVERIFIED" });
    expect(await db.pipelineFailure.count({ where: { errorCode: "SOVRN_NOT_CONFIGURED" } })).toBe(13);
  });

  it("is idempotent: a re-run with unchanged content creates nothing new", async () => {
    await runIngestion({ trigger: "test" });
    const before = { reviews: await db.normalizedReview.count(), items: await db.contentItem.count(), assignments: await db.reviewCategoryAssignment.count() };
    const second = await runIngestion({ trigger: "test" });
    expect(second.unchanged).toBe(14); // 13 normalized + 1 known duplicate; the malformed item is re-validated
    expect(second.failedNormalization).toBe(1);
    expect(second.normalized).toBe(0);
    expect(second.duplicates).toBe(0);
    expect({ reviews: await db.normalizedReview.count(), items: await db.contentItem.count(), assignments: await db.reviewCategoryAssignment.count() }).toEqual(before);
  });

  it("re-processes changed content but keeps admin text edits", async () => {
    await runIngestion({ trigger: "test" });
    const r = await db.normalizedReview.findFirstOrThrow({ where: { sourceId: "s-010" } });
    await db.normalizedReview.update({ where: { id: r.id }, data: { summary: "Edited by an admin and locked.", manualEditLocked: true } });
    const original = (await import("../../fixtures/sample-content.json")).default as { items: Array<Record<string, unknown>> };
    override = () => ({ items: original.items.map((i) => (i.id === "s-010" ? { ...i, body: `${i.body as string}\n\nUpdated paragraph from the source.` } : i)) });
    const second = await runIngestion({ trigger: "test" });
    expect(second.updated).toBe(1);
    const after = await db.normalizedReview.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.summary).toBe("Edited by an admin and locked.");
    expect(after.slug).toBe(r.slug);
  });

  it("records a coded failure when the Content API is down, and when it is unconfigured", async () => {
    const r1 = withEnv({ CONTENT_API_URL: `${stub.base}/does-not-exist`, CONTENT_API_MAX_RETRIES: "1" });
    const down = await runIngestion({ trigger: "test" });
    r1();
    expect(down.status).toBe("FAILED");
    expect(down.reasons).toHaveProperty("CONTENT_API_HTTP_ERROR");
    expect(stub.requests.filter((q) => q.path === "/does-not-exist").length).toBe(1); // 404 is not retried

    const r2 = withEnv({ CONTENT_API_URL: undefined });
    const unconfigured = await runIngestion({ trigger: "test" });
    r2();
    expect(unconfigured.reasons).toHaveProperty("CONTENT_API_NOT_CONFIGURED");
    const run = await db.ingestionRun.findUniqueOrThrow({ where: { id: unconfigured.runId } });
    expect(run.status).toBe("FAILED");
    expect(JSON.stringify(run.failureReasonSummary)).toContain("BLOCKED_BY_ENVIRONMENT");
  });

  it("rejects wrong Content API credentials without crashing", async () => {
    const r = withEnv({ CONTENT_API_KEY: "wrong", CONTENT_API_MAX_RETRIES: "0" });
    const res = await runIngestion({ trigger: "test" });
    r();
    expect(res.status).toBe("FAILED");
    expect(res.reasons).toHaveProperty("CONTENT_API_HTTP_ERROR");
  });

  it("prevents concurrent ingestion runs with a DB lock", async () => {
    const results = await Promise.allSettled([runIngestion({ trigger: "a" }), runIngestion({ trigger: "b" })]);
    expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([expect.stringMatching(/already running/)]);
  });
});
