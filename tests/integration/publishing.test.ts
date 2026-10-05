import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { successMetrics } from "@/lib/analytics/metrics";
import { runIngestion } from "@/lib/pipeline/ingest";
import { evaluateQa, publishReview, rejectReview, restoreReview, runPublishCycle, unpublishReview } from "@/lib/pipeline/publish";
import { setSwitch } from "@/lib/automation/settings";
import { reviewAssignment, seedTaxonomy } from "@/lib/taxonomy/persist";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";
import { sampleEnvironment } from "../support/pipeline";

const admin = { actor: "admin@test" };
let env: Awaited<ReturnType<typeof sampleEnvironment>>;

beforeAll(async () => {
  await seedTaxonomy();
  env = await sampleEnvironment();
});
afterAll(() => env.close());
beforeEach(async () => {
  await resetDb();
  await runIngestion({ trigger: "test" });
});

const review = (sourceId: string) => db.normalizedReview.findFirstOrThrow({ where: { sourceId } });

describe("publishing", () => {
  it("publishes a QA-passing review with a PublishJob, render model, audit and analytics event", async () => {
    const r = await review("s-001");
    const res = await publishReview(r.id, admin);
    expect(res.ok).toBe(true);
    const after = await db.normalizedReview.findUniqueOrThrow({ where: { id: r.id }, include: { renderModel: true, publishJobs: true } });
    expect(after.status).toBe("PUBLISHED");
    expect(after.publishedAt).not.toBeNull();
    expect(after.renderModel?.model).toMatchObject({ slug: r.slug, canonicalPath: `/review/${r.slug}` });
    expect((after.renderModel?.model as { deals: unknown[] }).deals.length).toBeGreaterThan(0);
    expect(after.publishJobs).toEqual([expect.objectContaining({ action: "PUBLISH", status: "SUCCEEDED", actor: "admin@test" })]);
    expect(await db.auditLog.count({ where: { action: "review.publish", entityId: r.id } })).toBe(1);
    expect(await db.analyticsEvent.count({ where: { event: "publish", normalizedReviewId: r.id } })).toBe(1);
    expect(await db.contentItem.count({ where: { normalizedReviewId: r.id, processingStatus: "PUBLISHED" } })).toBe(1);
  });

  it("low-confidence category/entities never wait for an editor; hard rules still block", async () => {
    const r = await review("s-014");
    const entities = await db.extractedEntities.findUniqueOrThrow({ where: { normalizedReviewId: r.id } });
    expect(entities.lowConfidenceFields.length).toBeGreaterThan(0);
    const codes = (await evaluateQa(r.id)).map((f) => f.code);
    expect(codes).not.toContain("ENTITIES_NEED_REVIEW");
    expect(codes).not.toContain("CATEGORY_NEEDS_REVIEW");
    expect((await publishReview(r.id, admin)).ok).toBe(true);

    // A hard rule (rejected) still blocks, and the failed attempt is recorded.
    const other = await review("s-002");
    await rejectReview(other.id, admin, "test");
    expect((await publishReview(other.id, admin)).ok).toBe(false);
    expect(await db.publishJob.count({ where: { normalizedReviewId: other.id, status: "FAILED", errorCode: "PUBLISH_QA_FAILED" } })).toBe(1);
    expect(await db.pipelineFailure.count({ where: { stage: "PUBLISH", errorCode: "PUBLISH_QA_FAILED", entityId: other.id } })).toBe(1);
    const pageError = (await successMetrics()).find((m) => m.key === "page_error_rate")!;
    expect(pageError).toMatchObject({ numerator: 1, denominator: 2 });
  });

  it("accepting an automatic assignment counts toward categorization acceptance", async () => {
    const r = await review("s-002");
    const a = await db.reviewCategoryAssignment.findFirstOrThrow({ where: { normalizedReviewId: r.id, tagType: "CATEGORY", active: true } });
    await reviewAssignment(a.id, "ACCEPTED", admin.actor);
    const m = (await successMetrics()).find((x) => x.key === "categorization_acceptance")!;
    expect(m).toMatchObject({ numerator: 1, denominator: 1 });
  });

  it("supports unpublish, reject and restore, and preserves the original publication timestamp", async () => {
    const r = await review("s-004");
    await publishReview(r.id, admin);
    const first = (await db.normalizedReview.findUniqueOrThrow({ where: { id: r.id } })).publishedAt!;
    await unpublishReview(r.id, admin);
    expect((await db.normalizedReview.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("UNPUBLISHED");
    await restoreReview(r.id, admin);
    expect((await db.normalizedReview.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("QUEUED");
    await publishReview(r.id, admin);
    expect((await db.normalizedReview.findUniqueOrThrow({ where: { id: r.id } })).publishedAt!.toISOString()).toBe(first.toISOString());
    await rejectReview(r.id, admin, "test");
    const rejected = await db.normalizedReview.findUniqueOrThrow({ where: { id: r.id } });
    expect(rejected.status).toBe("REJECTED");
    expect((await publishReview(r.id, admin)).ok).toBe(false);
    await restoreReview(r.id, admin);
    expect((await db.normalizedReview.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("QUEUED");
    const actions = (await db.auditLog.findMany({ where: { entityId: r.id }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(["review.publish", "review.unpublish", "review.restore", "review.publish", "review.reject", "review.publish_failed", "review.restore"]);
  });

  it("auto-publish cycle is on by default, off when disabled by env or paused in Admin", async () => {
    expect((await runPublishCycle(admin)).enabled).toBe(false); // AUTO_PUBLISH_ENABLED=false here
    const r = withEnv({ AUTO_PUBLISH_ENABLED: undefined });
    try {
      await setSwitch("scheduled_publishing", false, admin);
      expect((await runPublishCycle(admin)).enabled).toBe(false);
      await setSwitch("scheduled_publishing", true, admin);
      const res = await runPublishCycle({ actor: "system" });
      expect(res.enabled).toBe(true);
      const total = await db.normalizedReview.count();
      expect(res.published).toBe(total);
      expect(await db.normalizedReview.count({ where: { status: "PUBLISHED" } })).toBe(total);
    } finally {
      r();
    }
  });
});
