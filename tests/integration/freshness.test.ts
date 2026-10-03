import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { sourceHealth } from "@/lib/admin/source-health";
import { runStaleContentDetection } from "@/lib/jobs/stale-content";
import { recordFailure } from "@/lib/pipeline/failures";
import { resetDb } from "../support/db";

beforeEach(() => resetDb());

const DAY = 24 * 3_600_000;
let n = 0;
const review = (over: Record<string, unknown>) => {
  n++;
  return db.normalizedReview.create({
    data: { source: "test", sourceId: `s${n}`, dedupeKey: `k${n}`, canonicalTitle: `Review ${n}`, slug: `review-${n}`, productName: `Product ${n}`, summary: "Summary", body: "Body", status: "PUBLISHED", publishedAt: new Date(), ...over },
  });
};

describe("stale-content detection", () => {
  it("flags only live content past its window, and clears flags once it is no longer live", async () => {
    const old = await review({ sourcePublishedAt: new Date(Date.now() - 600 * DAY) });
    await review({ sourcePublishedAt: new Date(Date.now() - 30 * DAY) });
    await review({ sourcePublishedAt: new Date(Date.now() - 900 * DAY), status: "NEEDS_REVIEW", publishedAt: null });
    const oldGuide = await review({ kind: "AI_GUIDE", publishedAt: new Date(Date.now() - 400 * DAY) });

    const first = await runStaleContentDetection("test");
    expect(first).toMatchObject({ flagged: 2, cleared: 0 });
    const open = await db.pipelineFailure.findMany({ where: { errorCode: "CONTENT_STALE", resolvedAt: null } });
    expect(open.map((f) => f.entityId).sort()).toEqual([old.id, oldGuide.id].sort());
    expect(open.every((f) => f.kind === "PERMANENT_FAILURE")).toBe(true);
    // Nothing is unpublished automatically.
    expect((await db.normalizedReview.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("PUBLISHED");

    // Re-running is idempotent.
    expect(await runStaleContentDetection("test")).toMatchObject({ flagged: 2, cleared: 0 });
    expect(await db.pipelineFailure.count({ where: { errorCode: "CONTENT_STALE" } })).toBe(2);

    await db.normalizedReview.update({ where: { id: old.id }, data: { status: "UNPUBLISHED", unpublishedAt: new Date() } });
    expect(await runStaleContentDetection("test")).toMatchObject({ flagged: 1, cleared: 1 });
  });
});

describe("source health", () => {
  it("derives last success, discovered pages, robots state and the newest failure from recorded runs", async () => {
    const mk = (slug: string) => db.reviewSource.create({ data: { slug, name: slug, homepageUrl: "https://example.com/", allowedDomains: ["example.com"], startUrls: ["https://example.com/reviews"], reviewUrlPatterns: ["https://example.com/reviews/**"] } });
    const [ok, blocked, fresh] = await Promise.all([mk("ok"), mk("blocked"), mk("fresh")]);
    const t0 = new Date(Date.now() - 3 * DAY);
    await db.apifyRun.create({ data: { sourceId: ok.id, apifyRunId: "r1", status: "COLLECTED", trigger: "test", itemCount: 12, accepted: 9, rejected: 3, startedAt: t0, collectedAt: new Date(t0.getTime() + 3_600_000) } });
    await db.apifyRun.create({ data: { sourceId: ok.id, apifyRunId: "r2", status: "FAILED", trigger: "test", error: "actor crashed", startedAt: new Date(Date.now() - DAY), finishedAt: new Date(Date.now() - DAY) } });
    await db.apifyRun.create({ data: { sourceId: ok.id, apifyRunId: "r3", status: "COLLECTED", trigger: "test", itemCount: 5, accepted: 5, rejected: 0, startedAt: new Date(Date.now() - 3_600_000), collectedAt: new Date() } });
    await recordFailure({ stage: "CONTENT_FETCH", code: "ROBOTS_DISALLOWED", message: "robots.txt disallows /reviews", entityType: "review_source", entityId: blocked.id });

    const health = await sourceHealth([ok.id, blocked.id, fresh.id]);
    expect(health.get(ok.id)).toMatchObject({ discovered: 17, accepted: 14, robots: "ALLOWED", lastFailure: null });
    expect(health.get(ok.id)?.lastSuccessAt).toBeInstanceOf(Date);
    expect(health.get(blocked.id)).toMatchObject({ discovered: 0, robots: "DISALLOWED", lastSuccessAt: null, lastFailure: { code: "ROBOTS_DISALLOWED" } });
    expect(health.get(fresh.id)).toMatchObject({ discovered: 0, robots: "NOT_CHECKED", lastFailure: null });
  });
});
