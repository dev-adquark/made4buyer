import { expect, request as pwRequest, test, type APIRequestContext, type Page } from "@playwright/test";
import type { Prisma } from "@prisma/client";
import { db, disconnect } from "./deals-fixtures";

/**
 * Cacheable listing pages (lib/public/listing-routes.ts, proxy.ts): the default views are static
 * (ISR) and filtered URLs are rewritten to cached state routes (or, for free text, a per-request
 * route) while the browser keeps the public URL. Checked against seeded data: every query-param
 * filter lists exactly what the database query of the old per-request pages returns, robots and
 * canonical rules are unchanged, back/forward keeps the filter state, the lists render without
 * JavaScript, and the cache headers.
 *
 * Seeds its own published items in a category no other spec visits ("tablets") and removes them
 * afterwards, so pipeline.spec.ts still starts without published content.
 */

const BASE = `http://localhost:${process.env.E2E_PORT ?? 3100}`;
const SOURCE = "e2e-listings";
const CAT = "tablets";
const COUNT = 30;
const BRAND_A = { name: "Listbrand A", slug: "listbrand-a" };
const BRAND_B = { name: "Listbrand B", slug: "listbrand-b" };
const LATEST_FIRST = [{ sourcePublishedAt: { sort: "desc", nulls: "last" } }, { publishedAt: "desc" }, { id: "asc" }] satisfies Prisma.NormalizedReviewOrderByWithRelationInput[];

let api: APIRequestContext;

function item(i: number) {
  const kind = i % 5 === 0 ? ("COMPARISON" as const) : i % 7 === 0 ? ("BUYING_GUIDE" as const) : ("REVIEW" as const);
  const brand = i % 3 === 0 ? BRAND_A : BRAND_B;
  const id = `${SOURCE}-${i}`;
  return {
    source: SOURCE,
    sourceId: id,
    dedupeKey: id,
    slug: `e2e-listing-item-${i}`,
    canonicalTitle: `Listing test item ${String(i).padStart(2, "0")}`,
    productName: `Listing product ${i}`,
    kind,
    brand: brand.name,
    brandSlug: brand.slug,
    summary: "A seeded item for the listing cache tests.",
    body: "Seeded for the listing cache tests: what it is, who it is for and what to compare before buying.",
    categorySlug: CAT,
    subcategorySlug: i % 2 === 0 ? "ipads" : "android-tablets",
    status: "PUBLISHED" as const,
    publishedAt: new Date(Date.now() - (i + 1) * 3_600_000),
    confidence: 1,
  };
}

/** Titles the old per-request page listed for this filter (same where/order/paging). */
async function expected(where: Prisma.NormalizedReviewWhereInput, page = 1): Promise<string[]> {
  const rows = await db().normalizedReview.findMany({ where: { status: "PUBLISHED", ...where }, orderBy: LATEST_FIRST, skip: (page - 1) * 24, take: 24, select: { canonicalTitle: true } });
  return rows.map((r) => r.canonicalTitle);
}

const count = (where: Prisma.NormalizedReviewWhereInput) => db().normalizedReview.count({ where: { status: "PUBLISHED", ...where } });

/** Card titles inside a container, in order. */
async function titles(page: Page, scope: string): Promise<string[]> {
  return page.locator(`${scope} article.review-card`).evaluateAll((els) => els.map((el) => el.querySelector("h2, h3")?.textContent?.trim() ?? ""));
}

// Read once (no auto-waiting: an indexable page has no robots meta at all).
const robots = (page: Page) => page.evaluate(() => document.querySelector('meta[name="robots"]')?.getAttribute("content") ?? null);
const canonicalPath = (page: Page) => page.evaluate(() => document.querySelector('link[rel="canonical"]')?.getAttribute("href")?.replace(/^https?:\/\/[^/]+/, "") ?? null);

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: BASE });
  await db().normalizedReview.deleteMany({ where: { source: SOURCE } });
  for (let i = 0; i < COUNT; i++) await db().normalizedReview.create({ data: item(i) });
});

test.afterAll(async () => {
  await db().normalizedReview.deleteMany({ where: { source: SOURCE } });
  await api.dispose();
  await disconnect();
});

