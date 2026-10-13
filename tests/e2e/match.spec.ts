import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { Prisma, TagType } from "@prisma/client";
import { INTENTS, PLATFORMS, PRICE_TIERS } from "@/lib/taxonomy/definitions";
import { db, disconnect } from "./deals-fixtures";

/**
 * Find my match (/match) in a real browser against the production build. Every answer is a page
 * load of the cached state route; the page shown must always be the one the URL names (the bug this
 * guards: choosing an answer changed the URL but the client router kept rendering the first
 * question). Seeds its own published reviews in categories no other spec visits and removes them.
 */

const SOURCE = "e2e-match";
const TAGGED = { slug: "drones-gadgets", name: "Drones & Tech Gadgets" };
const UNTAGGED = { slug: "pet-supplies", name: "Pet Supplies" };
const EMPTY = { slug: "mattresses", name: "Mattresses & Sleep" };
const LATEST_FIRST = [{ sourcePublishedAt: { sort: "desc", nulls: "last" } }, { publishedAt: "desc" }, { id: "asc" }] satisfies Prisma.NormalizedReviewOrderByWithRelationInput[];

const DEFS: Record<"INTENT" | "PLATFORM" | "PRICE_TIER", Array<{ slug: string; name: string }>> = { INTENT: INTENTS, PLATFORM: PLATFORMS, PRICE_TIER: PRICE_TIERS };

async function tag(type: "INTENT" | "PLATFORM" | "PRICE_TIER", slug: string) {
  const def = DEFS[type].find((d) => d.slug === slug)!;
  return db().categoryTag.upsert({ where: { type_slug: { type, slug } }, create: { type, slug, name: def.name, sortOrder: DEFS[type].indexOf(def) }, update: {} });
}

let n = 0;
async function seed(category: string, title: string, tags: Array<["INTENT" | "PLATFORM" | "PRICE_TIER", string]>, hoursAgo: number) {
  const id = `${SOURCE}-${++n}`;
  const r = await db().normalizedReview.create({
    data: { source: SOURCE, sourceId: id, dedupeKey: id, slug: id, canonicalTitle: title, productName: title, summary: "A seeded item for the match flow tests.", body: "Seeded for the match flow tests.", kind: "REVIEW", categorySlug: category, status: "PUBLISHED", publishedAt: new Date(Date.now() - hoursAgo * 3_600_000), confidence: 1 },
  });
  for (const [type, slug] of tags) {
    const t = await tag(type, slug);
    await db().reviewCategoryAssignment.create({ data: { normalizedReviewId: r.id, categoryTagId: t.id, tagType: type as TagType, confidence: 1, reason: "e2e", source: "ADMIN" } });
  }
}

test.beforeAll(async () => {
  await db().normalizedReview.deleteMany({ where: { source: SOURCE } });
  await seed(TAGGED.slug, "Match drone Alpha", [["INTENT", "creator"], ["PLATFORM", "ios"], ["PRICE_TIER", "premium"]], 1);
  await seed(TAGGED.slug, "Match drone Bravo", [["INTENT", "creator"], ["PLATFORM", "android"], ["PRICE_TIER", "budget"]], 2);
  await seed(TAGGED.slug, "Match drone Charlie", [["INTENT", "creator"], ["PLATFORM", "ios"]], 3);
  await seed(TAGGED.slug, "Match drone Delta", [["INTENT", "buy-now"]], 4);
  await seed(UNTAGGED.slug, "Match pet camera One", [], 5);
  await seed(UNTAGGED.slug, "Match pet feeder Two", [], 6);
});

test.afterAll(async () => {
  await db().normalizedReview.deleteMany({ where: { source: SOURCE } });
  await disconnect();
});

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const cards = (page: Page) => page.locator("main article.review-card").evaluateAll((els) => els.map((el) => el.querySelector("h2, h3")?.textContent?.trim() ?? ""));
const pathOf = (page: Page) => page.url().replace(/^https?:\/\/[^/]+/, "");

