import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * End-to-end: admin login → ingestion → QA queue → edit → CSV import → deal matching →
 * revalidation → publish → public review/category/search pages → affiliate click →
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

test("3. QA queue shows gates and blocks low-confidence items", async () => {
  await page.goto("/admin/qa");
  const gear = page.getByRole("row").filter({ hasText: "Our favourite gear" });
  await expect(gear).toContainText("ENTITIES_NEED_REVIEW");
  await expect(gear.getByRole("button", { name: /^Publish/ })).toBeDisabled();
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

test("6. deal matching is visible to admins", async () => {
  await page.goto("/admin/deals");
  const mba = page.getByRole("row").filter({ hasText: "MacBook Air 13 (M4)" });
  await expect(mba).toContainText("MATCHED");
  await expect(mba).toContainText("VERIFIED_OK");
  await expect(page.getByRole("row").filter({ hasText: "ChatGPT Plus" })).toContainText("NO_MATCH");
});

test("7. revalidation by date range", async () => {
  await page.goto("/admin/links");
  await page.getByRole("button", { name: "Run revalidation" }).click();
  await flash(/Revalidation \(links\) checked \d+: \d+ ok, \d+ failed/);
  await expect(page.getByRole("row").filter({ hasText: "LINK_VERIFICATION" }).first()).toBeVisible();
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
  await page.getByRole("link", { name: /MacBook Air 13/ }).first().click();
  await page.waitForURL(/\/review\//);
  state.macbookSlug = page.url().split("/review/")[1];
  await expect(page.getByRole("heading", { level: 1 })).toContainText("MacBook Air");
  await expect(page.getByRole("heading", { name: "Current deal" })).toBeVisible();
  await expect(page.getByRole("link", { name: /View deal/ })).toBeVisible();
  await expect(page.getByText(/may earn a commission/)).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Laptops");
  const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
  const types = ld.map((t) => JSON.parse(t)["@type"]);
  expect(types).toEqual(expect.arrayContaining(["BreadcrumbList", "Article", "Product"]));
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", new RegExp(`/review/${state.macbookSlug}$`));
  // No internal verification data on the public page.
  await expect(page.locator("body")).not.toContainText(/VERIFIED_OK|redirect chain|score breakdown/i);

  // A review without a verified offer shows the honest unavailable state.
  await page.goto("/category/ai-tools");
  await page.getByRole("link", { name: /ChatGPT Plus/ }).first().click();
  await expect(page.getByText(/We don’t have a verified offer for this product right now/)).toBeVisible();
});

test("10. category page with filters", async () => {
  await page.goto("/category/laptops");
  await expect(page.getByRole("heading", { level: 1, name: "Laptops" })).toBeVisible();
  expect(await page.locator("article.card").count()).toBeGreaterThanOrEqual(3);
  await page.getByRole("navigation", { name: "Filter by type" }).getByRole("link", { name: "MacBooks" }).click();
  await expect(page).toHaveURL(/sub=macbooks/);
  await expect(page.locator("article.card")).toHaveCount(1);
});

test("11. search", async () => {
  await page.goto("/");
  await page.getByRole("searchbox", { name: "Search reviews" }).fill("pixel");
  await page.getByRole("searchbox", { name: "Search reviews" }).press("Enter");
  await expect(page).toHaveURL(/\/search\?q=pixel/);
  await expect(page.getByText(/1 result for “pixel”/)).toBeVisible();
  await page.getByRole("link", { name: /Pixel 10/ }).first().click();
  await page.waitForURL(/\/review\//);
  state.pixelSlug = page.url().split("/review/")[1];
});

test("12. affiliate click goes through the verified redirect", async () => {
  await page.goto(`/review/${state.macbookSlug}`);
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.getByRole("link", { name: /View deal/ }).click()]);
  await popup.waitForLoadState();
  expect(popup.url()).toMatch(/127\.0\.0\.1:4011\/merchant\//);
  await popup.close();
  // Unknown or unverified link ids never redirect off-site.
  const res = await page.request.get("/go/notarealidentifier1", { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  expect(res.headers().location).toMatch(/^http:\/\/localhost:\d+\/$/);
});

test("13. analytics records events and CTR", async () => {
  await page.goto("/admin/analytics");
  const stat = (label: string) => page.locator(".stat").filter({ has: page.locator(".stat-label", { hasText: new RegExp(`^${label}$`) }) }).locator(".stat-value");
  await expect(stat("affiliate_click")).not.toHaveText("0");
  await expect(stat("page_view")).not.toHaveText("0");
  await expect(stat("deal_impression")).not.toHaveText("0");
  await expect(stat("search")).not.toHaveText("0");
  await expect(stat("publish")).not.toHaveText("0");
  await expect(page.getByRole("row").filter({ hasText: "Laptops" })).toContainText("SUFFICIENT");
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
  expect((await request.get("/api/cron/verify-links")).status()).toBe(401);
  expect((await request.get("/api/cron/verify-links", { headers: { authorization: "Bearer e2e-cron-secret" } })).status()).toBe(200);
  const health = await (await request.get("/api/health")).json();
  expect(health).toMatchObject({ status: "ok", database: "ok" });
  expect(JSON.stringify(health)).not.toMatch(/postgres:|e2e-sovrn|password/);
  expect(await (await request.get("/robots.txt")).text()).toMatch(/Sitemap: http:\/\/localhost:\d+\/sitemap\.xml/);
  expect((await request.post("/api/admin/reviews", { form: { id: "x", action: "publish" }, headers: { origin: "https://evil.example" } })).status()).toBe(403);
  expect((await request.post("/api/admin/reviews", { form: { id: "x", action: "publish" }, headers: { accept: "application/json", origin: "http://localhost:3100" }, maxRedirects: 0 })).status()).toBe(401);
  const legacy = await request.get("/reviews/some-review", { maxRedirects: 0 });
  expect(legacy.status()).toBe(308);
  expect(legacy.headers().location).toBe("/review/some-review");
  const headers = (await request.get("/")).headers();
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
});

test("no dead links and no dead buttons", async () => {
  const pages = ["/", "/category/laptops", "/category/phones", `/search?q=laptop`, "/compare", "/about", "/disclosure", "/privacy", "/admin", "/admin/qa", "/admin/ingestion", "/admin/categorization", "/admin/deals", "/admin/links", "/admin/images", "/admin/csv", "/admin/analytics", "/admin/sponsored", "/admin/reports", "/admin/jobs", "/admin/failures", "/admin/audit", "/admin/gsc"];
  const hrefs = new Set<string>();
  for (const p of pages) {
    const res = await page.goto(p);
    expect(res?.status(), p).toBeLessThan(400);
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

test("mobile layout has no horizontal overflow", async ({ browser }) => {
  const mobile = await browser.newPage({ viewport: { width: 375, height: 800 } });
  for (const p of ["/", "/category/laptops", "/about"]) {
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
  const targets = ["/", "/category/laptops", review ?? "/", "/search?q=laptop", "/compare", "/admin", "/admin/qa", "/admin/csv", "/admin/links", `/admin/reviews/${state.gearId}`, "/admin/sponsored"];
  for (const p of targets) {
    await page.goto(p);
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    const serious = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
    expect(serious, p).toEqual([]);
  }
});
