import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { runCollectScrapes, runScrapeSources, sourceKey } from "@/lib/pipeline/apify";
import { buildPageRenderModel } from "@/lib/pipeline/render-model";
import { fetchSovrnOffers } from "@/lib/sovrn/client";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { startStubServer } from "../../scripts/support/stub-server";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

// All Apify responses here come from the local stub and fixtures/sample-apify-items.json (SAMPLE data).
let stub: Awaited<ReturnType<typeof startStubServer>>;
let restore: () => void;

beforeAll(async () => {
  await seedTaxonomy();
  stub = await startStubServer({ sovrnKey: "sovrn-test" });
  restore = withEnv({ APIFY_API_TOKEN: "test-apify-token", APIFY_API_BASE_URL: `${stub.base}/apify/v2`, CONTENT_API_URL: undefined, SOVRN_API_URL: `${stub.base}/sovrn`, SOVRN_API_KEY: "sovrn-test" });
});
afterAll(async () => {
  restore();
  await stub.close();
});
beforeEach(() => resetDb());

const addSource = (over: Record<string, unknown> = {}) =>
  db.reviewSource.create({
    data: { slug: "example", name: "Example Reviews", homepageUrl: `${stub.base}/`, allowedDomains: ["example.test"], startUrls: [`${stub.base}/listing`], reviewUrlPatterns: ["https://reviews.example.test/reviews/**"], enabled: true, ...over },
  });

describe("Apify scrape → collect → ingestion", () => {
  it("starts due runs, ingests valid pages into QA and rejects the rest with reasons", async () => {
    const source = await addSource();
    const started = await runScrapeSources("test");
    expect(started).toMatchObject({ started: 1 });
    const run = await db.apifyRun.findFirstOrThrow({ where: { sourceId: source.id } });
    // The actor input carries robots compliance and the source's own review patterns.
    const start = stub.requests.find((r) => r.method === "POST" && r.path.includes("/runs"));
    expect(start).toBeTruthy();

    const collected = await runCollectScrapes("test");
    expect(collected).toMatchObject({ collected: 1 });
    const result = collected.results![0] as { items: number; accepted: number; rejections: Record<string, number> };
    expect(result.items).toBe(5);
    expect(result.rejections).toMatchObject({ SOURCE_NOT_ALLOWED: 1, DUPLICATE_REVIEW: 1, PUBLICATION_DATE_FUTURE: 1, CONTENT_TOO_SHORT: 1 });

    const reviews = await db.normalizedReview.findMany({ where: { source: sourceKey("example") } });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ kind: "REVIEW", canonicalUrl: "https://reviews.example.test/reviews/framework-laptop-13", status: expect.not.stringMatching("PUBLISHED") });
    expect(reviews[0].sourcePublishedAt?.toISOString()).toBe("2026-09-20T08:00:00.000Z");
    const failures = await db.contentItem.findMany({ where: { source: sourceKey("example"), processingStatus: "FAILED" }, select: { errorCode: true } });
    expect(failures.map((f) => f.errorCode).sort()).toEqual(["CONTENT_TOO_SHORT", "PUBLICATION_DATE_FUTURE"]);
    expect(await db.pipelineFailure.count({ where: { errorCode: "SOURCE_NOT_ALLOWED" } })).toBe(1);
    expect(await db.apifyRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "COLLECTED", itemCount: 5 });

    // Idempotent: collecting again does nothing, scraping again waits for the crawl interval.
    expect(await runCollectScrapes("test")).toMatchObject({ checked: 0, collected: 0 });
    expect(await runScrapeSources("test")).toMatchObject({ started: 0 });
    expect(await db.normalizedReview.count({ where: { source: sourceKey("example") } })).toBe(1);
  });

  it("shows scraped text as an excerpt unless the source is licensed", async () => {
    const source = await addSource();
    await runScrapeSources("test");
    await runCollectScrapes("test");
    const review = await db.normalizedReview.findFirstOrThrow({ where: { source: sourceKey("example") } });
    const excerpt = await buildPageRenderModel(review.id);
    expect(excerpt.textRights).toBe("EXCERPT");
    expect(excerpt.bodyParagraphs).toEqual([]);
    expect(review.body.length).toBeGreaterThan(120); // kept privately for extraction
    await db.reviewSource.update({ where: { id: source.id }, data: { rights: "LICENSED" } });
    const full = await buildPageRenderModel(review.id);
    expect(full.textRights).toBe("FULL");
    expect(full.bodyParagraphs.length).toBeGreaterThan(1);
  });

  it("reports a rejected token as APIFY_AUTH_FAILED and blocks cleanly without one", async () => {
    await addSource();
    const r = withEnv({ APIFY_API_TOKEN: "wrong-token" });
    const res = await runScrapeSources("test");
    r();
    expect(res.results?.[0]).toMatchObject({ status: "APIFY_AUTH_FAILED" });
    expect(await db.pipelineFailure.count({ where: { errorCode: "APIFY_AUTH_FAILED" } })).toBe(1);
    const none = withEnv({ APIFY_API_TOKEN: undefined });
    expect(await runScrapeSources("test")).toMatchObject({ status: "BLOCKED_BY_ENVIRONMENT" });
    none();
  });

  it("names the one-time actor permission approval instead of a generic auth failure", async () => {
    await addSource();
    const r = withEnv({ APIFY_MEMORY_MB: "999" });
    const res = await runScrapeSources("test");
    r();
    expect(res.results?.[0]).toMatchObject({ status: "APIFY_ACTOR_NOT_APPROVED", reason: expect.stringContaining("approvePermissions=true") });
  });

  it("only crawls enabled sources", async () => {
    await addSource({ enabled: false });
    expect(await runScrapeSources("test")).toMatchObject({ started: 0 });
  });
});

describe("Sovrn edge cases", () => {
  it("distinguishes rate limits, empty results and rejected credentials", async () => {
    expect(await fetchSovrnOffers({ productName: "ratelimit test" })).toMatchObject({ status: "RATE_LIMITED", httpStatus: 429 });
    expect(await fetchSovrnOffers({ productName: "Nothing Matches This Product Zz" })).toMatchObject({ status: "EMPTY" });
    const r = withEnv({ SOVRN_API_KEY: "wrong" });
    expect(await fetchSovrnOffers({ productName: "Pixel 10", brand: "Google" })).toMatchObject({ status: "AUTH_FAILED" });
    r();
  });
});
