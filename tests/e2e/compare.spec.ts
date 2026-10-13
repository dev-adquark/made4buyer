import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { db, disconnect } from "./deals-fixtures";

/**
 * Compare (/compare) in a real browser against the production build: pick products, compare,
 * remove, reload, back/forward, bad ids. Seeds its own published reviews (names unique to this
 * spec, found through the picker's search box) and removes them.
 */

const SOURCE = "e2e-compare";
const NAMES = ["Zorbix Compare Alpha", "Zorbix Compare Bravo", "Zorbix Compare Charlie", "Zorbix Compare Delta"];
const ids: string[] = [];

test.beforeAll(async () => {
  await db().normalizedReview.deleteMany({ where: { source: SOURCE } });
  for (const [i, name] of NAMES.entries()) {
    const id = `${SOURCE}-${i + 1}`;
    const r = await db().normalizedReview.create({
      data: { source: SOURCE, sourceId: id, dedupeKey: id, slug: id, canonicalTitle: name, productName: name, brand: i % 2 ? "Zorbix" : "Qwerty", summary: "Seeded for compare tests.", body: "Seeded for compare tests.", kind: "REVIEW", categorySlug: "drones-gadgets", status: "PUBLISHED", publishedAt: new Date(Date.now() + i * 1000), confidence: 1 },
    });
    ids.push(r.id);
  }
});

test.afterAll(async () => {
  await db().normalizedReview.deleteMany({ where: { source: SOURCE } });
  await disconnect();
});

const pick = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(name) }).click();
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

test("picks products, compares them, removes one; every step shows the page its URL names", async ({ page }) => {
  await page.goto("/compare");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Compare products");
  await expect(page.getByRole("button", { name: "Compare selected" })).toBeDisabled();
  await page.getByLabel("Find a product").fill("Zorbix Compare");
  await pick(page, "Alpha");
  await expect(page.getByRole("button", { name: "Compare selected" })).toBeDisabled();
  await pick(page, "Bravo");
  await page.getByRole("link", { name: "Compare selected" }).click();
  await page.waitForURL(/\/compare\?ids=/);
  const board = page.locator(".compare-shell");
  await expect(board).toContainText("Zorbix Compare Alpha");
  await expect(board).toContainText("Zorbix Compare Bravo");
  await expect(board).not.toContainText("Price"); // no verified price: the row is left out, never invented
  await expect(page.getByRole("heading", { name: "Add or swap products" })).toBeVisible();

  // Reload keeps the comparison; back returns to the picker; forward returns to the comparison.
  await page.reload();
  await expect(board).toContainText("Zorbix Compare Bravo");
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Pick up to three products" })).toBeVisible();
  await page.goForward();
  await expect(board).toContainText("Zorbix Compare Alpha");

  // Remove one: a single product asks for another, never an empty or stale table.
  await page.getByRole("link", { name: /Remove.*Zorbix Compare Alpha/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Add at least one more" })).toBeVisible();
  await expect(page.locator(".compare-shell")).toHaveCount(0);
});

test("three is the maximum; the fourth is disabled and the search narrows the list", async ({ page }) => {
  await page.goto(`/compare?ids=${ids.slice(0, 3).join(",")}`);
  await expect(page.locator(".compare-shell")).toContainText("Zorbix Compare Charlie");
  await expect(page.getByRole("heading", { name: "Swap products" })).toBeVisible();
  await page.getByLabel("Find a product").fill("Zorbix Compare");
  await expect(page.getByRole("button", { name: /Delta/ })).toBeDisabled();
  await page.getByLabel("Find a product").fill("no-such-product-xyz");
  await expect(page.getByText("No published product matches")).toBeVisible();
});

test("bad, unknown and unpublished ids fall back to the picker without an error", async ({ page }) => {
  for (const q of ["ids=", "ids=not-an-id", "ids=aaaaaaaaaaaaaaaaaaaaaaaaa,bbbbbbbbbbbbbbbbbbbbbbbbb", `ids=${ids[0]}`]) {
    const res = await page.goto(`/compare?${q}`);
    expect(res?.status()).toBe(200);
    await expect(page.locator(".compare-shell")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Compare products");
  }
  expect((await page.request.get("/compare/q")).status()).toBe(404);
});

test("no overflow and no accessibility violations, with and without a comparison", async ({ page }) => {
  for (const url of ["/compare", `/compare?ids=${ids.slice(0, 3).join(",")}`]) {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await noOverflow(page);
    const result = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(result.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")} ${n.any[0]?.message ?? ""}`))).toEqual([]);
  }
});
