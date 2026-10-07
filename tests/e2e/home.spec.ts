import AxeBuilder from "@axe-core/playwright";
import { expect, request as pwRequest, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { CATEGORIES } from "../../lib/taxonomy/definitions";
import { cleanupDealFixtures, db, disconnect, FIX, HIDDEN_TEXT, seedAndPublish, seedDealFixtures } from "./deals-fixtures";

/**
 * The homepage rails: "Price drops" and "Latest coupons" (components/home-rail.tsx) and "Browse by
 * category" (the issue-panel rail). Multi-card rails need more than the one drop and one code that
 * deals-fixtures.ts seeds, so this spec adds test-only offers, codes and three published guides
 * (so three categories have content) to the E2E database, and removes all of them afterwards, so
 * pipeline.spec.ts still starts from a database without commerce data or published content.
 *
 * Checked: what the rails list (and never list), Prev/Next paging and their disabled state at the
 * ends, keyboard scrolling of a focused rail, touch swipe on a phone profile, no page-level
 * horizontal overflow from 320 to 1920 px, compact category panels on phones, axe, and that the deal
 * rails disappear when there is nothing verified.
 */

const BASE = `http://localhost:${process.env.E2E_PORT ?? 3100}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SITE = "https://www.slumberline.com";
const EXTRA_DROPS = 8;
/** /deals and the homepage list at most 6 codes per brand (loadPromoCodes): the fixture code plus five. */
const EXTRA_CODES = 5;
const GUIDE_SOURCE = "e2e-home-rails";
/** An 8-day-old VERIFIED code: outside the 7-day coupon window, never public. */
const OLD_CODE = "OLDWEEK8";
const WIDTHS = [320, 360, 375, 390, 430, 480, 768, 834, 1024, 1280, 1440, 1600, 1920] as const;

const extraProduct = (i: number) => ({ name: `Slumberline Rail Test Pillow ${i + 1}`, url: `${SITE}/products/e2e-rail-pillow-${i + 1}`, sku: `SL-E2E-RAIL-${i + 1}`, price: 100 + i * 10, listPrice: 220 + i * 10 });
const extraCode = (i: number) => ({ code: `RAILCODE${i + 1}`, discount: `${11 + i}% off rail test bedding` });
const guideCategories = CATEGORIES.slice(0, 3).map((c) => c.slug);

let api: APIRequestContext;

/** Test-only rows on top of deals-fixtures: more ACTIVE drops and codes, one stale code, three guides. */
async function seedHomeExtras() {
  const now = Date.now();
  const { brandId } = await seedDealFixtures(new Date(now));
  for (let i = 0; i < EXTRA_DROPS; i++) {
    const p = extraProduct(i);
    const data = { pageUrl: p.url, offers: [{ price: p.price, listPrice: p.listPrice, listPriceType: "ListPrice", priceCurrency: "USD", availability: "InStock", url: p.url }] };
    const fields = { brandId, name: p.name, observedAt: new Date(now), sku: p.sku, model: p.sku, category: FIX.brand.category, identityStatus: "UNMATCHED", data };
    const product = await db().commerceProduct.upsert({ where: { canonicalUrl: p.url }, create: { canonicalUrl: p.url, ...fields }, update: fields });
    const offer = {
      seller: FIX.brand.name,
      sellerType: "MANUFACTURER",
      price: p.price,
      listPrice: p.listPrice,
      currency: "USD",
      availability: "InStock",
      observedAt: new Date(now - (i + 1) * 60_000),
      status: "FRESH",
      linkStatus: "OK",
      linkCheckedAt: new Date(now - HOUR),
      linkHttpStatus: 200,
    };
    await db().commerceOffer.upsert({ where: { productId_destinationUrl: { productId: product.id, destinationUrl: p.url } }, create: { productId: product.id, destinationUrl: p.url, ...offer }, update: offer });
  }
  const coupon = async (code: string, discount: string, lastVerifiedAt: Date) => {
    const data = { brandId, title: `${discount} at ${FIX.brand.name}`, discount, discountType: "PERCENT", startsAt: new Date(now - 10 * DAY), expiresAt: null, merchantUrl: SITE, status: "VERIFIED", verificationEvidence: "Code listed on the brand's own offers page", observedAt: lastVerifiedAt, lastVerifiedAt };
    await db().commerceCoupon.upsert({ where: { merchant_code_sourceUrl: { merchant: FIX.brand.name, code, sourceUrl: FIX.promoUrl } }, create: { merchant: FIX.brand.name, code, sourceUrl: FIX.promoUrl, ...data }, update: data });
  };
  for (let i = 0; i < EXTRA_CODES; i++) await coupon(extraCode(i).code, extraCode(i).discount, new Date(now - (i + 2) * HOUR));
  await coupon(OLD_CODE, "8% off for the e2e window test", new Date(now - 8 * DAY));

  for (const [i, slug] of guideCategories.entries()) {
    const id = `${GUIDE_SOURCE}-${slug}`;
    const data = {
      source: GUIDE_SOURCE,
      sourceId: id,
      dedupeKey: id,
      canonicalTitle: `How to choose: ${slug} (rail test ${i + 1})`,
      kind: "BUYING_GUIDE" as const,
      slug: `e2e-rail-guide-${slug}`,
      productName: `Rail test guide ${i + 1}`,
      summary: "A short buying guide used by the homepage rail test.",
      body: "What to look for, what to skip and how to compare the options before you buy. Written for the homepage rail test.",
      categorySlug: slug,
      status: "PUBLISHED" as const,
      publishedAt: new Date(now - (i + 1) * HOUR),
      confidence: 1,
    };
    await db().normalizedReview.upsert({ where: { dedupeKey: id }, create: data, update: data });
  }
}

async function removeHomeExtras() {
  await db().normalizedReview.deleteMany({ where: { source: GUIDE_SOURCE } });
  // Every commerce row above is on the fixture brand / site: cleanupDealFixtures removes them and purges the deals cache.
  await cleanupDealFixtures(api);
}

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: BASE });
  await seedHomeExtras();
  // Re-seeds the base fixtures (idempotent), runs commerce-collect and so purges the deals cache: the homepage re-renders with the rows above.
  await seedAndPublish(api);
});

test.afterAll(async () => {
  await db().normalizedReview.deleteMany({ where: { source: GUIDE_SOURCE } });
  await cleanupDealFixtures(api);
  await api.dispose();
  await disconnect();
});

const dropsRail = (page: Page) => page.getByRole("region", { name: "Price drops", exact: true });
const codesRail = (page: Page) => page.getByRole("region", { name: "Latest coupons", exact: true });
const prevOf = (page: Page, label: string) => page.getByRole("button", { name: `Previous: ${label}` });
const nextOf = (page: Page, label: string) => page.getByRole("button", { name: `Next: ${label}` });
const scrollLeft = (rail: Locator) => rail.evaluate((el) => el.scrollLeft);
/** Resolves once scrollLeft has stopped changing (smooth scroll and snap finished). */
async function settled(rail: Locator) {
  let last = -1;
  await expect
    .poll(async () => {
      const now = await scrollLeft(rail);
      const still = now === last;
      last = now;
      return still;
    }, { intervals: [150, 150, 150, 250] })
    .toBe(true);
}

async function settle(page: Page) {
  await page.evaluate(() => document.querySelectorAll(".reveal").forEach((e) => e.classList.add("in")));
  await page.waitForTimeout(600);
}

async function seriousAxe(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  return result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

/**
 * Page-level horizontal overflow: the document scrolls sideways, OR a visible element reaches past the
 * viewport edge without a horizontally scrolling / clipping container of its own (body has
 * overflow-x: clip, which would otherwise hide such an element from scrollWidth).
 */
async function overflow(page: Page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    // Whether the page itself scrolls sideways (what a reader would experience). Raw scrollWidth is not
    // used: Chrome counts the content of nested scrollers such as the ticker in it although the page
    // cannot be scrolled to it (body is overflow-x: clip).
    const y = window.scrollY;
    window.scrollTo(vw * 10, y);
    const scrolledX = window.scrollX || document.scrollingElement!.scrollLeft;
    window.scrollTo(0, y);
    const offenders: string[] = [];
    // Walks the CONTAINING-BLOCK chain (not just DOM parents): an absolutely positioned element is
    // clipped by a scroller only when the scroller is (or contains) its containing block.
    const containingBlock = (el: HTMLElement): HTMLElement | null => {
      const pos = getComputedStyle(el).position;
      if (pos !== "absolute") return el.parentElement;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.position !== "static" || cs.transform !== "none" || cs.filter !== "none" || cs.contain.includes("paint") || cs.contain.includes("layout")) return p;
      }
      return null; // the initial containing block: nothing clips it, not even body
    };
    const contained = (el: HTMLElement) => {
      for (let p = containingBlock(el); p && p !== document.documentElement; p = containingBlock(p)) {
        if (getComputedStyle(p).overflowX !== "visible") return true;
      }
      return false;
    };
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right <= vw + 1 && r.left >= -1) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.position === "fixed") continue;
      if (contained(el)) continue;
      offenders.push(`${cs.position === "absolute" ? "absolute " : ""}${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).join(".")}` : ""} [${Math.round(r.left)}, ${Math.round(r.right)}]`);
    }
    return { vw, scrolledX, offenders: offenders.slice(0, 8) };
  });
}