test("category: query-param filters list exactly the matching items, with the same robots rules", async ({ page }) => {
  const cases: Array<{ url: string; where: Prisma.NormalizedReviewWhereInput; page?: number; indexed: boolean; label: RegExp }> = [
    { url: `/category/${CAT}`, where: { categorySlug: CAT }, indexed: true, label: /^\d+ items$/ },
    { url: `/category/${CAT}?brand=${BRAND_A.slug}`, where: { categorySlug: CAT, brandSlug: BRAND_A.slug }, indexed: false, label: /^\d+ items$/ },
    { url: `/category/${CAT}?type=comparison`, where: { categorySlug: CAT, kind: { in: ["COMPARISON"] } }, indexed: false, label: /^\d+ comparisons$/ },
    { url: `/category/${CAT}?sub=ipads&type=review`, where: { categorySlug: CAT, subcategorySlug: "ipads", kind: { in: ["REVIEW"] } }, indexed: false, label: /^\d+ reviews$/ },
    { url: `/category/${CAT}?page=2`, where: { categorySlug: CAT }, page: 2, indexed: false, label: /^\d+ items$/ },
    { url: `/category/${CAT}?page=1`, where: { categorySlug: CAT }, indexed: true, label: /^\d+ items$/ },
    // Values that change nothing still made the page noindex before; they still do.
    { url: `/category/${CAT}?type=bogus`, where: { categorySlug: CAT }, indexed: false, label: /^\d+ items$/ },
    { url: `/category/${CAT}?brand=NOT_A_SLUG`, where: { categorySlug: CAT }, indexed: false, label: /^\d+ items$/ },
    // Free text: rendered per request (proxy → q route).
    { url: `/category/${CAT}?q=${encodeURIComponent("item 0")}`, where: { categorySlug: CAT, AND: [{ OR: [{ canonicalTitle: { contains: "item", mode: "insensitive" } }, { productName: { contains: "item", mode: "insensitive" } }, { brand: { contains: "item", mode: "insensitive" } }, { summary: { contains: "item", mode: "insensitive" } }] }] }, indexed: false, label: /^\d+ items matching “item 0”$/ },
  ];
  for (const c of cases) {
    const res = await page.goto(c.url);
    expect(res?.status(), c.url).toBe(200);
    expect(page.url(), "the public URL is kept").toBe(`${BASE}${c.url}`);
    const want = await expected(c.where, c.page);
    expect(want.length, `${c.url} has seeded results`).toBeGreaterThan(0);
    expect(await titles(page, "#results"), c.url).toEqual(want);
    const total = await count(c.where);
    await expect(page.locator("#results-title"), c.url).toHaveText(c.label);
    await expect(page.locator("#results-title"), c.url).toContainText(String(total));
    expect(await robots(page), c.url).toBe(c.indexed ? null : "noindex, follow");
    expect(await canonicalPath(page), c.url).toBe(`/category/${CAT}`);
  }
  // A page past the end lists nothing (and says so), as before.
  await page.goto(`/category/${CAT}?brand=${BRAND_A.slug}&page=9`);
  await expect(page.getByText("No reviews match these filters.")).toBeVisible();
});

test("reviews and guides: type and page parameters", async ({ page }) => {
  const kinds = { review: ["REVIEW"], comparison: ["COMPARISON"], guide: ["BUYING_GUIDE", "AI_GUIDE"] } as const;
  for (const [param, k] of Object.entries(kinds)) {
    await page.goto(`/reviews?type=${param}`);
    expect(await titles(page, "main")).toEqual(await expected({ kind: { in: [...k] } }));
    expect(await robots(page)).toBe("noindex, follow");
    await expect(page.getByRole("navigation", { name: "Filter by content type" }).locator('a[aria-current="page"]')).toHaveAttribute("href", `/reviews?type=${param}`);
  }
  await page.goto("/reviews");
  expect(await titles(page, "main")).toEqual(await expected({}));
  expect(await robots(page)).toBeNull();
  if ((await count({})) > 24) {
    await page.goto("/reviews?page=2");
    expect(await titles(page, "main")).toEqual(await expected({}, 2));
    expect(await robots(page)).toBe("noindex, follow");
  }
  await page.goto("/guides");
  expect(await titles(page, "main")).toEqual(await expected({ kind: { in: ["AI_GUIDE", "BUYING_GUIDE"] } }));
  await page.goto("/guides?page=2");
  expect(await titles(page, "main")).toEqual(await expected({ kind: { in: ["AI_GUIDE", "BUYING_GUIDE"] } }, 2));
  expect(await robots(page)).toBe("noindex, follow");
});

