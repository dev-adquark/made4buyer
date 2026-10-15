import { expect, test } from "@playwright/test";
import { db, disconnect } from "./deals-fixtures";

/**
 * /reviews pagination in a real browser against the production build. Regression test for the bug
 * where "Next page"/"Previous page" were next/link <Link>s: a client-side transition to the same
 * pathname (/reviews?page=2) reused the cached static /reviews instead of going through proxy.ts's
 * rewrite to the paged view, so clicking Next page silently stayed on page 1.
 */

const SOURCE = "e2e-reviews-pagination";
const PAGE_SIZE = 24;
const COUNT = PAGE_SIZE + 3; // two pages

test.beforeAll(async () => {
  await db().normalizedReview.deleteMany({ where: { source: SOURCE } });
  for (let i = 0; i < COUNT; i++) {
    const id = `${SOURCE}-${i + 1}`;
    const name = `Zorbix Paginated Product ${String(i + 1).padStart(2, "0")}`;
    await db().normalizedReview.create({
      data: { source: SOURCE, sourceId: id, dedupeKey: id, slug: id, canonicalTitle: name, productName: name, brand: "Zorbix", summary: "Seeded for reviews pagination tests.", body: "Seeded for reviews pagination tests.", kind: "REVIEW", categorySlug: "drones-gadgets", status: "PUBLISHED", publishedAt: new Date(Date.now() + i * 1000), confidence: 1 },
    });
  }
});

test.afterAll(async () => {
  await db().normalizedReview.deleteMany({ where: { source: SOURCE } });
  await disconnect();
});

test("clicking Next page actually shows page 2's reviews, not page 1 again", async ({ page }) => {
  await page.goto("/reviews");
  await expect(page.getByText(/Page 1 of/)).toBeVisible();
  const page1Text = await page.locator("main").innerText();

  await page.getByRole("link", { name: "Next page" }).click();
  await page.waitForURL(/\/reviews\?page=2/);
  await expect(page.getByText("Page 2 of")).toBeVisible();
  const page2Text = await page.locator("main").innerText();
  expect(page2Text).not.toBe(page1Text);

  // Previous page returns to page 1 with the same full-page-load behavior.
  await page.getByRole("link", { name: "Previous page" }).click();
  await page.waitForURL(/\/reviews(\?page=1)?$/);
  await expect(page.getByText(/Page 1 of/)).toBeVisible();
});
