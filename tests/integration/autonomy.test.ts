import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { allowed, getSwitches, setSwitch } from "@/lib/automation/settings";
import { runJob } from "@/lib/jobs/registry";
import { runIngestion } from "@/lib/pipeline/ingest";
import { recordSourceFailure, recordSourceRun, UNHEALTHY_AFTER } from "@/lib/pipeline/source-health";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

const admin = { actor: "admin@test" };
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const body = "The Framework Laptop 13 is a repairable ultraportable with swappable ports, a bright 2.8K display and solid battery life. We tested it for two weeks of daily work and travel.";
const item = (id: string, dates: Record<string, unknown>) => ({ id, title: `Framework Laptop 13 review ${id}`, body, summary: "A repairable laptop that is easy to upgrade.", url: `https://reviews.example.test/reviews/${id}`, productName: `Framework Laptop 13 ${id}`, brand: "Framework", category: "laptops", ...dates });

let restore: () => void;
beforeAll(async () => {
  await seedTaxonomy();
  restore = withEnv({ FRESHNESS_MAX_DAYS: "7", AUTO_PUBLISH_ENABLED: undefined, CONTENT_API_URL: undefined });
});
afterAll(() => restore());
beforeEach(() => resetDb());

describe("7-day freshness for external content", () => {
  it("ingests only items whose source date is at most 7 days old, and records why the rest were held", async () => {
    const summary = await runIngestion({
      trigger: "test",
      source: "apify:example",
      items: [
        item("fresh-1d", { publishedAt: ago(1) }),
        item("edge-7d", { publishedAt: new Date(Date.now() - 7 * DAY - 3_600_000).toISOString() }),
        item("stale-8d", { publishedAt: ago(8) }),
        item("old-but-updated", { publishedAt: ago(400), dateModified: ago(2) }),
        item("undated", {}),
        item("bad-updated", { updatedAt: "not a date" }),
      ],
    });
    expect(summary.freshness).toEqual({ fresh: 3, stale: 1, unknown: 1, invalidDate: 1 });
    expect(summary.reasons).toMatchObject({ FRESHNESS_STALE: 1, FRESHNESS_UNKNOWN: 1, FRESHNESS_INVALID_DATE: 1 });

    const byId = Object.fromEntries((await db.contentItem.findMany()).map((c) => [c.sourceId, c]));
    expect(byId["stale-8d"]).toMatchObject({ processingStatus: "REJECTED", errorCode: "FRESHNESS_STALE", freshnessStatus: "STALE", freshnessAgeDays: 8 });
    expect(byId["undated"]).toMatchObject({ processingStatus: "REJECTED", errorCode: "FRESHNESS_UNKNOWN", freshnessStatus: "UNKNOWN" });
    expect(byId["bad-updated"]).toMatchObject({ processingStatus: "REJECTED", errorCode: "FRESHNESS_INVALID_DATE" });
    expect(byId["old-but-updated"]).toMatchObject({ freshnessStatus: "FRESH", freshnessAgeDays: 2 });
    expect(byId["old-but-updated"].sourceUpdatedAt).not.toBeNull();
    expect(byId["fresh-1d"].freshnessCheckedAt).not.toBeNull();

    const reviews = await db.normalizedReview.findMany({ select: { sourceId: true, status: true, freshnessStatus: true } });
    expect(reviews.map((r) => r.sourceId).sort()).toEqual(["edge-7d", "fresh-1d", "old-but-updated"]);
    // Fresh and QA-passing: published by the automatic cycle, no approval step.
    for (const r of reviews) expect(r).toMatchObject({ status: "PUBLISHED", freshnessStatus: "FRESH" });
  });

  it("never rewrites or removes an already-published review when its source is re-crawled after the window", async () => {
    await runIngestion({ trigger: "test", source: "apify:example", items: [item("live", { publishedAt: ago(2) })] });
    const before = await db.normalizedReview.findFirstOrThrow({ where: { sourceId: "live" } });
    expect(before.status).toBe("PUBLISHED");
    const changed = { ...item("live", { publishedAt: ago(20) }), title: "A completely different headline for this page" };
    await runIngestion({ trigger: "test", source: "apify:example", items: [changed] });
    const after = await db.normalizedReview.findUniqueOrThrow({ where: { id: before.id } });
    expect(after).toMatchObject({ status: "PUBLISHED", canonicalTitle: before.canonicalTitle });
    expect(await db.contentItem.findFirstOrThrow({ where: { sourceId: "live" } })).toMatchObject({ freshnessStatus: "STALE" });
  });

  it("Keyword-to-Blog output is exempt: no date is required", async () => {
    await runIngestion({ trigger: "test", source: "keyword-to-blog", items: [{ id: "ktb-1", title: "How to pick a laptop", body: "Short.", contentKind: "AI_GUIDE" }] });
    const c = await db.contentItem.findFirstOrThrow({ where: { sourceId: "ktb-1" } });
    expect(c.processingStatus).not.toBe("REJECTED");
    expect(c.freshnessStatus).toBeNull();
  });
});

