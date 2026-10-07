import AxeBuilder from "@axe-core/playwright";
import { expect, request as pwRequest, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { FORBIDDEN_PUBLIC_TOKENS, NO_VERIFIED_OFFER } from "../../lib/public/display";
import { cleanupDealFixtures, disconnect, FIX, HIDDEN_TEXT, seedAndPublish } from "./deals-fixtures";

/**
 * The populated Deals experience: commerce rows seeded straight into the E2E database (one valid
 * official price drop among a stale, an out-of-stock, a broken-link and a utm-duplicate offer; one
 * verified code among an expired and an unverified one), then /deals and the homepage rail are
 * checked for what is shown, what is hidden, markup, clipboard, keyboard, axe, layout and links.
 *
 * Runs before pipeline.spec.ts (alphabetical) and removes its data afterwards, purging the deals
 * cache, so the rest of the suite still sees the empty state.
 */

const BASE = `http://localhost:${process.env.E2E_PORT ?? 3100}`;
let api: APIRequestContext;

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: BASE });
  await seedAndPublish(api);
});

test.afterAll(async () => {
  await cleanupDealFixtures(api);
  await api.dispose();
  await disconnect();
});

const drops = (page: Page) => page.getByRole("region", { name: "Verified price drops" });
const codes = (page: Page) => page.getByRole("region", { name: "Latest verified coupons" });
const viewDeal = (scope: Locator | Page) => scope.getByRole("link", { name: /^View deal\b/ });
const codeLinkOf = (scope: Locator | Page) => scope.getByRole("link", { name: /^View offer\b/ });
const copyButton = (scope: Locator | Page) => scope.getByRole("button", { name: /^Cop(y|ied)\b/ });

async function settle(page: Page) {
  // The settled state a reader sees: finish scroll reveals (same as the pipeline suite's audit).
  await page.evaluate(() => document.querySelectorAll(".reveal").forEach((e) => e.classList.add("in")));
  await page.waitForTimeout(900);
}

async function seriousAxe(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  return result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test("deals: only the valid drop and the verified code are listed, with the right saving", async ({ page }) => {
  const res = await page.goto("/deals");
  expect(res?.status()).toBe(200);
  // (Each section carries a hidden "nothing matches this filter" note; none may be visible.)
  await expect(page.getByText(NO_VERIFIED_OFFER).filter({ visible: true })).toHaveCount(0);

  // Exactly one price drop (the utm duplicate collapsed into it) and one promo code.
  await expect(drops(page).locator("[data-deal]")).toHaveCount(1);
  await expect(codes(page).locator("[data-deal]")).toHaveCount(1);
  // The third section lists current prices without a stated previous price: none of the fixtures
  // qualifies (the out-of-stock and broken offers must not fall through into it).
  const recent = page.getByRole("region", { name: "Recently verified" });
  await expect(recent).toBeVisible();
  await expect(recent.locator("[data-deal]")).toHaveCount(0);
  const drop = drops(page).locator("[data-deal]").first();
  await expect(drop).toContainText(FIX.valid.product);
  await expect(drop.getByText("Verified", { exact: true }).first()).toBeVisible();
  await expect(drop.locator(".dc-price")).toHaveText(`Current price ${FIX.valid.priceText}`);
  await expect(drop.locator(".dc-was")).toHaveText(`Regular price ${FIX.valid.listPriceText}`);
  await expect(drop).toContainText(FIX.valid.savingText);
  await expect(drop).toContainText(FIX.valid.savingPercent);
  // When it was checked, as a machine-readable time.
  await expect(drop.locator("time[datetime]").first()).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);
  await expect(drop).toContainText(/Last checked\s*2 hours ago/);
  await expect(drop).toContainText("In stock");
  // The link is the clean official page, never the utm variant.
  await expect(viewDeal(drop)).toHaveCount(1);
  await expect(viewDeal(drop)).toHaveAttribute("href", FIX.valid.url);

  const code = codes(page).locator("[data-deal]").first();
  // Brand, the offer exactly as stated, the code with "Copy code", when it was verified, the stated
  // terms and expiry, and "View offer" to the brand's own page that publishes it.
  await expect(code.getByRole("heading", { name: new RegExp(`^${FIX.brand.name}\\b`) })).toBeVisible();
  await expect(code.locator(".cc-offer")).toHaveText(FIX.codes.verifiedDiscount);
  await expect(code.locator("code")).toHaveText(FIX.codes.verified);
  await expect(copyButton(code)).toHaveText("Copy code");
  await expect(code).toContainText(/✓\s*Verified\s*1 hour ago/);
  await expect(code.locator("time[datetime]").first()).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);
  await expect(code).toContainText(/Terms\s*New and returning customers/);
  await expect(code).toContainText(/Expires\s*[A-Z][a-z]{2} \d{1,2}, \d{4} \(as stated\)/);
  await expect(code).not.toContainText("Last checked");
  await expect(codeLinkOf(code)).toHaveCount(1);
  await expect(codeLinkOf(code)).toHaveAttribute("href", FIX.promoUrl);
  await expect(codeLinkOf(code)).toHaveAttribute("rel", /\bnofollow\b.*\bnoopener\b|\bnoopener\b.*\bnofollow\b/);

  const text = await page.locator("body").innerText();
  for (const hidden of HIDDEN_TEXT) expect(text, `"${hidden}" must not be listed`).not.toContain(hidden);
  expect(text.match(FORBIDDEN_PUBLIC_TOKENS)?.[0], "forbidden token on /deals").toBeUndefined();
  // Listed once (its name also appears in the View deal link's accessible text, so count headings).
  await expect(page.getByRole("heading", { name: FIX.valid.product, exact: true })).toHaveCount(1);
  expect(await page.content()).not.toContain("utm_source");

  // Indexable once it has verified offers.
  await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);
});

