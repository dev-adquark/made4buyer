import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { categoryCoverage, contentOpportunities, subjectKey } from "@/lib/content/calendar";
import { guideRequestFor } from "@/lib/pipeline/guide-ideas";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { resetDb } from "../support/db";

let n = 0;
const content = (over: Record<string, unknown>) => {
  n++;
  return db.normalizedReview.create({ data: { source: "test", sourceId: `c${n}`, dedupeKey: `c${n}`, canonicalTitle: `Item ${n} review`, slug: `item-${n}`, productName: `Item ${n}`, summary: "Summary text for the item.", body: "Body", status: "PUBLISHED", publishedAt: new Date(), ...over } });
};

beforeAll(() => seedTaxonomy());
beforeEach(() => resetDb());

describe("content calendar", () => {
  it("ranks real gaps, puts under-covered non-tech first and keeps the head diverse", async () => {
    for (let i = 0; i < 6; i++) await content({ categorySlug: "laptops", kind: "REVIEW" });
    const opps = await contentOpportunities({ now: new Date("2026-06-15T00:00:00Z"), limit: 40 });
    expect(new Set(opps.map((o) => o.key)).size).toBe(opps.length);
    const head = opps.slice(0, 10);
    expect(new Set(head.map((o) => o.categorySlug)).size).toBe(head.length);
    expect(head[0].categorySlug).not.toBe("laptops");
    // June: travel is in season and has nothing published.
    expect(head.slice(0, 5).map((o) => o.categorySlug)).toContain("luggage-travel");
    // Product opportunities only exist for products a source reviewed.
    expect(opps.filter((o) => o.kind === "PRODUCT_GUIDE").every((o) => o.categorySlug === "laptops")).toBe(true);
  });

  it("never proposes a topic that already has a guide, including a rejected one", async () => {
    const before = await contentOpportunities({ limit: 500 });
    const target = before.find((o) => o.kind === "CATEGORY_GUIDE")!;
    await content({ kind: "AI_GUIDE", productName: target.subject, categorySlug: target.categorySlug, status: "REJECTED" });
    const after = await contentOpportunities({ limit: 500 });
    expect(after.map((o) => o.key)).not.toContain(target.key);
    expect(after.some((o) => subjectKey(o.subject) === subjectKey(target.subject))).toBe(false);
  });

  it("asks the AI for an educational guide framed by the category, not as technology", async () => {
    const [o] = (await contentOpportunities({ limit: 200 })).filter((x) => x.categorySlug === "mattresses");
    const req = guideRequestFor(o);
    expect(req.industry).not.toMatch(/technology/);
    expect(req.topic).toMatch(/^How to choose /);
    expect(req.audience).toMatch(/mattresses/);
  });

  it("reports coverage levels from stored data only", async () => {
    for (let i = 0; i < 4; i++) await content({ categorySlug: "audio", kind: "REVIEW" });
    await content({ categorySlug: "audio", kind: "AI_GUIDE" });
    const cov = await categoryCoverage();
    const audio = cov.find((c) => c.slug === "audio")!;
    expect(audio).toMatchObject({ reviews: 4, aiGuides: 1, published: 5, level: "STRONG" });
    expect(cov.find((c) => c.slug === "mattresses")).toMatchObject({ published: 0, level: "MISSING" });
    expect(cov.find((c) => c.slug === "mattresses")!.blockers[0]).toMatch(/No enabled source/);
  });
});