describe("source health and fallback", () => {
  const source = () => db.reviewSource.create({ data: { slug: "example", name: "Example", homepageUrl: "https://reviews.example.test/", allowedDomains: ["example.test"], startUrls: [], reviewUrlPatterns: [], enabled: true } });

  it("pauses a source after repeated runs with nothing fresh, then fully restores it on a fresh run", async () => {
    const s = await source();
    for (let i = 1; i < UNHEALTHY_AFTER; i++) await recordSourceRun(s.id, { fresh: 0, stale: 4, unknown: 1, invalidDate: 0 });
    let row = await db.reviewSource.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.pausedUntil).toBeNull();
    expect(row.priority).toBeLessThan(100);
    await recordSourceRun(s.id, { fresh: 0, stale: 2, unknown: 0, invalidDate: 0 });
    row = await db.reviewSource.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.consecutiveStale).toBe(UNHEALTHY_AFTER);
    expect(row.pausedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(row.enabled).toBe(true); // never disabled or deleted automatically
    expect(row.staleCount).toBe(2 * 5 + 2);

    await recordSourceRun(s.id, { fresh: 3, stale: 1, unknown: 0, invalidDate: 0 });
    row = await db.reviewSource.findUniqueOrThrow({ where: { id: s.id } });
    expect(row).toMatchObject({ consecutiveStale: 0, priority: 100, pausedUntil: null, freshCount: 3 });
    expect(row.lastFreshAt).not.toBeNull();
  });

  it("backs off repeated failures exponentially, capped at 7 days", async () => {
    const s = await source();
    for (let i = 0; i < 12; i++) await recordSourceFailure(s.id, "run ended FAILED");
    const row = await db.reviewSource.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.pausedUntil!.getTime() - Date.now()).toBeLessThanOrEqual(7 * DAY);
    expect(row.pausedUntil!.getTime() - Date.now()).toBeGreaterThan(6 * DAY);
    expect(row.healthNote).toMatch(/Paused until/);
    expect(await db.reviewSource.count()).toBe(1);
  });
});

describe("admin automation switches", () => {
  it("default on; pausing a capability pauses its scheduled job but a manual run still works", async () => {
    expect(Object.values(await getSwitches()).every(Boolean)).toBe(true);
    await setSwitch("image_enrichment", false, admin);
    expect(await runJob("enrich-images", "cron")).toMatchObject({ status: "PAUSED" });
    expect(await runJob("enrich-images", "admin:test")).not.toMatchObject({ status: "PAUSED" });
    expect(await db.auditLog.count({ where: { action: "automation.switch.image_enrichment" } })).toBe(1);
  });

  it("the master switch pauses everything", async () => {
    await setSwitch("automation", false, admin);
    expect(await allowed("retries")).toMatchObject({ ok: false });
    expect(await runJob("retry-failed", "cron")).toMatchObject({ status: "PAUSED" });
    expect(await runJob("daily-article", "cron")).toMatchObject({ status: "PAUSED" });
    await setSwitch("automation", true, admin);
    expect(await allowed("retries")).toEqual({ ok: true });
  });
});