test("deals: Offer JSON-LD only for the valid drop", async ({ page }) => {
  await page.goto("/deals");
  const blocks = (await page.locator('script[type="application/ld+json"]').allTextContents()).map((t) => JSON.parse(t));
  const all = JSON.stringify(blocks);
  expect(all.match(/"@type":"Offer"/g)?.length ?? 0, "exactly one Offer").toBe(1);
  const list = blocks.find((b) => b["@type"] === "ItemList");
  expect(list, "ItemList of price drops").toBeTruthy();
  expect(list.itemListElement).toHaveLength(1);
  const item = list.itemListElement[0].item;
  expect(item.name).toBe(FIX.valid.product);
  expect(item.offers).toMatchObject({ "@type": "Offer", price: FIX.valid.price, priceCurrency: "USD", url: FIX.valid.url });
  for (const hidden of HIDDEN_TEXT) expect(all).not.toContain(hidden);
});

test("deals: Copy copies the code and announces it", async ({ browser }) => {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  await page.goto("/deals");
  const code = codes(page).locator("[data-deal]").first();
  const copy = copyButton(code);
  await expect(copy).toBeVisible();
  await copy.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(FIX.codes.verified);
  // Announced to assistive tech through a polite live region, and shown on the button.
  const live = code.locator('[role="status"][aria-live="polite"]');
  await expect(live).toHaveText("Copied");
  await expect(copy).toContainText("Copied");
  await context.close();
});

