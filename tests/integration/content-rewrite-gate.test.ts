import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { evaluateQa, publishReview } from "@/lib/pipeline/publish";
import { runIngestion } from "@/lib/pipeline/ingest";
import { buildPageRenderModel } from "@/lib/pipeline/render-model";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { resetDb } from "../support/db";

const admin = { actor: "admin@test" };

/**
 * Owner's rule (2026-10-16): a third-party-sourced review/guide/comparison (EXCERPT rights —
 * scraped, never licensed) must not publish with its original source's name or link. The QA gate
 * (lib/pipeline/publish.ts CONTENT_NOT_REWRITTEN) holds it back until lib/pipeline/rewrite.ts has
 * rewritten it; this only tests the gate itself, not the Claude call.
 */
describe("publish QA gate: a third-party-sourced review waits for the content rewrite", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTaxonomy();
  });

  it("CONTENT_NOT_REWRITTEN blocks an EXCERPT-rights review until contentRewritten is set", async () => {
    // A ReviewSource with no `rights` override defaults to EXCERPT_ONLY (prisma/schema.prisma).
    await db.reviewSource.create({ data: { slug: "packhacker", name: "Pack Hacker", homepageUrl: "https://packhacker.com/", allowedDomains: ["packhacker.com"], startUrls: ["https://packhacker.com/reviews"], reviewUrlPatterns: ["https://packhacker.com/reviews/**"] } });
    await runIngestion({
      trigger: "test",
      source: "apify:packhacker",
      items: [{ id: "pc-1", title: "Westbreeze Packing Cubes review", body: "They hang for easy access, but take up a lot of space.".repeat(5), summary: "A review of the Westbreeze Packing Cubes, tested over a two-week trip.", url: "https://packhacker.com/reviews/pc-1", productName: "Westbreeze Packing Cubes", brand: "Westbreeze", category: "travel", publisher: "Pack Hacker", publishedAt: new Date(Date.now() - 86_400_000).toISOString() }],
    });
    const review = await db.normalizedReview.findFirstOrThrow({ where: { sourceId: "pc-1" } });
    const originalModel = await buildPageRenderModel(review.id);
    expect(originalModel.source).toMatchObject({
      name: "Pack Hacker",
      url: "https://packhacker.com/reviews/pc-1",
      isMade4Buyers: false,
    });

    const failures = await evaluateQa(review.id);
    expect(failures.map((f) => f.code)).toContain("CONTENT_NOT_REWRITTEN");
    expect((await publishReview(review.id, admin)).ok).toBe(false);

    // Once rewritten (lib/pipeline/rewrite.ts sets this on a successful, sufficiently-original rewrite):
    await db.normalizedReview.update({ where: { id: review.id }, data: { contentRewritten: true } });
    const after = await evaluateQa(review.id);
    expect(after.map((f) => f.code)).not.toContain("CONTENT_NOT_REWRITTEN");
    expect((await publishReview(review.id, admin)).ok).toBe(true);
    const rewrittenModel = await buildPageRenderModel(review.id);
    expect(rewrittenModel.source).toMatchObject({
      name: "Made4Buyers",
      url: `https://made4buyers.com/review/${review.slug}`,
      author: null,
      isMade4Buyers: true,
    });
  });

  it("never blocks Keyword-to-Blog (AI_GUIDE) content, which is always FULL rights", async () => {
    await runIngestion({ trigger: "test", source: "keyword-to-blog", items: [{ id: "kg-1", title: "Best travel packing cubes 2026", body: "A guide body.".repeat(10), summary: "A guide.", url: "https://made4buyers.com/internal/kg-1", category: "travel", kind: "AI_GUIDE", publishedAt: new Date().toISOString() }] });
    const review = await db.normalizedReview.findFirstOrThrow({ where: { sourceId: "kg-1" } });
    expect((await evaluateQa(review.id)).map((f) => f.code)).not.toContain("CONTENT_NOT_REWRITTEN");
    expect((await buildPageRenderModel(review.id)).source).toMatchObject({
      name: "Made4Buyers",
      url: `https://made4buyers.com/review/${review.slug}`,
      isMade4Buyers: true,
    });
  });
});