test("home: the price-drop and coupon rails list every verified item and nothing else", async ({ page }) => {
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);
  const section = page.getByRole("region", { name: "Verified deals" });
  await expect(section).toBeVisible();

  const drops = dropsRail(page);
  await expect(drops).toBeVisible();
  await expect(drops.locator(".hr-list > li")).toHaveCount(1 + EXTRA_DROPS);
  await expect(drops).toContainText(FIX.valid.product);
  for (let i = 0; i < EXTRA_DROPS; i++) await expect(drops).toContainText(extraProduct(i).name);
  await expect(page.getByRole("heading", { name: `Price drops (${1 + EXTRA_DROPS})` })).toBeVisible();

  const codes = codesRail(page);
  await expect(codes).toBeVisible();
  await expect(codes.locator(".hr-list > li")).toHaveCount(1 + EXTRA_CODES);
  const listed = await codes.locator("code").allTextContents();
  expect([...listed].sort()).toEqual([FIX.codes.verified, ...Array.from({ length: EXTRA_CODES }, (_, i) => extraCode(i).code)].sort());
  await expect(page.getByRole("heading", { name: `Latest coupons (${1 + EXTRA_CODES})` })).toBeVisible();

  const text = await section.innerText();
  for (const hidden of [...HIDDEN_TEXT, OLD_CODE]) expect(text, `"${hidden}" must not be listed`).not.toContain(hidden);
  await expect(section.getByRole("link", { name: /All deals/ })).toHaveAttribute("href", "/deals");
});

