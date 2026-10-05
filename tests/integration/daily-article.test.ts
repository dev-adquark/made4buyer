import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  AUTOMATION_APPROVER,
  runDailyArticle,
} from "@/lib/automation/daily-article";
import { runJob } from "@/lib/jobs/registry";
import { buildPageRenderModel } from "@/lib/pipeline/render-model";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { startStubServer } from "../../scripts/support/stub-server";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

// SAMPLE data only: local Keyword-to-Blog and Pexels stubs, never the real providers.
let stub: Awaited<ReturnType<typeof startStubServer>>;
let restore: () => void;
const at = (iso: string) => new Date(iso);
// 2026-10-06 08:10 IST = 02:40 UTC; 19:05 IST = 13:35 UTC.
const MORNING = at("2026-10-06T02:40:00Z");
const EVENING = at("2026-10-06T13:35:00Z");

beforeAll(async () => {
  await seedTaxonomy();
  stub = await startStubServer({});
  restore = withEnv({
    KEYWORD_TO_BLOG_API_URL: `${stub.base}/ktb/v1/generate`,
    KEYWORD_TO_BLOG_API_KEY: "test-ktb-key",
    GUIDE_AUTOGEN_ENABLED: "true",
    KEYWORD_TO_BLOG_DAILY_LIMIT: "3",
    KTB_RETRY_DELAY_MS: "10",
    PEXELS_API_KEY: "test-pexels-key",
    PEXELS_API_BASE_URL: `${stub.base}/pexels/v1`,
    UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: "true",
    IMAGE_ENRICHMENT_URL: undefined,
    SOVRN_API_URL: undefined,
    CONTENT_API_URL: undefined,
  });
});
afterAll(async () => {
  restore();
  await stub.close();
});
beforeEach(async () => {
  await resetDb();
  Object.assign(stub.ktb, {
    unavailable: 0,
    handsOn: false,
    delayMs: 0,
    requests: 0,
  });
});

