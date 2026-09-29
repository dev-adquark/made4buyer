import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { successMetrics } from "@/lib/analytics/metrics";
import { runIngestion } from "@/lib/pipeline/ingest";
import { evaluateQa, publishReview, rejectReview, restoreReview, runPublishCycle, unpublishReview } from "@/lib/pipeline/publish";
import { confirmEntities, setCategoryOverride } from "@/lib/admin/overrides";
import { processReview } from "@/lib/pipeline/process";
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

  it("blocks low-confidence reviews at the QA gate until an editor resolves them", async () => {
    const r = await review("s-014");
    const blocked = await publishReview(r.id, admin);
    expect(blocked.ok).toBe(false);
    expect(await db.publishJob.count({ where: { normalizedReviewId: r.id, status: "FAILED", errorCode: "PUBLISH_QA_FAILED" } })).toBe(1);
    expect(await db.pipelineFailure.count({ where: { stage: "PUBLISH", errorCode: "PUBLISH_QA_FAILED", entityId: r.id } })).toBe(1);

    await confirmEntities(r.id, admin);
    await setCategoryOverride(r.id, "accessories", null, admin, "ADMIN");
    await processReview(r.id, { from: "ENTITY_EXTRACTION", skipImage: true });
    expect(await evaluateQa(r.id)).toEqual([]);
    const ok = await publishReview(r.id, admin);
    expect(ok.ok).toBe(true);
    const metrics = await successMetrics();
    const pageError = metrics.find((m) => m.key === "page_error_rate")!;
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

  it("auto-publish cycle only runs when enabled", async () => {
    expect((await runPublishCycle(admin)).enabled).toBe(false);
    const r = withEnv({ AUTO_PUBLISH_ENABLED: "true" });
    const res = await runPublishCycle({ actor: "system" });
    r();
    expect(res.enabled).toBe(true);
    expect(res.published).toBe(12);
    expect(await db.normalizedReview.count({ where: { status: "PUBLISHED" } })).toBe(12);
  });
});