test("home: Prev/Next page the rail and are disabled at its ends", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await settle(page);
  for (const [label, rail] of [["Price drops", dropsRail(page)], ["Latest coupons", codesRail(page)]] as const) {
    await rail.scrollIntoViewIfNeeded();
    const prev = prevOf(page, label);
    const next = nextOf(page, label);
    await expect(prev, `${label}: Prev is visible`).toBeVisible();
    await expect(prev, `${label}: Prev is disabled at the start`).toBeDisabled();
    await expect(next, `${label}: Next is enabled`).toBeEnabled();
    expect(await scrollLeft(rail)).toBe(0);

    await next.click();
    await expect.poll(() => scrollLeft(rail), { message: `${label}: Next scrolls` }).toBeGreaterThan(100);
    await expect(prev).toBeEnabled();

    await settled(rail);
    for (let i = 0; i < 12 && (await next.isEnabled()); i++) {
      const before = await scrollLeft(rail);
      await next.click();
      await expect.poll(() => scrollLeft(rail)).toBeGreaterThan(before);
      // Smooth scrolling: read the button state only once the rail has stopped moving.
      await settled(rail);
    }
    await expect(next, `${label}: Next is disabled at the end`).toBeDisabled();
    const end = await rail.evaluate((el) => ({ left: el.scrollLeft, max: el.scrollWidth - el.clientWidth }));
    expect(end.left, `${label}: scrolled to the end`).toBeGreaterThanOrEqual(end.max - 2);
    // The last card is fully reachable.
    const last = rail.locator(".hr-list > li").last();
    const [r, l] = await Promise.all([rail.boundingBox(), last.boundingBox()]);
    expect(l!.x + l!.width, `${label}: last card inside the rail`).toBeLessThanOrEqual(r!.x + r!.width + 2);

    await prev.click();
    await expect.poll(() => scrollLeft(rail), { message: `${label}: Prev scrolls back` }).toBeLessThan(end.left);
    await expect(next).toBeEnabled();
  }
});

test("home: a focused rail scrolls with the arrow keys", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  const rail = dropsRail(page);
  await rail.scrollIntoViewIfNeeded();
  // Reachable by Tab (the region is focusable), with a visible focus indicator.
  await rail.focus();
  await expect(rail).toBeFocused();
  expect(await rail.evaluate((el) => el.tabIndex)).toBe(0);
  expect(await scrollLeft(rail)).toBe(0);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => scrollLeft(rail), { message: "ArrowRight scrolls the rail" }).toBeGreaterThan(50);
  const afterRight = await scrollLeft(rail);
  await page.keyboard.press("End");
  await expect.poll(() => scrollLeft(rail), { message: "End scrolls to the last card" }).toBeGreaterThan(afterRight);
  await page.keyboard.press("ArrowLeft");
  const end = await rail.evaluate((el) => el.scrollWidth - el.clientWidth);
  await expect.poll(() => scrollLeft(rail), { message: "ArrowLeft scrolls back" }).toBeLessThan(end - 50);
  await page.keyboard.press("Home");
  await expect.poll(() => scrollLeft(rail), { message: "Home returns to the start" }).toBe(0);

  // Keyboard focus shows a ring (Tab into it from the element before).
  await page.locator("body").focus();
  let ring = false;
  for (let i = 0; i < 150 && !ring; i++) {
    await page.keyboard.press("Tab");
    ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el.getAttribute("aria-label") !== "Price drops") return false;
      const cs = getComputedStyle(el);
      return el.matches(":focus-visible") && ((cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow !== "none" && cs.boxShadow !== ""));
    });
  }
  expect(ring, "Tab reaches the Price drops rail with a visible focus indicator").toBe(true);
});

