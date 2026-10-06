import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { runJob } from "@/lib/jobs/registry";
import { runTitleYearFix } from "@/lib/jobs/title-years";
import { runIngestion } from "@/lib/pipeline/ingest";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

let restore: () => void;
beforeAll(async () => {
  await seedTaxonomy();
  restore = withEnv({ FRESHNESS_MAX_DAYS: "7", AUTO_PUBLISH_ENABLED: "false", CONTENT_API_URL: undefined });
});
afterAll(() => restore());
beforeEach(() => resetDb());

let n = 0;
const review = (over: Record<string, unknown>) => {
  n++;
  return db.normalizedReview.create({
    data: { source: "apify:example", sourceId: `s${n}`, dedupeKey: `k${n}`, canonicalTitle: `Review ${n}`, slug: `review-${n}`, productName: `Product ${n}`, summary: "Summary", body: "Body text from 2026 stays as written.", status: "PUBLISHED", publishedAt: new Date(), ...over },
  });
};

describe("fix-title-years backfill", () => {
  it("changes only misleading external titles, keeps the original title, slugs and KTB posts, and is idempotent", async () => {
    const express = await review({ canonicalTitle: "ExpressVPN Review 2026: Fast and Private", slug: "expressvpn-review-2026-fast-and-private", sourcePublishedAt: new Date("2019-07-19Z"), sourceData: { pros: ["fast"] } });
    const clickup = await review({ canonicalTitle: "ClickUp Review (2026)", sourcePublishedAt: new Date("2019-11-01Z"), status: "QUEUED", publishedAt: null });
    // Updated date justifies the year → kept.
    const updated = await review({ canonicalTitle: "NordVPN Review 2026", sourcePublishedAt: new Date("2021-03-22Z"), sourceUpdatedAt: new Date("2026-02-01Z") });
    const undated = await review({ canonicalTitle: "Icedrive Review 2026" });
    const locked = await review({ canonicalTitle: "Sync.com Review 2026", sourcePublishedAt: new Date("2024-03-08Z"), manualEditLocked: true });
    const ktb = await review({ source: "keyword-to-blog", kind: "AI_GUIDE", canonicalTitle: "Best VPN 2026: tested", slug: "best-vpn-2026-tested", sourcePublishedAt: new Date("2019-01-01Z") });
    const ktbReview = await review({ source: "keyword-to-blog", canonicalTitle: "Surfshark Review 2026", sourcePublishedAt: new Date("2024-06-08Z") });
    const iphone = await review({ canonicalTitle: "iPhone 17 Pro review: 1080p video", sourcePublishedAt: new Date("2019-07-19Z") });

    const first = await runTitleYearFix("test");
    expect(first).toMatchObject({ status: "OK", changed: 2, republished: 1, failed: 0 });

    const get = (id: string) => db.normalizedReview.findUniqueOrThrow({ where: { id }, include: { renderModel: true } });
    const e = await get(express.id);
    expect(e.canonicalTitle).toBe("ExpressVPN Review: Fast and Private");
    expect(e.slug).toBe("expressvpn-review-2026-fast-and-private"); // URL unchanged
    expect(e.body).toBe("Body text from 2026 stays as written.");
    expect(e.sourceData).toEqual({ pros: ["fast"], originalTitle: "ExpressVPN Review 2026: Fast and Private" });
    // Published page render model rebuilt with the honest title.
    expect((e.renderModel?.model as { title?: string } | undefined)?.title).toBe("ExpressVPN Review: Fast and Private");

    const c = await get(clickup.id);
    expect(c.canonicalTitle).toBe("ClickUp Review");
    expect(c.sourceData).toEqual({ originalTitle: "ClickUp Review (2026)" });
    expect(c.renderModel).toBeNull(); // not published: nothing to rebuild

    for (const [row, title] of [[updated, "NordVPN Review 2026"], [undated, "Icedrive Review 2026"], [locked, "Sync.com Review 2026"], [ktb, "Best VPN 2026: tested"], [ktbReview, "Surfshark Review 2026"], [iphone, "iPhone 17 Pro review: 1080p video"]] as const) {
      const r = await get(row.id);
      expect(r.canonicalTitle).toBe(title);
      expect(r.slug).toBe(row.slug);
      expect(r.sourceData).toBeNull();
    }

    const logs = await db.auditLog.findMany({ where: { action: "review.title.misleading_year_removed" } });
    expect(logs.map((l) => l.entityId).sort()).toEqual([express.id, clickup.id].sort());
    expect(logs.find((l) => l.entityId === express.id)).toMatchObject({ actor: "system", before: { canonicalTitle: "ExpressVPN Review 2026: Fast and Private" }, after: { canonicalTitle: "ExpressVPN Review: Fast and Private" } });

    // Second run: nothing left to change, nothing re-logged, original title preserved.
    const second = await runJob("fix-title-years", "test");
    expect(second).toMatchObject({ status: "OK", changed: 0 });
    expect(await db.auditLog.count({ where: { action: "review.title.misleading_year_removed" } })).toBe(2);
    expect((await get(express.id)).sourceData).toEqual({ pros: ["fast"], originalTitle: "ExpressVPN Review 2026: Fast and Private" });
  });

  it("never overwrites an original title recorded at ingestion", async () => {
    const r = await review({ canonicalTitle: "Best VPN 2026", sourcePublishedAt: new Date("2020-05-05Z"), sourceData: { originalTitle: "Best VPN 2026 | Publisher" } });
    await runTitleYearFix("test");
    const after = await db.normalizedReview.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.canonicalTitle).toBe("Best VPN");
    expect(after.sourceData).toEqual({ originalTitle: "Best VPN 2026 | Publisher" });
  });
});