test("deals: keyboard reaches View deal, Copy code and View offer with a visible focus ring", async ({ page }) => {
  await page.goto("/deals");
  await settle(page);
  const targets: Array<[string, RegExp]> = [
    ["View deal", /^View deal\b/],
    ["Copy code", /^Copy code\b/],
    ["View offer", /^View offer\b/],
  ];
  const reached = new Map<string, { visible: boolean; style: string }>();
  await page.locator("body").focus();
  for (let i = 0; i < 120 && reached.size < targets.length; i++) {
    await page.keyboard.press("Tab");
    const f = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const name = (el.getAttribute("aria-label") ?? el.innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
      const cs = getComputedStyle(el);
      const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
      const shadow = cs.boxShadow !== "none" && cs.boxShadow !== "";
      return { name, focusVisible: el.matches(":focus-visible"), ring: outline || shadow, style: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor} / ${cs.boxShadow}` };
    });
    if (!f) continue;
    for (const [label, re] of targets) if (!reached.has(label) && re.test(f.name)) reached.set(label, { visible: f.focusVisible && f.ring, style: f.style });
  }
  for (const [label] of targets) {
    expect(reached.has(label), `Tab reaches ${label}`).toBe(true);
    expect(reached.get(label)?.visible, `${label} shows a visible focus indicator (${reached.get(label)?.style})`).toBe(true);
  }
});

test("deals and homepage: no serious or critical axe violations", async ({ page }) => {
  for (const p of ["/deals", "/"]) {
    await page.goto(p);
    await settle(page);
    const serious = await seriousAxe(page);
    expect(serious, `${p}: ${serious.join("; ")}`).toEqual([]);
  }
});

test("deals: responsive at phone, tablet and desktop widths", async ({ browser }, info) => {
  for (const [name, width, height] of [["phone-360", 360, 740], ["tablet-768", 768, 1024], ["desktop-1280", 1280, 800]] as const) {
    const v = await browser.newPage({ viewport: { width, height } });
    await v.goto("/deals");
    await settle(v);
    const { scrollWidth, innerWidth } = await v.evaluate(() => ({ scrollWidth: document.scrollingElement!.scrollWidth, innerWidth: window.innerWidth }));
    expect(scrollWidth, `no horizontal scroll at ${name}`).toBeLessThanOrEqual(innerWidth);
    for (const card of [drops(v).locator("[data-deal]").first(), codes(v).locator("[data-deal]").first()]) {
      await card.scrollIntoViewIfNeeded();
      await expect(card).toBeVisible();
      const box = await card.boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= width + 1, `card fits the viewport at ${name}`).toBe(true);
    }
    await expect(viewDeal(drops(v))).toBeVisible();
    await expect(copyButton(codes(v))).toBeVisible();
    await expect(codeLinkOf(codes(v))).toBeVisible();
    await info.attach(`deals-populated-${name}`, { body: await v.screenshot({ fullPage: true }), contentType: "image/png" });
    await v.close();
  }
});

test("homepage: Verified deals rail shows the drop and the code and links to /deals", async ({ page }) => {
  await page.goto("/");
  const rail = page.getByRole("region", { name: "Verified deals" });
  await expect(rail).toBeVisible();
  await expect(rail).toContainText(FIX.valid.product);
  await expect(rail).toContainText(FIX.valid.priceText);
  await expect(rail).toContainText(FIX.valid.savingText);
  await expect(rail).toContainText(FIX.codes.verified);
  const railText = await rail.innerText();
  for (const hidden of HIDDEN_TEXT) expect(railText).not.toContain(hidden);
  const all = rail.getByRole("link", { name: /All deals/ });
  await expect(all).toHaveAttribute("href", "/deals");
  expect((await page.locator("body").innerText()).match(FORBIDDEN_PUBLIC_TOKENS)?.[0], "forbidden token on /").toBeUndefined();
  await all.click();
  await page.waitForURL(/\/deals$/);
  await expect(drops(page)).toContainText(FIX.valid.product);
});

test("deals and homepage: every deal card shows a loaded image (no empty slot)", async ({ page }) => {
  for (const [path, selector] of [["/deals", "article.deal-card"], ["/", "article.hd-card"]] as const) {
    await page.goto(path);
    await settle(page);
    const cards = page.locator(selector);
    expect(await cards.count(), `${path}: deal cards`).toBeGreaterThan(0);
    const slots = await cards.evaluateAll((els) =>
      els.map((el) => {
        const img = el.querySelector("img[data-image-kind]") as HTMLImageElement | null;
        return { kind: img?.dataset.imageKind ?? null, empty: el.classList.contains("no-media") || Boolean(el.querySelector(".hd-mono")), illustrative: Boolean(el.querySelector("[data-illustrative]")) };
      }),
    );
    for (const s of slots) {
      expect(s.kind, `${path}: every card has an image`).not.toBeNull();
      expect(s.empty, `${path}: no empty media slot`).toBe(false);
      // A photo that is not the exact product is labelled on the card.
      expect(s.illustrative).toBe(s.kind === "illustrative");
    }
    for (const img of await cards.locator("img[data-image-kind]").all()) {
      await img.scrollIntoViewIfNeeded();
      await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0), { message: `${path}: card image loads` }).toBe(true);
    }
  }
});

test("deals: every link is internal and live, or external with nofollow noopener", async ({ page }) => {
  await page.goto("/deals");
  const links = await page.locator("a[href]").evaluateAll((as) => as.map((a) => ({ href: (a as HTMLAnchorElement).href, raw: a.getAttribute("href") ?? "", rel: a.getAttribute("rel") ?? "", text: (a.textContent ?? "").trim().slice(0, 60) })));
  expect(links.length).toBeGreaterThan(0);
  const origin = new URL(BASE).origin;
  const internal = new Set<string>();
  let external = 0;
  for (const l of links) {
    expect(l.raw, `empty or placeholder href on "${l.text}"`).not.toMatch(/^(#?|javascript:.*)$/i);
    const u = new URL(l.href);
    if (u.origin === origin) {
      internal.add(u.pathname + u.search);
      continue;
    }
    external++;
    const rel = l.rel.split(/\s+/);
    expect(rel, `rel of external link ${l.href}`).toEqual(expect.arrayContaining(["nofollow", "noopener"]));
    expect(u.protocol, l.href).toBe("https:");
  }
  expect(external, "the drop and the code link out to the brand").toBeGreaterThanOrEqual(2);
  for (const path of internal) {
    if (path.startsWith("/go/")) {
      // Click-out redirects are not followed (they leave the site); they must point at the seller.
      const r = await page.request.get(path, { maxRedirects: 0 });
      expect([302, 307], path).toContain(r.status());
      expect(r.headers().location ?? "", path).toMatch(/^https:\/\/(www\.)?slumberline\.com\//);
      continue;
    }
    const r = await page.request.get(path);
    expect(r.status(), path).toBe(200);
  }
});

test("cleanup restores the empty state for the rest of the suite", async ({ page }) => {
  await cleanupDealFixtures(api);
  await page.goto("/deals");
  await expect(page.getByText(NO_VERIFIED_OFFER)).toBeVisible();
  await expect(page.locator("[data-deal]")).toHaveCount(0);
  expect((await page.locator('script[type="application/ld+json"]').allTextContents()).join("")).not.toContain('"Offer"');
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Verified deals" })).toHaveCount(0);
});