test("home: touch swipe scrolls a rail on a phone", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto("/");
  await settle(page);
  for (const rail of [dropsRail(page), codesRail(page)]) {
    await rail.scrollIntoViewIfNeeded();
    const box = (await rail.boundingBox())!;
    expect(await scrollLeft(rail)).toBe(0);
    const scrollY = await page.evaluate(() => window.scrollY);
    // A real touch gesture (finger moves right-to-left across the rail), not a programmatic scroll.
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.synthesizeScrollGesture", { x: Math.round(box.x + box.width * 0.8), y: Math.round(box.y + Math.min(box.height / 2, 120)), xDistance: -Math.round(box.width * 0.6), yDistance: 0, gestureSourceType: "touch", speed: 1200 });
    await cdp.detach();
    await expect.poll(() => scrollLeft(rail), { message: "swipe scrolls the rail sideways" }).toBeGreaterThan(40);
    // The page itself did not move sideways, and the swipe did not scroll it vertically either.
    expect(await page.evaluate(() => window.scrollX)).toBe(0);
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - scrollY)).toBeLessThan(40);
  }
  await context.close();
});

test("home: no page-level horizontal overflow from 320 to 1920 px", async ({ browser }, info) => {
  const problems: string[] = [];
  for (const width of WIDTHS) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto("/");
    await settle(page);
    const o = await overflow(page);
    if (o.scrolledX > 0) problems.push(`${width}px: the page scrolls sideways by ${o.scrolledX}px`);
    if (o.offenders.length) problems.push(`${width}px: ${o.offenders.join("; ")}`);
    if (width === 320 || width === 390 || width === 1280 || width === 1920) await info.attach(`home-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    await page.close();
  }
  expect(problems, problems.join("\n")).toEqual([]);
});

test("home: Browse by category shows compact issue panels on a phone", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto("/");
  await settle(page);
  const section = page.getByRole("region", { name: "Browse by category" });
  await expect(section).toBeVisible();
  const panels = section.getByRole("list", { name: "Categories" }).locator(".issue-panel");
  await expect(panels).toHaveCount(guideCategories.length);
  const names = guideCategories.map((slug) => CATEGORIES.find((c) => c.slug === slug)!.name);
  for (const [i, name] of names.entries()) {
    const panel = panels.nth(i);
    await panel.scrollIntoViewIfNeeded();
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(panel).toHaveAttribute("href", `/category/${guideCategories[i]}`);
    const box = (await panel.boundingBox())!;
    expect(box.height, `${name} panel height at 390 px`).toBeLessThanOrEqual(420);
    expect(box.width, `${name} panel width at 390 px`).toBeLessThanOrEqual(390);
  }
  // The first panel starts inside the viewport and the next one peeks in (it is a rail, not a stack).
  const [first, second] = [await panels.nth(0).boundingBox(), await panels.nth(1).boundingBox()];
  expect(Math.round(first!.y)).toBe(Math.round(second!.y));
  await page.close();
});

test("home: no serious or critical axe violations (desktop and phone)", async ({ browser }) => {
  for (const [width, height] of [[1280, 900], [390, 844]] as const) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    await page.goto("/");
    await settle(page);
    const serious = await seriousAxe(page);
    expect(serious, `/ at ${width}px: ${serious.join("; ")}`).toEqual([]);
    await context.close();
  }
});

test("home: with nothing verified the deal and coupon rails are absent", async ({ page }) => {
  await removeHomeExtras();
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Verified deals" })).toHaveCount(0);
  await expect(dropsRail(page)).toHaveCount(0);
  await expect(codesRail(page)).toHaveCount(0);
  await expect(page.locator(".hr-track")).toHaveCount(0);
  const text = await page.locator("body").innerText();
  for (const gone of [FIX.valid.product, FIX.codes.verified, extraProduct(0).name, extraCode(0).code]) expect(text).not.toContain(gone);
});
