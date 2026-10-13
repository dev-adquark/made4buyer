import type { ReactElement } from "react";
import { prerender } from "react-dom/static";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TagType } from "@prisma/client";
import { db } from "@/lib/db";
import { cardSelect, LATEST_FIRST } from "@/lib/public/queries";
import { matchWhere, matchResults } from "@/lib/public/match";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { resetDb } from "../support/db";

const { MatchView } = await import("@/app/match/match-view");

/**
 * Find my match, rendered from seeded rows: every option is a real tag value with its real count,
 * steps without data are skipped (never forced), results are exactly what the matching rule
 * returns (category + every chosen tag, newest first, relaxed latest-answer-first), and unknown or
 * empty states never show products from another category.
 */

async function html(el: ReactElement | Promise<ReactElement>): Promise<string> {
  const { prelude } = await prerender(await el);
  return (await new Response(prelude).text()).replace(/<!-- -->/g, "");
}
const hrefs = (markup: string) => [...markup.matchAll(/<a[^>]*href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
const cardTitles = (markup: string) => [...markup.matchAll(/class="review-card[^"]*"[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());

let n = 0;
async function review(category: string, title: string, tags: Array<[TagType, string]>, hoursAgo: number, status: "PUBLISHED" | "NEEDS_REVIEW" = "PUBLISHED") {
  const id = `match-${++n}`;
  const r = await db.normalizedReview.create({
    data: { source: "match-test", sourceId: id, dedupeKey: id, slug: id, canonicalTitle: title, productName: title, summary: "s", body: "b", kind: "REVIEW", categorySlug: category, status, publishedAt: new Date(Date.now() - hoursAgo * 3_600_000), confidence: 1 },
  });
  for (const [type, slug] of tags) {
    const tag = await db.categoryTag.findUniqueOrThrow({ where: { type_slug: { type, slug } } });
    await db.reviewCategoryAssignment.create({ data: { normalizedReviewId: r.id, categoryTagId: tag.id, tagType: type, confidence: 1, reason: "test", source: "ADMIN" } });
  }
  return r;
}

beforeAll(() => seedTaxonomy());
beforeEach(async () => {
  await resetDb();
  // Phones: intent + platform + tier data. Luggage: reviews but no tags at all. Security: intent only.
  await review("phones", "Phone Alpha", [["INTENT", "gaming"], ["PLATFORM", "android"], ["PRICE_TIER", "premium"]], 1);
  await review("phones", "Phone Bravo", [["INTENT", "gaming"], ["PLATFORM", "ios"]], 2);
  await review("phones", "Phone Charlie", [["INTENT", "creator"], ["PLATFORM", "ios"], ["PRICE_TIER", "budget"]], 3);
  await review("phones", "Phone Draft", [["INTENT", "gaming"], ["PLATFORM", "android"]], 0, "NEEDS_REVIEW");
  await review("luggage-travel", "Suitcase One", [], 4);
  await review("luggage-travel", "Suitcase Two", [], 5);
  await review("security-software", "Vault App", [["INTENT", "business"]], 6);
});

describe("find my match: steps", () => {
  it("step 1 lists every category; only categories with published reviews are links, and links skip questions without data", async () => {
    const page = await html(MatchView({ picks: {} }));
    expect(page).toContain("What are you buying?");
    const links = hrefs(page).filter((h) => h.startsWith("/match?"));
    expect(links).toContain("/match?category=phones");
    expect(links).toContain("/match?category=luggage-travel&intent=any&platform=any&tier=any");
    expect(links).toContain("/match?category=security-software");
    expect(links.some((h) => h.includes("category=tablets"))).toBe(false);
    expect(page).toContain("No reviews yet");
    expect(page).not.toContain("We don’t cover that category");
  });

  it("matters most: real intents with real counts (published only), plus no preference", async () => {
    const page = await html(MatchView({ picks: { category: "phones" } }));
    expect(page).toContain("What matters most?");
    expect(page).toMatch(/Gaming<\/strong><span>2 matching products/);
    expect(page).toMatch(/Creator<\/strong><span>1 matching product</);
    expect(page).not.toContain("Business</strong>");
    expect(hrefs(page)).toEqual(expect.arrayContaining(["/match?category=phones&intent=gaming", "/match?category=phones&intent=creator", "/match?category=phones&intent=any"]));
  });

  it("platform: only platforms that fit the earlier answers; a step without data is skipped by the link into it", async () => {
    const page = await html(MatchView({ picks: { category: "phones", intent: "creator" } }));
    expect(page).toContain("Which platform?");
    expect(page).toMatch(/iOS \/ iPadOS<\/strong><span>1 matching product/);
    expect(page).not.toContain("Android</strong>");
    // Security software has intents but no platform or budget data: choosing an intent goes straight to the results.
    const sec = await html(MatchView({ picks: { category: "security-software" } }));
    expect(hrefs(sec)).toContain("/match?category=security-software&intent=business&platform=any&tier=any");
  });

  it("budget: honest when there is no price data, and the results say so", async () => {
    // Reached directly (an old link): the question explains there is nothing to choose and continues.
    const step = await html(MatchView({ picks: { category: "luggage-travel", intent: "any", platform: "any" } }));
    expect(step).toContain("What’s your budget?");
    expect(step).toContain("We don’t hold verified price ranges for the luggage &amp; travel we’ve reviewed so far");
    expect(hrefs(step)).toContain("/match?category=luggage-travel&intent=any&platform=any&tier=any");
    const done = await html(MatchView({ picks: { category: "luggage-travel", intent: "any", platform: "any", tier: "any" } }));
    expect(done).toContain("Your match.");
    expect(done).toContain("Budget: not available");
    expect(done).toContain("Not available");
    expect(cardTitles(done).sort()).toEqual(["Suitcase One", "Suitcase Two"]);
  });
});

describe("find my match: results", () => {
  it("lists exactly what the matching rule returns, newest first, never from another category or unpublished", async () => {
    const picks = { category: "phones", intent: "gaming", platform: "any", tier: "any" };
    const page = await html(MatchView({ picks }));
    const expected = await db.normalizedReview.findMany({ where: { status: "PUBLISHED", ...matchWhere("phones", picks) }, orderBy: LATEST_FIRST, select: { canonicalTitle: true } });
    expect(cardTitles(page)).toEqual(expected.map((r) => r.canonicalTitle));
    expect(cardTitles(page)).toEqual(["Phone Alpha", "Phone Bravo"]);
    expect(page).toContain("tagged “Gaming”");
    expect(page).toMatch(/href="\/compare\?ids=[^"]+"/);
    expect(hrefs(page)).toEqual(expect.arrayContaining(["/match?category=phones", "/category/phones", "/match"]));
    expect(page).not.toContain("Suitcase");
  });

  it("relaxes the latest answers first and says which one was ignored", async () => {
    const page = await html(MatchView({ picks: { category: "phones", intent: "creator", platform: "ios", tier: "premium" } }));
    expect(page).toContain("we’ve ignored your budget answer");
    expect(cardTitles(page)).toEqual(["Phone Charlie"]);
  });

  it("matchResults keeps the original rule: strict, then tier, platform, intent dropped in that order", async () => {
    const strict = await matchResults("phones", { category: "phones", intent: "gaming", platform: "android", tier: "premium" });
    expect(strict).toMatchObject({ relaxed: [] });
    expect(strict.results.map((r) => r.canonicalTitle)).toEqual(["Phone Alpha"]);
    const loose = await matchResults("phones", { category: "phones", intent: "gaming", platform: "ios", tier: "budget" });
    expect(loose.relaxed).toEqual(["tier"]);
    expect(loose.results.map((r) => r.canonicalTitle)).toEqual(["Phone Bravo"]);
    const all = await matchResults("phones", { category: "phones", intent: "business", platform: "windows", tier: "free" });
    expect(all.relaxed).toEqual(["tier", "platform", "intent"]);
    const direct = await db.normalizedReview.findMany({ where: { status: "PUBLISHED", categorySlug: "phones" }, orderBy: LATEST_FIRST, take: 12, select: cardSelect });
    expect(all.results.map((r) => r.id)).toEqual(direct.map((r) => r.id));
  });
});

describe("find my match: invalid and empty states", () => {
  it("an unknown category asks again with a notice", async () => {
    const page = await html(MatchView({ picks: { unknown: true } }));
    expect(page).toContain("What are you buying?");
    expect(page).toContain("We don’t cover that category");
  });

  it("an answer that is not a real tag is asked again; later answers are dropped", async () => {
    const page = await html(MatchView({ picks: { category: "phones", intent: "made-up", platform: "ios" } }));
    expect(page).toContain("What matters most?");
    expect(page).toContain("That answer isn’t available any more");
    expect(cardTitles(page)).toEqual([]);
  });

  it("a category with no published reviews shows a useful empty state and no products from elsewhere", async () => {
    for (const picks of [{ category: "tablets" }, { category: "tablets", intent: "any", platform: "any", tier: "any" }]) {
      const page = await html(MatchView({ picks }));
      expect(page).toContain("No tablets reviews yet.");
      expect(hrefs(page)).toEqual(expect.arrayContaining(["/match", "/reviews"]));
      expect(cardTitles(page)).toEqual([]);
      expect(page).not.toMatch(/Phone|Suitcase|Vault/);
    }
  });
});