test("match, compare and search keep their query-param behaviour", async ({ page }) => {
  await page.goto(`/match?category=${CAT}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("What matters most?");
  await page.goto(`/match?category=${CAT}&intent=any&platform=any&tier=any`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your match.");
  expect(await titles(page, "main")).toEqual((await expected({ categorySlug: CAT })).slice(0, 12));
  await page.goto("/match?category=not-a-category");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("What are you buying?");

  const two = await db().normalizedReview.findMany({ where: { source: SOURCE }, orderBy: { canonicalTitle: "asc" }, take: 2, select: { id: true, productName: true } });
  await page.goto(`/compare?ids=${two.map((r) => r.id).join(",")}`);
  await expect(page.locator(".compare-shell")).toHaveAttribute("aria-label", `Comparing ${two.map((r) => r.productName).join(", ")}`);
  await page.goto("/compare");
  await expect(page.getByRole("heading", { name: "Pick up to three products" })).toBeVisible();

  await page.goto(`/search?q=${encodeURIComponent("Listing test item 07")}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Results for “Listing test item 07”");
  await expect(page.locator("main article.review-card").first()).toContainText("Listing test item 07");
  await page.goto("/search");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Search");
});

test("back and forward keep the filter state", async ({ page }) => {
  await page.goto(`/category/${CAT}`);
  const all = await titles(page, "#results");
  await page.locator("#category-filters").getByRole("link", { name: new RegExp(`^${BRAND_A.name}`) }).click();
  await expect(page).toHaveURL(`${BASE}/category/${CAT}?brand=${BRAND_A.slug}`);
  const brandOnly = await expected({ categorySlug: CAT, brandSlug: BRAND_A.slug });
  await expect.poll(() => titles(page, "#results")).toEqual(brandOnly);
  await page.getByRole("navigation", { name: "Filter by content type" }).getByRole("link", { name: /^Comparisons/ }).click();
  await expect(page).toHaveURL(`${BASE}/category/${CAT}?brand=${BRAND_A.slug}&type=comparison`);
  await expect.poll(() => titles(page, "#results")).toEqual(await expected({ categorySlug: CAT, brandSlug: BRAND_A.slug, kind: { in: ["COMPARISON"] } }));

  await page.goBack();
  await expect(page).toHaveURL(`${BASE}/category/${CAT}?brand=${BRAND_A.slug}`);
  await expect.poll(() => titles(page, "#results")).toEqual(brandOnly);
  await expect(page.locator("#category-filters").getByRole("link", { name: new RegExp(`^${BRAND_A.name}`) })).toHaveAttribute("aria-current", "true");
  await page.goBack();
  await expect(page).toHaveURL(`${BASE}/category/${CAT}`);
  await expect.poll(() => titles(page, "#results")).toEqual(all);
  await page.goForward();
  await expect(page).toHaveURL(`${BASE}/category/${CAT}?brand=${BRAND_A.slug}`);
  await expect.poll(() => titles(page, "#results")).toEqual(brandOnly);

  // The same on /reviews.
  await page.goto("/reviews");
  await page.getByRole("navigation", { name: "Filter by content type" }).getByRole("link", { name: "Comparisons" }).click();
  await expect(page).toHaveURL(`${BASE}/reviews?type=comparison`);
  await expect.poll(() => titles(page, "main")).toEqual(await expected({ kind: { in: ["COMPARISON"] } }));
  await page.goBack();
  await expect(page).toHaveURL(`${BASE}/reviews`);
  await expect.poll(() => titles(page, "main")).toEqual(await expected({}));
});

test("without JavaScript the lists render (default and filtered)", async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  for (const [url, where] of [
    [`/category/${CAT}`, { categorySlug: CAT }],
    [`/category/${CAT}?brand=${BRAND_B.slug}`, { categorySlug: CAT, brandSlug: BRAND_B.slug }],
    ["/reviews", {}],
    ["/reviews?type=comparison", { kind: { in: ["COMPARISON"] } }],
  ] as Array<[string, Prisma.NormalizedReviewWhereInput]>) {
    await page.goto(url);
    expect(await titles(page, url.startsWith("/category") ? "#results" : "main"), url).toEqual(await expected(where));
  }
  await page.goto(`/search?q=${encodeURIComponent("Listing test item 07")}`);
  await expect(page.locator("main article.review-card").first()).toContainText("Listing test item 07");
  await ctx.close();
});

test("cache headers: default and filter-state views are cached, free text is per request, internal routes 404", async () => {
  const cc = async (path: string) => {
    const r = await api.get(path, { maxRedirects: 0 });
    return { status: r.status(), cache: r.headers()["cache-control"] ?? "" };
  };
  for (const path of [`/category/${CAT}`, `/category/${CAT}?brand=${BRAND_A.slug}&page=1`, "/reviews?type=review", "/guides?page=2", `/match?category=${CAT}`]) {
    const r = await cc(path);
    expect(r.status, path).toBe(200);
    expect(r.cache, path).toMatch(/s-maxage=300/);
  }
  for (const path of [`/category/${CAT}?q=item`, `/search?q=item`]) expect((await cc(path)).cache, path).toMatch(/no-store/);
  for (const path of [`/category/${CAT}/v/brand.${BRAND_A.slug}~noindex`, `/category/${CAT}/q?q=item`, "/reviews/v/type.review~noindex", "/search/q?q=item", "/compare/q"]) expect((await cc(path)).status, path).toBe(404);
});
