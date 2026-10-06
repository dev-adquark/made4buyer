import { FORBIDDEN_PUBLIC_TOKENS, NO_VERIFIED_OFFER, NO_VERIFIED_PRICE } from "../../lib/public/display";
import { CATEGORIES } from "../../lib/taxonomy/definitions";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * End-to-end: admin login → ingestion → QA queue → edit → CSV import → deal status (commerce
 * engine, no data here) → retailer links → publish → public review/category/search pages → /go guard →
 * analytics → reject → restore → unpublish, plus dead-link / dead-button sweeps.
 * Runs serially against one fresh database seeded only by the UI flow itself.
 */

test.describe.configure({ mode: "serial" });

const ADMIN = { email: "admin@e2e.test", password: "e2e-password-123456" };
let page: Page;
const state: { macbookSlug?: string; pixelSlug?: string; pixelId?: string; gearId?: string } = {};

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
  page.on("dialog", (d) => d.accept());
});
test.afterAll(async () => page.close());

async function flash(text: RegExp | string) {
  await expect(page.getByRole("status").filter({ hasText: text })).toBeVisible();
}

test("1. admin login", async () => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login/);
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Invalid email or password." })).toBeVisible();
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
});

test("2. ingestion from the admin UI", async () => {
  await page.getByRole("button", { name: "Run ingestion now" }).click();
  await flash(/ingest finished/);
  await page.goto("/admin/ingestion");
  const run = page.getByRole("row").filter({ hasText: "sample-fixture" }).first();
  await expect(run).toContainText("COMPLETED_WITH_ERRORS");
  await expect(run.getByRole("cell").nth(3)).toHaveText("15");
  await page.getByRole("link", { name: /^DUPLICATE/ }).click();
  await expect(page.getByText("DUPLICATE_REVIEW").first()).toBeVisible();
});

test("3. low-confidence items are not held for an editor", async () => {
  await page.goto("/admin/qa");
  const gear = page.getByRole("row").filter({ hasText: "Our favourite gear" });
  await expect(gear).toBeVisible();
  await expect(gear).not.toContainText("ENTITIES_NEED_REVIEW");
  await expect(gear.getByRole("button", { name: /^Publish/ })).toBeEnabled();
  await gear.getByRole("link", { name: /Our favourite gear/ }).click();
  await page.waitForURL(/\/admin\/reviews\/[a-z0-9]+$/);
  state.gearId = page.url().split("/").pop();
});