/** Clicks an answer and waits for the new step's page (URL and question both change). */
async function answer(page: Page, name: RegExp, expectHeading: RegExp | string) {
  const before = page.url();
  await page.locator(".option-grid").getByRole("link", { name }).click();
  await page.waitForURL((u) => u.toString() !== before);
  await expect(heading(page)).toHaveText(expectHeading);
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

async function axe(page: Page) {
  const result = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
}

test("walks every step to real results; the page always matches the URL (back, forward, reload, change, restart)", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto("/match");
  await expect(heading(page)).toHaveText(/What are you buying\?/);
  await expect(page).toHaveTitle(/What are you buying\? \(step 1 of 4\)/);
  await page.waitForLoadState("networkidle"); // prefetches done: the client router has /match cached

  await answer(page, new RegExp(`^${TAGGED.name}`), /What matters most\?/);
  expect(pathOf(page)).toBe(`/match?category=${TAGGED.slug}`);
  await expect(page.locator(".option-grid")).toContainText("Creator");
  await expect(page.locator(".option-grid")).toContainText("3 matching products");
  // Focus moves to the new question for keyboard and screen-reader users.
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("H1");

  await answer(page, /^Creator/, /Which platform\?/);
  expect(pathOf(page)).toBe(`/match?category=${TAGGED.slug}&intent=creator`);
  await expect(page.locator(".option-grid a")).toHaveText([/iOS \/ iPadOS\s*2 matching products/, /Android\s*1 matching product/, /No preference/]);

  await answer(page, /^iOS/, /What’s your budget\?/);
  expect(pathOf(page)).toBe(`/match?category=${TAGGED.slug}&intent=creator&platform=ios`);
  await expect(page.locator(".option-grid a")).toHaveText([/Premium\s*1 matching product/, /No preference/]);

  await answer(page, /^No preference/, /Your match\./);
  const resultsUrl = `/match?category=${TAGGED.slug}&intent=creator&platform=ios&tier=any`;
  expect(pathOf(page)).toBe(resultsUrl);
  await expect(page).toHaveTitle(/Your match/);
  const expected = await db().normalizedReview.findMany({
    where: {
      status: "PUBLISHED",
      categorySlug: TAGGED.slug,
      AND: [
        { assignments: { some: { active: true, tagType: "INTENT", categoryTag: { slug: "creator" } } } },
        { assignments: { some: { active: true, tagType: "PLATFORM", categoryTag: { slug: "ios" } } } },
      ],
    },
    orderBy: LATEST_FIRST,
    select: { canonicalTitle: true },
  });
  expect(await cards(page)).toEqual(expected.map((r) => r.canonicalTitle));
  expect(await cards(page)).toEqual(["Match drone Alpha", "Match drone Charlie"]);
  await expect(page.getByText("Every product below is tagged “Creator” and “iOS / iPadOS”")).toBeVisible();
  await expect(page.locator("main a[href^='/review/']").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Compare the top 2" })).toHaveAttribute("href", /^\/compare\?ids=/);

  await page.goBack();
  await expect(heading(page)).toHaveText(/What’s your budget\?/);
  expect(pathOf(page)).toBe(`/match?category=${TAGGED.slug}&intent=creator&platform=ios`);
  await page.goForward();
  await expect(heading(page)).toHaveText(/Your match\./);
  await page.reload();
  await expect(heading(page)).toHaveText(/Your match\./);
  expect(await cards(page)).toEqual(["Match drone Alpha", "Match drone Charlie"]);

  // Change an earlier answer from the progress bar: later answers are cleared.
  await page.getByRole("link", { name: /Matters most.*\(change\)/ }).click();
  await expect(heading(page)).toHaveText(/What matters most\?/);
  expect(pathOf(page)).toBe(`/match?category=${TAGGED.slug}`);
  await page.goBack();
  await expect(heading(page)).toHaveText(/Your match\./);
  await page.getByRole("link", { name: "Change answers" }).click();
  await expect(heading(page)).toHaveText(/What matters most\?/);
  await page.goBack();
  await page.getByRole("link", { name: "Start again" }).click();
  await expect(heading(page)).toHaveText(/What are you buying\?/);
  expect(pathOf(page)).toBe("/match");
  expect(errors).toEqual([]);
});

test("relaxes the latest answer when nothing matches every answer, and says so", async ({ page }) => {
  await page.goto(`/match?category=${TAGGED.slug}&intent=buy-now`);
  // Reached directly, a question without data for the earlier answers still renders (with Continue).
  await expect(heading(page)).toHaveText(/Which platform\?/);
  await expect(page.locator(".option-grid a")).toHaveText([/Continue/]);
  await page.goto(`/match?category=${TAGGED.slug}&intent=creator&platform=android&tier=premium`);
  await expect(heading(page)).toHaveText(/Your match\./);
  await expect(page.getByRole("status").filter({ hasText: "ignored your budget answer" })).toBeVisible();
  expect(await cards(page)).toEqual(["Match drone Bravo"]);
});

test("questions without data are skipped, never forced, and shown as Not available", async ({ page }) => {
  await page.goto("/match");
  await answer(page, new RegExp(`^${UNTAGGED.name}`), /Your match\./);
  expect(pathOf(page)).toBe(`/match?category=${UNTAGGED.slug}&intent=any&platform=any&tier=any`);
  await expect(page.locator(".match-progress")).toContainText("Not available");
  await expect(page.getByText("Budget: not available")).toBeVisible();
  await expect(page.getByText(/We don’t hold verified price ranges/)).toBeVisible();
  expect((await cards(page)).sort()).toEqual(["Match pet camera One", "Match pet feeder Two"]);
  expect(await cards(page)).not.toContain("Match drone Alpha");
  // Reached through an old link, the question explains itself and continues.
  await page.goto(`/match?category=${UNTAGGED.slug}`);
  await expect(heading(page)).toHaveText(/What matters most\?/);
  await expect(page.getByText(/We don’t have buying-priority details for the pet supplies/)).toBeVisible();
  await answer(page, /^Continue/, /Your match\./);
});

test("direct URLs: unknown, malformed and empty categories, unknown answers, internal routes", async ({ page }) => {
  for (const q of ["category=not-a-category", "category=%3Cscript%3E", "category=PHONES&intent=gaming"]) {
    const res = await page.goto(`/match?${q}`);
    expect(res?.status()).toBe(200);
    await expect(heading(page)).toHaveText(/What are you buying\?/);
    await expect(page.getByText("We don’t cover that category. Choose one below.")).toBeVisible();
  }
  await page.goto(`/match?category=${EMPTY.slug}`);
  await expect(heading(page)).toHaveText("No match yet.");
  await expect(page.getByText(`No ${EMPTY.name.toLowerCase()} reviews yet.`)).toBeVisible();
  await expect(page.getByRole("link", { name: "Choose another category" })).toHaveAttribute("href", "/match");
  expect(await cards(page)).toEqual([]);

  await page.goto(`/match?category=${TAGGED.slug}&intent=not-a-tag&platform=ios`);
  await expect(heading(page)).toHaveText(/What matters most\?/);
  await expect(page.getByText("That answer isn’t available any more. Choose again.")).toBeVisible();

  expect((await page.goto(`/match/v/category.${TAGGED.slug}`))?.status()).toBe(404);
});

test("keyboard: answers are links reachable and operable with the keyboard", async ({ page }) => {
  await page.goto(`/match?category=${TAGGED.slug}`);
  // Tab order reaches the answers; Enter follows one.
  let reached = false;
  for (let i = 0; i < 60 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(() => Boolean(document.activeElement?.closest(".option-grid")));
  }
  expect(reached).toBe(true);
  const creator = page.locator(".option-grid").getByRole("link", { name: /^Creator/ });
  await creator.focus();
  await expect(creator).toBeFocused();
  const before = page.url();
  await page.keyboard.press("Enter");
  await page.waitForURL((u) => u.toString() !== before);
  await expect(heading(page)).toHaveText(/Which platform\?/);
  await expect(heading(page)).toBeFocused();
});

test("mobile and every width from 320 to 1920: no horizontal overflow, no axe violations, reduced motion respected", async ({ browser }) => {
  const urls = ["/match", `/match?category=${TAGGED.slug}`, `/match?category=${TAGGED.slug}&intent=creator`, `/match?category=${TAGGED.slug}&intent=creator&platform=ios&tier=any`, `/match?category=${EMPTY.slug}`];
  for (const width of [320, 390, 768, 1280, 1920]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: width === 390 ? "reduce" : "no-preference", isMobile: width <= 390, hasTouch: width <= 390 });
    const page = await ctx.newPage();
    for (const url of urls) {
      await page.goto(url);
      await expect(heading(page)).toBeVisible();
      await noOverflow(page);
      if (width === 390 || width === 1280) await axe(page);
    }
    if (width === 390) {
      // Tap through on a phone: the result cards are visible without waiting for any animation.
      await page.goto(`/match?category=${TAGGED.slug}&intent=creator&platform=ios`);
      await page.locator(".option-grid").getByRole("link", { name: /^No preference/ }).tap();
      await expect(heading(page)).toHaveText(/Your match\./);
      const opacity = await page.locator("main article.review-card").first().evaluate((el) => getComputedStyle(el.closest("li")!).opacity);
      expect(opacity).toBe("1");
    }
    await ctx.close();
  }
});
