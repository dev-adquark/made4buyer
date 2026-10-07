import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Rendering guarantees behind the Core Web Vitals work:
 * - the server HTML never hides the hero (no page-enter animation, no reveal start state), so the
 *   LCP text paints without waiting for JavaScript;
 * - the page reads without JavaScript at all;
 * - swapping the fallback fonts for the web fonts does not move the page (CLS ≤ 0.1).
 *
 * Runs after pipeline.spec.ts (alphabetical order, one worker), which publishes the reviews.
 */

const MOBILE = { viewport: { width: 412, height: 823 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true };

test("homepage SSR HTML: hero and lede are not hidden by an entrance or reveal state", async ({ request }) => {
  const html = await (await request.get("/")).text();
  expect(html).not.toMatch(/class="[^"]*\bpage-enter\b/);
  expect(html).not.toMatch(/\brv-pending\b/);
  const hero = html.slice(html.indexOf('<section class="tear-hero"'), html.indexOf("</section>", html.indexOf('<section class="tear-hero"')));
  expect(hero).toContain('id="hero-title"');
  expect(hero).toContain('class="lede"');
  expect(hero).not.toMatch(/opacity:\s*0(?![.\d])/);
  expect(hero).not.toMatch(/visibility:\s*hidden/);
});

test("homepage without JavaScript shows the hero headline and lede", async ({ browser }) => {
  const ctx = await browser.newContext({ ...MOBILE, javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto("/");
  const h1 = page.locator("#hero-title");
  await expect(h1).toBeVisible();
  await expect(h1).toContainText("Buy less.");
  const lede = page.locator(".tear-hero .lede");
  await expect(lede).toBeVisible();
  expect(await lede.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);
  expect(await h1.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);
  await ctx.close();
});

/**
 * Cumulative layout shift of a page load on a phone-sized viewport. Web fonts are held back by
 * 800 ms so the fallback faces paint first and the swap happens after first paint, as on a slow
 * connection; that swap is what used to shift the page.
 */
async function loadCls(browser: Browser, url: string): Promise<{ cls: number; shifts: string[] }> {
  const ctx = await browser.newContext(MOBILE);
  const page: Page = await ctx.newPage();
  await page.route(/\.woff2(\?|$)/, async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __cls: number; __shifts: string[] };
    w.__cls = 0;
    w.__shifts = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: Array<{ node?: Node }> }>) {
        if (e.hadRecentInput) continue;
        w.__cls += e.value;
        w.__shifts.push(`${e.value.toFixed(4)} ${(e.sources ?? []).map((s) => (s.node as Element | undefined)?.className || s.node?.nodeName).join(", ")}`);
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto(url, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1000);
  const out = await page.evaluate(() => {
    const w = window as unknown as { __cls: number; __shifts: string[] };
    return { cls: w.__cls, shifts: w.__shifts };
  });
  await ctx.close();
  return out;
}

test("CLS stays at or below 0.1 on the homepage and a review page while fonts swap", async ({ browser, page }) => {
  const home = await loadCls(browser, "/");
  expect(home.cls, `home shifts: ${home.shifts.join(" | ")}`).toBeLessThanOrEqual(0.1);

  await page.goto("/category/laptops");
  const href = await page.locator('a[href^="/review/"]').first().getAttribute("href");
  test.skip(!href, "no published review in this database");
  const review = await loadCls(browser, href!);
  expect(review.cls, `review shifts: ${review.shifts.join(" | ")}`).toBeLessThanOrEqual(0.1);
});