test("4. edit a review", async () => {
  await page.goto("/admin/qa");
  await page.getByRole("link", { name: /Dell XPS 14/ }).first().click();
  await page.getByLabel("Summary").fill("Edited in E2E: Dell's 14-inch XPS with an OLED screen for creators on Windows 11.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await flash("Review saved");
  await expect(page.getByLabel("Summary")).toHaveValue(/Edited in E2E/);
});

test("5. CSV import with preview and processing", async () => {
  await page.goto("/admin/csv");
  const csv = `normalized_review_key,override_primary_category,entity_brand_override,entity_product_name_override\n${state.gearId},accessories,Various,Home office desk gear\nunknown-review,phones,,\n`;
  await page.getByLabel("CSV file").setInputFiles({ name: "overrides.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Upload & validate" }).click();
  await flash(/Validated 2 row\(s\): 1 ready, 1 invalid/);
  await expect(page.getByRole("row").filter({ hasText: "unknown-review" })).toContainText("CSV_UNKNOWN_REVIEW");
  await page.getByRole("button", { name: "Process 1 pending row(s)" }).click();
  await flash(/1 applied/);
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download error report (CSV)" }).click();
  expect((await download).suggestedFilename()).toMatch(/errors\.csv$/);
  await page.goto(`/admin/reviews/${state.gearId}`);
  await expect(page.getByText("All QA gates pass.")).toBeVisible();
});

test("6. deal status comes from the commerce engine (no data in this suite)", async () => {
  await page.goto("/admin/deals");
  const mba = page.getByRole("row").filter({ hasText: "MacBook Air 13 (M4)" });
  await expect(mba).toContainText("UNAVAILABLE");
  await expect(mba).toContainText("commerce engine");
  await expect(page.locator("body")).not.toContainText(/sovrn|viglink/i);
});

test("7. retailer links admin: plain links, no affiliate provider", async () => {
  await page.goto("/admin/links");
  await expect(page.getByRole("heading", { level: 1, name: "Retailer links" })).toBeVisible();
  await expect(page.locator("main, body").first()).toContainText("Affiliate provider: none");
  await expect(page.getByText("No commerce offers stored yet.")).toBeVisible();
});

test("8. publish the QA-passed queue", async () => {
  await page.goto("/admin/qa");
  await page.getByRole("button", { name: /Publish all \d+ QA-passed review/ }).click();
  await flash(/Published \d+ review/);
  await page.goto("/admin/qa?status=PUBLISHED");
  await expect(page.getByRole("row").filter({ hasText: "Published" }).or(page.getByRole("row").filter({ hasText: "PUBLISHED" })).first()).toBeVisible();
});

test("9. public review page", async () => {
  await page.goto("/category/laptops");
  await page.locator('a[href^="/review/"]', { hasText: /MacBook Air 13/ }).first().click();
  await page.waitForURL(/\/review\//);
  state.macbookSlug = page.url().split("/review/")[1];
  await expect(page.getByRole("heading", { level: 1 })).toContainText("MacBook Air");
  // No commerce data: the honest state, never a stale or invented price.
  expect((await page.locator("body").innerText()).match(FORBIDDEN_PUBLIC_TOKENS)?.[0], "forbidden token on the review page").toBeUndefined();
  await expect(page.locator("#deal")).toContainText(NO_VERIFIED_PRICE);
  await expect(page.locator("#deal")).toContainText("we earn nothing");
  await expect(page.getByRole("link", { name: /View deal/ })).toHaveCount(0);
  await expect(page.locator(".sticky-offer")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Laptops");
  const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
  const types = ld.map((t) => JSON.parse(t)["@type"]);
  expect(types).toEqual(expect.arrayContaining(["BreadcrumbList", "Article"]));
  // No Offer markup without a fresh price.
  expect(ld.join("")).not.toContain('"Offer"');
  const html = await page.content();
  expect(html).not.toMatch(/sovrn|viglink|vglnk/i);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", new RegExp(`/review/${state.macbookSlug}$`));
  // No internal verification data on the public page.
  await expect(page.locator("body")).not.toContainText(/VERIFIED_OK|redirect chain|score breakdown/i);

  // Every review without commerce data shows the same honest state.
  await page.goto("/category/ai-tools");
  await page.locator('a[href^="/review/"]', { hasText: /ChatGPT Plus/ }).first().click();
  await expect(page.locator("#deal")).toContainText(NO_VERIFIED_PRICE);
  await expect(page.locator("#deal .price")).toHaveCount(0);
  expect((await page.locator("body").innerText()).match(FORBIDDEN_PUBLIC_TOKENS)?.[0], "forbidden token on the review page").toBeUndefined();
});

test("10. category page with filters", async () => {
  await page.goto("/category/laptops");
  await expect(page.getByRole("heading", { level: 1, name: "Laptops" })).toBeVisible();
  expect(await page.locator("#results .review-card").count()).toBeGreaterThanOrEqual(3);
  await page.getByRole("navigation", { name: "Filter by type" }).getByRole("link", { name: "MacBooks" }).click();
  await expect(page).toHaveURL(/sub=macbooks/);
  await expect(page.locator("#results .review-card")).toHaveCount(1);
  // Brand facet comes from real published data.
  await page.goto("/category/laptops");
  await page.getByRole("navigation", { name: "Filter by brand" }).getByRole("link", { name: /Apple/ }).click();
  await expect(page).toHaveURL(/brand=apple/);
  await expect(page.locator("#results .review-card")).toHaveCount(1);
});

test("11. search", async () => {
  await page.goto("/");
  await page.getByRole("button", { name: "Search the site" }).click();
  const palette = page.getByRole("dialog", { name: "Search" });
  const box = palette.getByRole("combobox", { name: "Search reviews" });
  await box.fill("pixel");
  await expect(palette.getByRole("option").first()).toContainText("Pixel 10");
  await palette.getByRole("link", { name: /See all results for “pixel”/ }).click();
  await expect(page).toHaveURL(/\/search\?q=pixel/);
  await expect(page.getByText(/1 result for “pixel”/)).toBeVisible();
  await page.locator('a[href^="/review/"]', { hasText: /Pixel 10/ }).first().click();
  await page.waitForURL(/\/review\//);
  state.pixelSlug = page.url().split("/review/")[1];
});

test("12a. /deals without verified offers shows the empty state, never a fake card", async () => {
  await page.goto("/deals");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Deals");
  await expect(page.getByText(NO_VERIFIED_OFFER)).toBeVisible();
  await expect(page.locator(".deal-card")).toHaveCount(0);
  const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
  expect(ld.join("")).not.toContain('"Offer"');
  // "Deals" is in the public navigation.
  await page.goto("/");
  await expect(page.getByRole("navigation").getByRole("link", { name: "Deals", exact: true }).first()).toBeVisible();
});

test("12. /go redirects only to stored commerce offers", async () => {
  // Unknown offer ids never redirect off-site.
  const res = await page.request.get("/go/notarealidentifier1", { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  expect(res.headers().location).toMatch(/^http:\/\/localhost:\d+\/$/);
});

test("13. analytics records events and CTR", async () => {
  await page.goto("/admin/analytics");
  const stat = (label: string) => page.locator(".stat").filter({ has: page.locator(".stat-label", { hasText: new RegExp(`^${label}$`) }) }).locator(".stat-value");
  await expect(stat("page_view")).not.toHaveText("0");
  await expect(stat("search")).not.toHaveText("0");
  await expect(stat("publish")).not.toHaveText("0");
});

test("14. reject removes the page from the public site", async () => {
  await page.goto("/admin/qa?status=PUBLISHED&q=Pixel");
  await page.getByRole("row").filter({ hasText: "Pixel 10" }).getByRole("button", { name: "Reject" }).click();
  await flash("Review rejected");
  const res = await page.goto(`/review/${state.pixelSlug}`);
  expect(res?.status()).toBe(404);
  const sitemap = await (await page.request.get("/sitemap.xml")).text();
  expect(sitemap).not.toContain(`/review/${state.pixelSlug}<`);
  expect(sitemap).toContain(`/review/${state.macbookSlug}<`);
});

test("15. restore brings it back to the QA queue", async () => {
  await page.goto("/admin/qa?status=REJECTED");
  await page.getByRole("row").filter({ hasText: "Pixel 10" }).getByRole("button", { name: "Restore" }).click();
  await flash(/restored/);
  await page.goto("/admin/qa?status=QUEUED&q=Pixel");
  await expect(page.getByRole("row").filter({ hasText: "Pixel 10" })).toBeVisible();
});

test("16. unpublish", async () => {
  await page.goto("/admin/qa?status=PUBLISHED&q=MacBook");
  await page.getByRole("row").filter({ hasText: "MacBook Air" }).getByRole("button", { name: "Unpublish" }).click();
  await flash("Review unpublished");
  const res = await page.goto(`/review/${state.macbookSlug}`);
  expect(res?.status()).toBe(404);
});

test("security: cron, health, robots and admin API protection", async ({ request }) => {
  expect((await request.get("/api/cron/cleanup-cache")).status()).toBe(401);
  expect((await request.get("/api/cron/cleanup-cache", { headers: { authorization: "Bearer e2e-cron-secret" } })).status()).toBe(200);
  // Retired Sovrn jobs are gone.
  expect((await request.get("/api/cron/verify-links", { headers: { authorization: "Bearer e2e-cron-secret" } })).status()).toBe(404);
  const health = await (await request.get("/api/health")).json();
  expect(health).toMatchObject({ status: "ok", database: "ok" });
  expect(JSON.stringify(health)).not.toMatch(/postgres:|password/);
  expect(await (await request.get("/robots.txt")).text()).toMatch(/Sitemap: http:\/\/localhost:\d+\/sitemap\.xml/);
  expect((await request.post("/api/admin/reviews", { form: { id: "x", action: "publish" }, headers: { origin: "https://evil.example" } })).status()).toBe(403);
  expect((await request.post("/api/admin/reviews", { form: { id: "x", action: "publish" }, headers: { accept: "application/json", origin: `http://localhost:${process.env.E2E_PORT ?? 3100}` }, maxRedirects: 0 })).status()).toBe(401);
  const legacy = await request.get("/reviews/some-review", { maxRedirects: 0 });
  expect(legacy.status()).toBe(308);
  expect(legacy.headers().location).toBe("/review/some-review");
  const headers = (await request.get("/")).headers();
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
});

test("no dead links and no dead buttons", async () => {
  const pages = ["/", "/reviews", "/guides", "/match", "/match?category=laptops", "/deals", "/terms", "/contact", "/category/laptops", "/category/phones", `/search?q=laptop`, "/compare", "/about", "/disclosure", "/privacy", "/admin", "/admin/reviews", "/admin/entities", "/admin/qa", "/admin/ingestion", "/admin/categorization", "/admin/deals", "/admin/links", "/admin/images", "/admin/csv", "/admin/analytics", "/admin/sponsored", "/admin/reports", "/admin/jobs", "/admin/failures", "/admin/audit", "/admin/gsc", "/admin/go-live", "/admin/sources", "/admin/coverage", "/admin/automation"];
  const hrefs = new Set<string>();
  for (const p of pages) {
    const res = await page.goto(p);
    expect(res?.status(), p).toBeLessThan(400);
    // Public pages never show a placeholder for missing data ("null", "undefined", "NaN", "N/A", "$0").
    if (!p.startsWith("/admin")) {
      const visible = await page.locator("body").innerText();
      expect(visible.match(FORBIDDEN_PUBLIC_TOKENS)?.[0], `forbidden token on ${p}`).toBeUndefined();
    }
    for (const h of await page.locator("a[href]").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href))) {
      const u = new URL(h);
      if (u.origin === new URL(page.url()).origin && !u.pathname.startsWith("/go/") && !u.pathname.startsWith("/api/admin/reports/")) hrefs.add(u.pathname + u.search);
    }
    // Every visible button submits a form with an action, is a client action, or is disabled with a reason.
    const dead = await page.locator("button").evaluateAll((bs) =>
      bs
        .filter((b) => {
          const btn = b as HTMLButtonElement;
          if (btn.disabled) return !btn.title;
          if (btn.type === "submit") return !(btn.form && btn.form.getAttribute("action") !== null);
          return false;
        })
        .map((b) => b.textContent?.trim()),
    );
    expect(dead, `dead buttons on ${p}`).toEqual([]);
  }
  for (const h of hrefs) {
    const res = await page.request.get(h, { maxRedirects: 3 });
    expect(res.status(), h).toBeLessThan(400);
  }
});

test("every category route returns 200; empty ones stay noindex and out of the sitemap", async ({ request }) => {
  const sitemap = await (await request.get("/sitemap.xml")).text();
  for (const c of CATEGORIES) {
    const res = await request.get(`/category/${c.slug}`);
    expect(res.status(), c.slug).toBe(200);
    const html = await res.text();
    const empty = /No reviews are published here yet/.test(html);
    if (empty) {
      expect(html, `${c.slug} noindex`).toMatch(/<meta name="robots" content="noindex/);
      expect(sitemap.includes(`/category/${c.slug}<`), `${c.slug} not in sitemap`).toBe(false);
    }
  }
  expect((await request.get("/category/accessories?sub=monitors")).status()).toBe(200);
  expect((await request.get("/category/not-a-category")).status()).toBe(404);
});

test("mobile layout has no horizontal overflow", async ({ browser }) => {
  const mobile = await browser.newPage({ viewport: { width: 375, height: 800 } });
  for (const p of ["/", "/reviews", "/guides", "/match?category=laptops", "/deals", "/category/laptops", "/compare", "/about"]) {
    await mobile.goto(p);
    const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, p).toBeLessThanOrEqual(1);
  }
  await mobile.close();
  // Admin tables collapse into stacked cards on phones (signed-in page).
  await page.setViewportSize({ width: 375, height: 800 });
  for (const p of ["/admin/qa?status=PUBLISHED", "/admin/links", "/admin/ingestion"]) {
    await page.goto(p);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, p).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
});

test("accessibility: no serious or critical axe violations", async () => {
  const review = await page.request.get("/sitemap.xml").then((r) => r.text()).then((x) => x.match(/<loc>[^<]*(\/review\/[^<]+)<\/loc>/)?.[1]);
  const targets = ["/", "/reviews", "/guides", "/match", "/match?category=laptops", "/deals", "/terms", "/contact", "/category/laptops", review ?? "/", "/search?q=laptop", "/compare", "/admin", "/admin/qa", "/admin/csv", "/admin/links", `/admin/reviews/${state.gearId}`, "/admin/sponsored"];
  for (const p of targets) {
    await page.goto(p);
    // Audit the settled state a reader sees: finish scroll reveals before scanning.
    await page.evaluate(() => document.querySelectorAll(".reveal").forEach((e) => e.classList.add("in")));
    await page.waitForTimeout(900);
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    const serious = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
    expect(serious, `${p}: ${serious.join("; ")}`).toEqual([]);
  }
});

test("product hubs, content-type filters and typo suggestions", async () => {
  // Product hub built from content ↔ product links.
  await page.goto("/product/sony-wh-1000xm6");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sony WH-1000XM6");
  await expect(page.locator('a[href^="/review/sony-wh-1000xm6"]').first()).toBeVisible();
  expect((await page.locator("body").innerText()).match(FORBIDDEN_PUBLIC_TOKENS)?.[0], "forbidden token on the product hub").toBeUndefined();
  // The type filter changes the database query, and an empty type says so honestly.
  await page.goto("/reviews?type=comparison");
  await expect(page.getByText("Nothing of this type has been published yet.")).toBeVisible();
  await page.goto("/reviews?type=review");
  expect(await page.locator(".review-card").count()).toBeGreaterThan(0);
  // Typo tolerance suggests a real published name.
  await page.goto("/search?q=sny");
  await expect(page.getByRole("link", { name: "Search for Sony" })).toBeVisible();
  // Product hubs with published content are in the sitemap.
  const sitemap = await page.request.get("/sitemap.xml").then((r) => r.text());
  expect(sitemap).toContain("/product/sony-wh-1000xm6");
});

test("search suggestions support keyboard navigation", async () => {
  await page.goto("/reviews");
  // ⌘K / Ctrl+K opens the site-wide search palette.
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Search" });
  const box = palette.getByRole("combobox", { name: "Search reviews" });
  await expect(box).toBeFocused();
  await box.fill("sony");
  const option = palette.getByRole("option", { name: /Sony WH-1000XM6/ }).first();
  await expect(option).toBeVisible();
  await box.press("ArrowDown");
  await box.press("ArrowUp");
  await expect(option).toHaveAttribute("aria-selected", "true");
  await expect(box).toHaveAttribute("aria-activedescendant", /.+/);
  await box.press("Enter");
  await page.waitForURL(/\/review\/sony/);
  await page.getByRole("button", { name: "Search the site" }).click();
  await box.fill("zzzz-nothing");
  await expect(palette.getByText(/No reviews match/)).toBeVisible();
  await box.press("Escape");
  await expect(palette).toBeHidden();
  // Recent searches are remembered in this browser.
  await page.getByRole("button", { name: "Search the site" }).click();
  await expect(palette.getByText("Recent searches")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("mobile drawer is an accessible dialog", async ({ browser }) => {
  const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await m.goto("/");
  await m.getByRole("button", { name: "Open menu" }).click();
  const dialog = m.getByRole("dialog", { name: "Menu" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Laptops" })).toBeVisible();
  await m.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await m.getByRole("button", { name: "Open menu" }).click();
  await m.getByRole("dialog", { name: "Menu" }).getByRole("link", { name: "Reviews" }).click();
  await m.waitForURL(/\/reviews$/);
  await expect(m.getByRole("dialog", { name: "Menu" })).toBeHidden();
  await m.close();
});

test("mega menu shows real category data", async () => {
  await page.goto("/");
  await page.getByRole("button", { name: "Categories" }).click();
  const mega = page.locator("#mega-categories");
  await expect(mega.getByRole("heading", { name: "Laptops" })).toBeVisible();
  await expect(mega.locator(".mega-feature a").first()).toBeVisible();
  await mega.getByRole("button", { name: "AI Tools" }).hover();
  await expect(mega.getByRole("heading", { name: "AI Tools" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(mega).toBeHidden();
});

test("find my match walks the real taxonomy", async () => {
  await page.goto("/match");
  await page.locator(".option-grid").getByRole("link", { name: /^Laptops/ }).click();
  await expect(page.getByRole("heading", { name: "What matters most?" })).toBeVisible();
  await page.getByRole("link", { name: /No preference/ }).click();
  await page.locator(".option-grid").getByRole("link", { name: /^Windows/ }).click();
  await page.getByRole("link", { name: /No preference/ }).click();
  await expect(page.getByRole("heading", { name: /Your matches in laptops/ })).toBeVisible();
  expect(await page.locator(".review-card").count()).toBeGreaterThanOrEqual(1);
});

test("hero: editorial statement, real collage, motion respects reduced motion", async ({ browser }) => {
  const full = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await full.goto("/");
  await expect(full.getByRole("heading", { level: 1 })).toHaveText(/Buy less\.\s+Buy right\./i);
  const collage = full.getByRole("complementary", { name: "On the cutting table" });
  await expect(collage).toBeVisible();
  // Clippings are real records: the latest review links to its page; with no fresh prices the deal clip says so.
  await expect(collage.locator('a.clip.photo[href^="/review/"]')).toHaveCount(1);
  await expect(collage.locator(".clip.deal")).toContainText("No current prices yet");
  await expect(full.getByRole("region", { name: "Running now" })).toBeVisible();
  await full.close();
  const reduced = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  await reduced.goto("/");
  await expect(reduced.locator(".cursor")).toBeHidden();
  const before = await reduced.locator(".ticker-track").evaluate((el) => el.scrollLeft);
  await reduced.waitForTimeout(800);
  expect(await reduced.locator(".ticker-track").evaluate((el) => el.scrollLeft)).toBe(before);
  await reduced.close();
});

test("visual QA screenshots at ten viewports", async ({ browser }, info) => {
  const review = await page.request.get("/sitemap.xml").then((r) => r.text()).then((x) => x.match(/<loc>[^<]*(\/review\/[^<]+)<\/loc>/)?.[1] ?? "/");
  const sizes: Array<[string, number, number]> = [["fhd", 1920, 1080], ["wide", 1600, 900], ["xl", 1440, 900], ["desktop", 1280, 800], ["laptop", 1024, 768], ["tablet", 768, 1024], ["large-phone", 430, 932], ["mobile", 390, 844], ["phone", 375, 812], ["small", 320, 700]];
  for (const [name, width, height] of sizes) {
    const v = await browser.newPage({ viewport: { width, height } });
    for (const [label, path] of [["home", "/"], ["review", review], ["category", "/category/laptops"], ["compare", "/compare"], ["deals", "/deals"], ["match", "/match"], ["guides", "/guides"], ["search", "/search?q=laptop"], ["about", "/about"]] as const) {
      await v.goto(path);
      const overflow = await v.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${label}@${name}`).toBeLessThanOrEqual(1);
      await info.attach(`${label}-${name}`, { body: await v.screenshot(), contentType: "image/png" });
    }
    await v.close();
  }
});

test("go-live checks run read-only probes and report honestly", async () => {
  await page.goto("/admin/go-live");
  await page.getByLabel("Product to test offers and images with").fill("Pixel 10");
  await page.getByRole("button", { name: "Run checks" }).click();
  await expect(page.getByRole("heading", { name: /Last run/ })).toBeVisible();
  const row = (name: string) => page.getByRole("row").filter({ has: page.getByRole("cell", { name, exact: true }) });
  await expect(row("contentApi")).toContainText("OK");
  await expect(row("affiliateProvider")).toContainText("OK");
  await expect(row("sovrn")).toHaveCount(0);
  await expect(row("database")).toContainText("OK");
  // The test-only loopback flag is flagged, and unconfigured GSC is blocked, not "failed".
  await expect(row("environment")).toContainText("UNSAFE_ALLOW_LOOPBACK_FOR_TESTS");
  await expect(row("gsc")).toContainText("BLOCKED_BY_ENVIRONMENT");
  await expect(page.locator("body")).not.toContainText(/test-ktb-key|e2e-cron-secret/);
});

test("review sources: add, enable, robots-checked crawl, collect job (sample stub)", async ({ request }) => {
  await page.goto("/admin/sources");
  await page.getByLabel("Name").fill("Example Reviews");
  await page.getByLabel("Slug").fill("example");
  await page.getByLabel("Homepage").fill("https://reviews.example.test");
  await page.getByLabel("Allowed domains").fill("example.test");
  await page.getByLabel("Start (listing) URLs, one per line").fill("https://reviews.example.test/reviews");
  await page.getByLabel("Review URL patterns, one per line").fill("https://reviews.example.test/reviews/**");
  await page.getByRole("button", { name: "Add source" }).click();
  await flash(/added \(disabled\)/);
  const row = page.getByRole("row").filter({ hasText: "Example Reviews" });
  await expect(row).toContainText("DISABLED");
  await expect(row).toContainText("Excerpt only");
  await row.getByRole("button", { name: "Enable" }).click();
  await flash(/enabled/);
  await page.getByRole("row").filter({ hasText: "Example Reviews" }).getByRole("button", { name: "Run now" }).click();
  // The sample domain's robots.txt can't be reached from the test sandbox, so the crawl is refused
  // rather than started blind. (The successful crawl → collect path is covered in tests/integration/apify.test.ts.)
  await expect(page.getByRole("alert").filter({ hasText: /ROBOTS_DISALLOWED: robots\.txt could not be read/ })).toBeVisible();
  const collect = await request.get("/api/cron/collect-scrapes", { headers: { authorization: "Bearer e2e-cron-secret" } });
  expect(collect.status()).toBe(200);
  expect(await collect.json()).toMatchObject({ results: { "collect-scrapes": { collected: 0 } } });
});

test("AI guide: generate publishes directly, without an AI label (owner's rule), never as a review", async () => {
  await page.goto("/admin/guides");
  await page.getByLabel("Product name").fill("Dell XPS 14");
  await page.getByLabel("Brand (optional)").fill("Dell");
  await page.getByLabel("Keywords").fill("dell xps 14, creator laptop");
  await page.getByRole("button", { name: "Generate and publish" }).click();
  await flash(/Generated and published/);
  const link = page.getByRole("link", { name: "View public page" });
  const href = await link.getAttribute("href");
  await page.goto(href!);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText(/AI-assisted/)).toHaveCount(0);
  await expect(page.getByText("Made4Buyers").first()).toBeVisible();
  const ld = (await page.locator('script[type="application/ld+json"]').allTextContents()).map((t) => JSON.parse(t)["@type"]);
  expect(ld).not.toContain("Review");
  expect(ld).toContain("Article");
});