describe("daily article automation", () => {
  it("does nothing before 08:00 IST", async () => {
    expect(
      await runDailyArticle("test", { now: at("2026-10-06T02:00:00Z") }),
    ).toMatchObject({ status: "NOT_DUE" });
    expect(stub.ktb.requests).toBe(0);
  });

  it("publishes one morning and one evening article: new topics, different categories, unique images, honest approval", async () => {
    const m = await runDailyArticle("test", { now: MORNING });
    expect(m).toMatchObject({ status: "PUBLISHED", slot: "MORNING" });
    // Idempotent: a second morning run publishes nothing and spends no API call.
    const calls = stub.ktb.requests;
    expect(
      await runDailyArticle("test", { now: at("2026-10-06T03:40:00Z") }),
    ).toMatchObject({ status: "NOT_DUE" });
    expect(stub.ktb.requests).toBe(calls);
    const e = await runDailyArticle("test", { now: EVENING });
    expect(e).toMatchObject({ status: "PUBLISHED", slot: "EVENING" });
    expect(
      await runDailyArticle("test", { now: at("2026-10-06T15:00:00Z") }),
    ).toMatchObject({ status: "NOT_DUE" });

    const published = await db.normalizedReview.findMany({
      where: { status: "PUBLISHED", kind: "AI_GUIDE" },
      include: { images: { where: { isPrimary: true } } },
    });
    expect(published).toHaveLength(2);
    expect(new Set(published.map((p) => p.categorySlug)).size).toBe(2);
    expect(
      new Set(published.map((p) => p.canonicalTitle.toLowerCase())).size,
    ).toBe(2);
    const photos = published.map((p) => p.images[0]?.providerPhotoId);
    expect(photos.every(Boolean)).toBe(true);
    expect(new Set(photos).size).toBe(2);
    for (const p of published) {
      expect(p.editorApprovedBy).toBe(AUTOMATION_APPROVER);
      expect(p.images[0].isFallback).toBe(false);
      const model = await buildPageRenderModel(p.id);
      expect(model.approval).toBe("AUTOMATED");
      expect(model.rating).toBeNull();
    }
    expect(
      await db.automationSlot.count({
        where: { day: "2026-10-06", status: "PUBLISHED" },
      }),
    ).toBe(2);
    expect(
      await db.auditLog.count({ where: { action: "guide.auto_approve" } }),
    ).toBe(2);
  });

  it("never re-picks a covered topic: a duplicate is rejected before any API call", async () => {
    await runDailyArticle("test", { now: MORNING });
    const first = await db.contentQueueItem.findFirstOrThrow({
      where: { status: "PUBLISHED" },
    });
    // Put the same topic back in the queue under a different key: it must be rejected for free.
    await db.contentQueueItem.create({
      data: {
        key: "dup:test",
        topic: first.topic,
        keyword: first.keyword,
        kind: first.kind,
        categorySlug: first.categorySlug,
        priority: 10_000,
      },
    });
    const before = stub.ktb.requests;
    expect(await runDailyArticle("test", { now: EVENING })).toMatchObject({
      status: "PUBLISHED",
    });
    const dup = await db.contentQueueItem.findUniqueOrThrow({
      where: { key: "dup:test" },
    });
    expect(dup.status).toBe("REJECTED");
    expect(dup.failureReason).toMatch(/duplicate before generation/);
    expect(stub.ktb.requests - before).toBe(1);
  });

  it("retries a provider outage with backoff, then recovers without duplicating", async () => {
    stub.ktb.unavailable = 2; // the in-run retry also fails
    const r1 = await runDailyArticle("test", { now: MORNING });
    expect(r1).toMatchObject({ status: "RETRYING", attempts: 1 });
    expect(r1.reason).toMatch(/temporarily unavailable/);
    const slot = await db.automationSlot.findUniqueOrThrow({
      where: { day_slot: { day: "2026-10-06", slot: "MORNING" } },
    });
    expect(slot.apiCalls).toBe(2);
    expect(
      await db.contentQueueItem.count({
        where: {
          status: "QUEUED",
          failureReason: { contains: "temporarily unavailable" },
        },
      }),
    ).toBe(1);
    // Inside the backoff window: no call.
    expect(
      await runDailyArticle("test", { now: at("2026-10-06T03:00:00Z") }),
    ).toMatchObject({ status: "RETRYING" });
    expect(stub.ktb.requests).toBe(2);
    // After backoff the provider is back, but the morning has spent its share (1 kept for the evening).
    expect(
      await runDailyArticle("test", { now: at("2026-10-06T03:40:00Z") }),
    ).toMatchObject({
      status: "BLOCKED",
      reason: expect.stringMatching(/quota/),
    });
    // The evening still publishes with the reserved request.
    expect(await runDailyArticle("test", { now: EVENING })).toMatchObject({
      status: "PUBLISHED",
      slot: "EVENING",
    });
    expect(
      await db.normalizedReview.count({ where: { status: "PUBLISHED" } }),
    ).toBe(1);
  });

  it("treats a provider timeout as a failed attempt, never a published article", async () => {
    const t = withEnv({ KEYWORD_TO_BLOG_TIMEOUT_MS: "5000" });
    stub.ktb.delayMs = 6500;
    try {
      const r = await runDailyArticle("test", { now: MORNING });
      expect(r.status).toBe("RETRYING");
      expect(r.reason).toMatch(/still generating|timed out|timeout/i);
      expect(await db.normalizedReview.count()).toBe(0);
    } finally {
      t();
      stub.ktb.delayMs = 0;
    }
  }, 20_000);

  it("does not publish an article that claims hands-on testing", async () => {
    stub.ktb.handsOn = true;
    const r = await runDailyArticle("test", { now: MORNING });
    expect(r.status).toBe("RETRYING");
    expect(r.reason).toMatch(/hands-on/);
    expect(
      await db.normalizedReview.count({ where: { status: "PUBLISHED" } }),
    ).toBe(0);
    expect(
      await db.contentQueueItem.count({
        where: { status: "REJECTED", failureReason: { contains: "hands-on" } },
      }),
    ).toBe(1);
  });

  it("serialises concurrent runs: two triggers at once publish one article", async () => {
    // Even without the job lock, the atomic slot claim lets only one runner proceed.
    const [x, y] = await Promise.allSettled([
      runDailyArticle("a", { now: MORNING }),
      runDailyArticle("b", { now: MORNING }),
    ]);
    const statuses = [x, y].map((p) =>
      p.status === "fulfilled" ? p.value.status : "LOCKED",
    );
    expect(statuses.sort()).toEqual(["PUBLISHED", "SKIPPED"]);
    expect(
      await db.normalizedReview.count({
        where: { status: "PUBLISHED", kind: "AI_GUIDE" },
      }),
    ).toBe(1);
    expect(await db.automationSlot.count()).toBe(1);
    // And the job lock serialises the real scheduler entry point.
    const locked = await Promise.allSettled([
      runJob("daily-article", "a"),
      runJob("daily-article", "b"),
    ]);
    expect(
      locked.some(
        (r) =>
          r.status === "rejected" &&
          /lock|running/i.test(String((r as PromiseRejectedResult).reason)),
      ),
    ).toBe(true);
  });

  it("enforces one image per article at the database level", async () => {
    const mk = (n: number) =>
      db.normalizedReview.create({
        data: {
          source: "t",
          sourceId: `i${n}`,
          dedupeKey: `i${n}`,
          canonicalTitle: `Image test ${n}`,
          slug: `image-test-${n}`,
          productName: `P${n}`,
          summary: "s",
          body: "b",
        },
      });
    const [a, b] = await Promise.all([mk(1), mk(2)]);
    const img = {
      sourceType: "ENRICHMENT_SERVICE" as const,
      sourceUrl: "https://images.pexels.com/photos/1/x.jpeg",
      licenseState: "VERIFIED" as const,
      enrichmentStatus: "ENRICHED" as const,
      providerPhotoId: "pexels:1",
      isPrimary: true,
    };
    await db.imageAsset.create({ data: { ...img, normalizedReviewId: a.id } });
    await expect(
      db.imageAsset.create({ data: { ...img, normalizedReviewId: b.id } }),
    ).rejects.toMatchObject({ code: "P2002" });
    // History rows (not primary) may keep the id.
    await db.imageAsset.create({
      data: { ...img, normalizedReviewId: b.id, isPrimary: false },
    });
  });

  it("enforces unique AI guide titles at the database level", async () => {
    const mk = (n: number) =>
      db.normalizedReview.create({
        data: {
          source: "keyword-to-blog",
          sourceId: `t${n}`,
          dedupeKey: `t${n}`,
          canonicalTitle:
            n === 1 ? "How to choose kettles" : "HOW TO CHOOSE KETTLES",
          slug: `t-${n}`,
          productName: "Kettles",
          summary: "s",
          body: "b",
          kind: "AI_GUIDE",
        },
      });
    await mk(1);
    await expect(mk(2)).rejects.toMatchObject({ code: "P2002" });
  });
});
