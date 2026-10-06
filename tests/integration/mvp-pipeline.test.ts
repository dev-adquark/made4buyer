import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { reviewsWithVerifiedDeal } from "@/lib/analytics/metrics";
import { confirmEntities } from "@/lib/admin/overrides";
import { runIngestion } from "@/lib/pipeline/ingest";
import { processReview } from "@/lib/pipeline/process";
import { publishReview } from "@/lib/pipeline/publish";
import { buildPageRenderModel } from "@/lib/pipeline/render-model";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { resetDb } from "../support/db";
import { sampleEnvironment } from "../support/pipeline";

/**
 * MVP launch path on the SAMPLE dataset (15 items → 13 reviews, 7 categories):
 * Content API → normalize → dedupe → entities → taxonomy → image → commerce-offer check →
 * admin QA → publish. Coverage numbers here describe SAMPLE stub data only.
 */
let env: Awaited<ReturnType<typeof sampleEnvironment>>;
beforeAll(async () => {
  await seedTaxonomy();
  await resetDb();
  env = await sampleEnvironment();
});
afterAll(() => env.close());

describe("MVP pipeline on sample data", () => {
  it("runs end to end and meets the structural MVP criteria", async () => {
    const run = await runIngestion({ trigger: "mvp-test" });
    expect(run.normalized).toBeGreaterThanOrEqual(10);

    // Admin QA: resolve the item that needs review, then publish everything that passes.
    for (const r of await db.normalizedReview.findMany({ where: { status: "NEEDS_REVIEW" } })) {
      await confirmEntities(r.id, { actor: "qa" });
      await processReview(r.id, { from: "ENTITY_EXTRACTION", skipImage: true });
    }
    for (const r of await db.normalizedReview.findMany({ where: { status: "QUEUED" } })) {
      expect((await publishReview(r.id, { actor: "qa" })).ok).toBe(true);
    }

    const published = await db.normalizedReview.findMany({ where: { status: "PUBLISHED" }, select: { id: true, categorySlug: true } });
    expect(published.length).toBeGreaterThanOrEqual(10);
    expect(new Set(published.map((p) => p.categorySlug)).size).toBeGreaterThanOrEqual(3);

    const withDeal = await reviewsWithVerifiedDeal({ status: "PUBLISHED" });
    // No commerce-engine data in the sample: no prices, nothing invented.
    expect(withDeal).toBe(0);

    // Public render model for a published page contains only public-safe data.
    const model = await buildPageRenderModel(published[0].id);
    expect(JSON.stringify(model)).not.toMatch(/verificationReason|redirectChain|scoreBreakdown|affiliateUrl/);
  });
});