describe("honest titles at ingestion", () => {
  const DAY = 86_400_000;
  const body = "The Framework Laptop 13 is a repairable ultraportable with swappable ports, a bright 2.8K display and solid battery life. We tested it for two weeks of daily work and travel.";
  const next = new Date().getUTCFullYear() + 1;
  const publishedAt = new Date(Date.now() - DAY).toISOString();
  const item = (over: Record<string, unknown> = {}) => ({ id: "fw-1", title: `Framework Laptop 13 review (${next}): repairable and fast`, body, summary: "A repairable laptop that is easy to upgrade.", url: "https://reviews.example.test/reviews/fw-1", brand: "Framework", category: "laptops", publishedAt, sourceData: { pros: ["repairable"] }, ...over });

  it("cleans a future-year title for new items, keeps the publisher title, and re-ingestion never duplicates", async () => {
    await runIngestion({ trigger: "test", source: "apify:example", items: [item()] });
    const r = await db.normalizedReview.findFirstOrThrow({ where: { sourceId: "fw-1" } });
    expect(r.canonicalTitle).toBe("Framework Laptop 13 review: repairable and fast");
    expect(r.slug).toBe("framework-laptop-13-review-repairable-and-fast");
    expect(r.sourceData).toEqual({ pros: ["repairable"], originalTitle: `Framework Laptop 13 review (${next}): repairable and fast` });

    // Unchanged re-fetch: nothing new.
    const again = await runIngestion({ trigger: "test", source: "apify:example", items: [item()] });
    expect(again).toMatchObject({ unchanged: 1, duplicates: 0 });
    // Changed content from the same source item updates the same row; slug and dedupe key stay.
    await runIngestion({ trigger: "test", source: "apify:example", items: [item({ body: `${body} Updated verdict.` })] });
    const rows = await db.normalizedReview.findMany({ where: { sourceId: "fw-1" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: r.id, slug: r.slug, dedupeKey: r.dedupeKey, canonicalTitle: r.canonicalTitle });
    expect(rows[0].sourceData).toMatchObject({ originalTitle: `Framework Laptop 13 review (${next}): repairable and fast` });

    // The backfill finds nothing more to do for an item cleaned at ingestion.
    expect(await runTitleYearFix("test")).toMatchObject({ changed: 0 });
  });

  it("publishes Keyword-to-Blog titles exactly as returned", async () => {
    await runIngestion({ trigger: "test", source: "keyword-to-blog", items: [{ id: "ktb-1", title: `How to pick a laptop in ${next}`, body: "Short.", contentKind: "AI_GUIDE" }] });
    const r = await db.normalizedReview.findFirstOrThrow({ where: { sourceId: "ktb-1" } });
    expect(r.canonicalTitle).toBe(`How to pick a laptop in ${next}`);
    expect(r.sourceData).toBeNull();
  });
});
