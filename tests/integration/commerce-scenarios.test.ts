import dns from "node:dns";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ReactElement } from "react";
import { prerender } from "react-dom/static";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { markExpiredCoupons } from "@/lib/commerce/coupons";
import { collectCouponRuns, commerceSpendThisMonth, runCouponCrawl } from "@/lib/commerce/coupons-run";
import { HIDDEN_LINK_STATUSES, runLinkValidation } from "@/lib/commerce/link-check";
import { collectCommerceRuns, commerceBudget, runCommerceCollect, startProductRun } from "@/lib/commerce/pipeline";
import { runIngestion } from "@/lib/pipeline/ingest";
import { persistPageRenderModel } from "@/lib/pipeline/render-model";
import { runProductEnrichment } from "@/lib/jobs/revalidation";
import { FORBIDDEN_PUBLIC_TOKENS, NO_VERIFIED_OFFER, NO_VERIFIED_PRICE } from "@/lib/public/display";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

/**
 * Owner scenarios, end to end: the real commerce pipeline (start → collect → match → offers/facts,
 * coupon crawl → verify, link checks, staleness) against a local Apify stand-in and a local
 * "official brand site", then what /deals (DealsPage) and the review page actually render.
 *
 * The brand site is frame.work, resolved to the local stub for this test process only (the SSRF-safe
 * client still does every check; only DNS is redirected), so links stay real public-looking URLs
 * that the public display rules accept. All data here is SAMPLE data.
 */

// Pages run outside Next here: the data cache is a pass-through and there is no router.
vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn, revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  usePathname: () => "/",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
}));
// Sitemap discovery is a separate, network-bound step (covered by tests/unit/commerce-discovery.test.ts):
// here it returns the URLs a test sets, so commerce-discover drives the real start/budget logic.
const discovered: { urls: string[] } = { urls: [] };
vi.mock("@/lib/commerce/discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/commerce/discovery")>()),
  discoverProductUrls: async () => ({ status: "OK", urls: [...discovered.urls] }),
}));

const { default: ReviewPage } = await import("@/app/review/[slug]/page");
const { default: DealsPage } = await import("@/app/deals/page");
const { JOBS } = await import("@/lib/jobs/registry");

const HOUR = 3_600_000;
const BRAND_HOST = "frame.work";

// ── Local Apify API + official brand site ─────────────────────────────────

type RunState = { status: string; items: unknown[]; statusMessage?: string };
const stub = {
  runs: new Map<string, RunState>(),
  posts: [] as Array<{ path: string; body: Record<string, unknown> }>,
  siteHits: [] as string[],
  /** Dataset of the next run started. */
  items: [] as unknown[],
  /** Status every new run reports when polled. */
  runStatus: "SUCCEEDED",
  /** When set, starting a run fails with this HTTP status. */
  startFails: 0,
  /** Brand-site paths that answer with something other than 200: [status, location?]. */
  site: new Map<string, [number, string?]>(),
};
let server: http.Server;
let port = 0;
let seq = 0;
let restoreEnv: () => void;

const site = () => `http://${BRAND_HOST}:${port}`;
const productUrl = (slug: string) => `${site()}/products/${slug}`;
const promoUrl = () => `${site()}/promotions`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://stub");
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname.startsWith("/v2/")) {
        if (req.headers.authorization !== "Bearer test-apify-token") return json(401, { error: { type: "token-not-valid" } });
        let m: RegExpExecArray | null;
        if (req.method === "POST" && /^\/v2\/acts\/[^/]+\/runs$/.test(url.pathname)) {
          stub.posts.push({ path: url.pathname, body: raw ? JSON.parse(raw) : {} });
          if (stub.startFails) return json(stub.startFails, { error: { type: "internal-server-error", message: "Apify is down" } });
          const id = `run-${++seq}`;
          stub.runs.set(id, { status: stub.runStatus, items: JSON.parse(JSON.stringify(stub.items)) });
          return json(201, { data: { id, status: "RUNNING", defaultDatasetId: `ds-${id}` } });
        }
        if ((m = /^\/v2\/actor-runs\/([^/]+)$/.exec(url.pathname))) {
          const r = stub.runs.get(m[1]);
          if (!r) return json(404, { error: { type: "record-not-found" } });
          return json(200, { data: { id: m[1], status: r.status, defaultDatasetId: `ds-${m[1]}`, finishedAt: r.status === "RUNNING" ? null : new Date().toISOString(), statusMessage: r.statusMessage ?? null, usageTotalUsd: 0.02 } });
        }
        if ((m = /^\/v2\/datasets\/ds-([^/]+)\/items$/.exec(url.pathname))) return json(200, stub.runs.get(m[1])?.items ?? []);
        return json(404, { error: { type: "not-found" } });
      }
      // The brand's official site.
      stub.siteHits.push(`${req.method} ${url.pathname}`);
      if (url.pathname === "/robots.txt") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end("User-agent: *\nDisallow: /account\n");
      }
      const override = stub.site.get(url.pathname);
      if (override) {
        res.writeHead(override[0], override[1] ? { Location: override[1] } : {});
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><title>ok</title>");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;

  // frame.work → the local stub (this process only); every other name resolves normally.
  const realLookup = dns.lookup.bind(dns) as (...args: unknown[]) => void;
  vi.spyOn(dns, "lookup").mockImplementation(((hostname: string, opts: unknown, cb?: unknown) => {
    const callback = (typeof opts === "function" ? opts : cb) as (err: Error | null, address: unknown, family?: number) => void;
    if (hostname.toLowerCase() === BRAND_HOST) {
      const all = typeof opts === "object" && opts !== null && (opts as { all?: boolean }).all;
      return all ? callback(null, [{ address: "127.0.0.1", family: 4 }]) : callback(null, "127.0.0.1", 4);
    }
    return realLookup(hostname, opts, cb);
  }) as unknown as typeof dns.lookup);

  await seedTaxonomy();
  restoreEnv = withEnv({
    APIFY_API_TOKEN: "test-apify-token",
    APIFY_API_BASE_URL: `http://127.0.0.1:${port}/v2`,
    COMMERCE_APIFY_ACTOR_ID: undefined,
    COMMERCE_MONTHLY_BUDGET_USD: undefined, // the $30 default
    COMMERCE_BRANDS_PER_RUN: undefined,
    COMMERCE_LINK_CHECK_DELAY_MS: "0",
    COMMERCE_COUPON_MAX_AGE_DAYS: undefined,
    PRODUCT_PRICE_MAX_AGE_HOURS: undefined, // 48 h
    CONTENT_API_URL: undefined,
    AUTO_PUBLISH_ENABLED: undefined,
    AFFILIATE_PROVIDER: undefined,
    SITE_URL: "https://www.made4buyers.com",
  });
});

afterAll(async () => {
  restoreEnv();
  vi.restoreAllMocks();
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  await resetDb();
  stub.runs.clear();
  stub.posts.length = 0;
  stub.siteHits.length = 0;
  stub.items = [];
  stub.runStatus = "SUCCEEDED";
  stub.startFails = 0;
  stub.site.clear();
  discovered.urls = [];
});

// ── Fixtures ──────────────────────────────────────────────────────────────

const body = "The Framework Laptop 13 is a repairable ultraportable with swappable ports, a bright 2.8K display and solid battery life. We tested it for two weeks of daily work and travel.";

/** A published review of "Framework Laptop 13" (creates the ProductEntity the pipeline matches against) and the brand. */
async function seedReviewAndBrand() {
  await runIngestion({ trigger: "test", source: "apify:example", items: [{ id: "fw13", title: "Framework Laptop 13 review", body, summary: "A repairable laptop that is easy to upgrade.", url: "https://reviews.example.test/reviews/fw13", productName: "Framework Laptop 13", brand: "Framework", category: "laptops", publishedAt: new Date(Date.now() - 86_400_000).toISOString() }] });
  const review = await db.normalizedReview.findFirstOrThrow({ where: { sourceId: "fw13" } });
  expect(review.status).toBe("PUBLISHED");
  const primary = await db.contentEntity.findFirstOrThrow({ where: { normalizedReviewId: review.id, role: "PRIMARY" } });
  const brand = await db.commerceBrand.create({ data: { name: "Framework", slug: "framework", officialDomain: BRAND_HOST, categories: ["laptops"], promoUrls: [promoUrl()], crawlFrequencyHours: 24, crawlWindowStartHour: null } });
  return { review, entityId: primary.productEntityId, brand };
}

type ProductOpts = { name?: string; sku?: string; price?: string | null; list?: { type: string; price: number } | null; offerUrl?: string; warranty?: string; offers?: unknown };

/** schema.org Product JSON-LD exactly as a brand page would state it. */
function productLd(url: string, o: ProductOpts = {}) {
  const offer: Record<string, unknown> = { "@type": "Offer", url: o.offerUrl ?? url, priceCurrency: "USD", availability: "https://schema.org/InStock", seller: { "@type": "Organization", name: "Framework" } };
  if (o.price !== null) offer.price = o.price ?? "999.00";
  if (o.list) offer.priceSpecification = [{ "@type": "UnitPriceSpecification", priceType: o.list.type, price: o.list.price, priceCurrency: "USD" }];
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: o.name ?? "Framework Laptop 13",
    brand: { "@type": "Brand", name: "Framework" },
    ...(o.sku ? { sku: o.sku } : {}),
    ...(o.warranty ? { additionalProperty: [{ "@type": "PropertyValue", name: "Warranty", value: o.warranty }] } : {}),
    ...(o.offers !== undefined ? (o.offers === null ? {} : { offers: o.offers }) : { offers: offer }),
  };
}

/** One dataset item as PRODUCT_PAGE_FUNCTION returns it. */
function pageItem(url: string, jsonLd: unknown[], title = "Framework Laptop 13") {
  return { m4bCommerce: 1, url, canonicalUrl: url, title: `${title} | Framework`, jsonLd, meta: {}, h1: title, breadcrumbs: [], specTables: [], images: [], lang: "en-US" };
}

/** One dataset item as COUPON_PAGE_FUNCTION returns it. */
const couponItem = (codes: Array<{ code: string; context: string }>) => ({ m4bCoupon: 1, url: promoUrl(), title: "Framework offers", candidates: codes.map((c) => ({ ...c, element: "p" })), jsonLd: [] });

/** Starts a product run for the brand with this dataset and collects it (as commerce-collect does). */
async function crawl(items: unknown[], now = new Date()) {
  const brand = await db.commerceBrand.findFirstOrThrow({ where: { slug: "framework" } });
  stub.items = items;
  const started = await startProductRun(brand, items.map((i) => (i as { url: string }).url), "test");
  expect(started.status).toBe("STARTED");
  const collected = await collectCommerceRuns("test", now);
  expect(collected.collected).toBe(1);
  return collected;
}

/** Runs the first-party coupon crawl and collects it. */
async function couponCrawl(codes: Array<{ code: string; context: string }>) {
  stub.items = [couponItem(codes)];
  expect(await runCouponCrawl("test")).toMatchObject({ status: "OK", started: 1 });
  expect(await collectCouponRuns("test")).toMatchObject({ collected: 1 });
}

// ── Rendering and global display checks ──────────────────────────────────

async function html(el: ReactElement | Promise<ReactElement>): Promise<string> {
  const { prelude } = await prerender(await el);
  return new Response(prelude).text();
}

function visibleText(markup: string): string {
  return markup
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function jsonLd(markup: string): unknown[] {
  return [...markup.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
}

function ldOffers(node: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(node)) for (const n of node) ldOffers(n, out);
  else if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (o["@type"] === "Offer" || o["@type"] === "AggregateOffer") out.push(o);
    for (const v of Object.values(o)) ldOffers(v, out);
  }
  return out;
}

/** Prices of offers that may be shown right now: FRESH, observed within 48 h, link not known bad, USD. */
async function freshPrices(): Promise<Set<number>> {
  const rows = await db.commerceOffer.findMany({ where: { status: "FRESH", observedAt: { gte: new Date(Date.now() - 48 * HOUR) }, linkStatus: { notIn: [...HIDDEN_LINK_STATUSES] }, currency: "USD", price: { gt: 0 } }, select: { price: true } });
  return new Set(rows.map((r) => r.price!));
}

const rendered: string[] = [];

/** Every page rendered by this suite: no forbidden tokens, and no Offer markup without a fresh price. */
async function checkPublic(markup: string) {
  rendered.push(markup);
  const text = visibleText(markup);
  expect(text).not.toMatch(FORBIDDEN_PUBLIC_TOKENS);
  expect(markup).not.toMatch(/href="#"|href=""/);
  const fresh = await freshPrices();
  for (const o of ldOffers(jsonLd(markup))) {
    expect(typeof o.price === "number" && o.price > 0).toBe(true);
    expect(o.priceCurrency).toBe("USD");
    expect(fresh.has(o.price as number)).toBe(true);
  }
  return text;
}

async function deals() {
  const markup = await html(DealsPage());
  return { markup, text: await checkPublic(markup) };
}
async function reviewPage(slug: string) {
  const markup = await html(ReviewPage({ params: Promise.resolve({ slug }) }));
  return { markup, text: await checkPublic(markup) };
}

/** Markup of one /deals section by its heading id ("drops-title", "codes-title", "prices-title"). */
function section(markup: string, headingId: string): string {
  const at = markup.indexOf(`id="${headingId}"`);
  if (at < 0) return "";
  const end = markup.indexOf("</section>", at);
  return markup.slice(at, end < 0 ? undefined : end);
}
const cards = (markup: string) => (markup.match(/class="(?:deal|coupon)-card[ "]/g) ?? []).length;
/** Row labels of the review page's "Key facts" table. */
function keyFactsRows(markup: string): string[] {
  const at = markup.indexOf('id="facts"');
  if (at < 0) return [];
  const table = markup.slice(at, markup.indexOf("</table>", at));
  return [...table.matchAll(/<th scope="row">([^<]+)<\/th>/g)].map((m) => m[1]);
}
/** Visible text of the review page's "Key facts" table. */
function keyFactsText(markup: string): string {
  const at = markup.indexOf('id="facts"');
  return at < 0 ? "" : visibleText(markup.slice(at, markup.indexOf("</table>", at)));
}

/** The designed empty state of /deals: no cards at all. */
function expectNoDeals(d: { markup: string; text: string }) {
  expect(d.text).toContain(NO_VERIFIED_OFFER);
  expect(cards(d.markup)).toBe(0);
  expect(d.markup).not.toContain('id="drops-title"');
  expect(d.markup).not.toContain('id="codes-title"');
  expect(JSON.stringify(jsonLd(d.markup))).not.toContain('"Offer"');
}

afterAll(() => {
  // Sanity: the global checks above actually ran on real pages.
  expect(rendered.length).toBeGreaterThan(10);
});

// ── Scenarios ─────────────────────────────────────────────────────────────

describe("owner scenarios: pipeline → /deals and review page", () => {
  it("1. Apify failure (HTTP 500 on start, run FAILED): recorded, brand backed off, public data unchanged, valid offer still shown", async () => {
    const { review, brand } = await seedReviewAndBrand();
    const url = productUrl("laptop13");
    await crawl([pageItem(url, [productLd(url, { price: "799.00", list: { type: "https://schema.org/ListPrice", price: 999 } })])]);
    const snapshot = async () => ({ offers: await db.commerceOffer.findMany({ orderBy: { id: "asc" } }), facts: await db.productFact.findMany({ orderBy: { id: "asc" } }), products: await db.commerceProduct.findMany({ orderBy: { id: "asc" } }) });
    const before = await snapshot();
    expect(before.offers).toHaveLength(1);

    // (a) Apify answers HTTP 500 when the scheduled discover pass starts the run.
    await db.commerceBrand.update({ where: { id: brand.id }, data: { nextCrawlAt: null } });
    discovered.urls = [url];
    stub.startFails = 500;
    const t0 = Date.now();
    const job = (await JOBS["commerce-discover"].run("test")) as { started: number; results: Array<{ status: string; reason?: string }> };
    expect(job.started).toBe(0);
    expect(job.results[0]).toMatchObject({ status: "FAILED" });
    expect(job.results[0].reason).toMatch(/HTTP 500/);
    const failedStart = await db.commerceRun.findFirstOrThrow({ where: { brandId: brand.id, status: "FAILED" } });
    expect(failedStart).toMatchObject({ purpose: "PRODUCT", apifyRunId: null });
    expect(JSON.stringify(failedStart.errors)).toContain("APIFY_RUN_FAILED");
    let b = await db.commerceBrand.findUniqueOrThrow({ where: { id: brand.id } });
    expect(b).toMatchObject({ crawlStatus: "APIFY_RUN_FAILED", consecutiveFailures: 1 });
    expect(b.nextCrawlAt!.getTime()).toBeGreaterThanOrEqual(t0 + 2 * HOUR - 5_000);
    expect(b.nextCrawlAt!.getTime()).toBeLessThanOrEqual(Date.now() + 2 * HOUR);
    expect(await db.auditLog.count({ where: { action: "APIFY_RUN_FAILED" } })).toBe(1);
    // Backed off: the next discover pass does not start anything for this brand.
    stub.startFails = 0;
    expect(await JOBS["commerce-discover"].run("test")).toMatchObject({ brands: 0, started: 0 });

    // (b) The run starts but Apify reports it FAILED.
    stub.runStatus = "FAILED";
    const started = await startProductRun(b, [url], "test");
    expect(started.status).toBe("STARTED");
    stub.runs.get(started.apifyRunId!)!.statusMessage = "crawler crashed";
    const now = new Date();
    const collected = await collectCommerceRuns("test", now);
    expect(collected.results[0]).toMatchObject({ status: "FAILED", reason: "crawler crashed" });
    b = await db.commerceBrand.findUniqueOrThrow({ where: { id: brand.id } });
    expect(b).toMatchObject({ crawlStatus: "FAILED", consecutiveFailures: 2 });
    expect(b.lastError).toContain("crawler crashed");
    expect(b.nextCrawlAt!.getTime() - now.getTime()).toBe(4 * HOUR);

    // Nothing public changed, and the existing valid offer is still shown.
    expect(await snapshot()).toEqual(before);
    const d = await deals();
    expect(visibleText(section(d.markup, "drops-title"))).toContain("You save $200.00 (20%)");
    expect(cards(section(d.markup, "drops-title"))).toBe(1);
    const r = await reviewPage(review.slug);
    expect(r.text).toContain("$799.00 at Framework");
    expect(r.text).not.toContain(NO_VERIFIED_PRICE);
  });

  it("2. budget exhausted ($30 spent this month): discover and coupon crawl start nothing and record why; they resume in a new month", async () => {
    const { brand } = await seedReviewAndBrand();
    await db.commerceRun.create({ data: { purpose: "PRODUCT", brandId: brand.id, actorId: "x", trigger: "test", status: "COLLECTED", usageUsd: 20 } });
    await db.commerceRun.create({ data: { purpose: "COUPON", brandId: brand.id, actorId: "x", trigger: "test", status: "COLLECTED", usageUsd: 10.01 } });
    expect(await commerceBudget()).toMatchObject({ budgetUsd: 30, exhausted: true });
    discovered.urls = [productUrl("laptop13")];

    const job = (await JOBS["commerce-discover"].run("test")) as { status: string; started: number; reason?: string };
    expect(job).toMatchObject({ status: "SKIPPED", started: 0 });
    expect(job.reason).toMatch(/budget exhausted/);
    const skipped = await db.commerceRun.findFirstOrThrow({ where: { brandId: brand.id, status: "SKIPPED" } });
    expect(skipped).toMatchObject({ purpose: "PRODUCT", apifyRunId: null, startUrls: 1 });
    expect(JSON.stringify(skipped.errors)).toContain("BUDGET_EXHAUSTED");
    expect(await runCouponCrawl("test")).toMatchObject({ status: "BUDGET_EXHAUSTED", started: 0 });
    expect(stub.posts).toHaveLength(0);
    // The scheduler records the coupon job as not having run.
    const { jobOutcome } = await import("@/lib/jobs/registry");
    expect(jobOutcome(await JOBS["commerce-coupons"].run("test")).ran).toBe(false);
    expect(await db.commerceOffer.count()).toBe(0);
    expectNoDeals(await deals());

    // The window is the calendar month (UTC): next month the same spend no longer counts.
    const now = new Date();
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 30));
    expect(await commerceBudget(nextMonth)).toMatchObject({ spentUsd: 0, exhausted: false });
    expect(await commerceSpendThisMonth(nextMonth)).toBe(0);
    // Month change: last month's runs fall out of the window and both crawls start again.
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    await db.commerceRun.updateMany({ data: { startedAt: lastMonth } });
    expect(await commerceBudget()).toMatchObject({ exhausted: false });
    await db.commerceBrand.update({ where: { id: brand.id }, data: { nextCrawlAt: null } });
    stub.runStatus = "RUNNING";
    expect(await JOBS["commerce-discover"].run("test")).toMatchObject({ status: "OK", started: 1 });
    expect(await runCouponCrawl("test")).toMatchObject({ status: "OK", started: 1 });
    expect(stub.posts).toHaveLength(2);
  });

  it("3. duplicate offers (same page with utm/gclid, crawled again): one offer row, one public card", async () => {
    const { review } = await seedReviewAndBrand();
    const url = productUrl("laptop13");
    const ld = (offerUrl: string) => [productLd(url, { offerUrl, price: "799.00", list: { type: "https://schema.org/ListPrice", price: 999 } })];
    await crawl([pageItem(url, ld(`${url}?utm_source=newsletter&utm_medium=email#buy`))]);
    await crawl([pageItem(url, ld(`${url}?utm_source=newsletter&utm_medium=email#buy`))]); // identical second crawl
    await crawl([pageItem(url, ld(`${url}?gclid=abc123&utm_campaign=fall`))]);

    const offers = await db.commerceOffer.findMany();
    expect(offers).toHaveLength(1);
    expect(offers[0].destinationUrl).toBe(url);
    expect(await db.commerceProduct.count()).toBe(1);

    const d = await deals();
    expect(cards(section(d.markup, "drops-title"))).toBe(1);
    // "Recently verified" lists only prices with no stated previous price: the drop is not repeated there.
    expect(cards(section(d.markup, "prices-title"))).toBe(0);
    expect(d.markup).not.toMatch(/utm_|gclid/);
    const r = await reviewPage(review.slug);
    expect(r.markup.match(/class="offer-alt"/g) ?? []).toHaveLength(1);
    expect(r.markup.match(new RegExp(`/go/${offers[0].id}`, "g")) ?? []).toHaveLength(1);
  });

  it("4. expired coupon (stated expiry passed): EXPIRED and never shown", async () => {
    const { review } = await seedReviewAndBrand();
    const soon = new Date(Date.now() + 2 * 86_400_000);
    const soonText = soon.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    await couponCrawl([
      { code: "OLD15", context: "Use code OLD15 for 15% off laptops. Expires Jan 1, 2020." },
      { code: "WEEKEND5", context: `Use code WEEKEND5 for 5% off accessories. Offer ends ${soonText}.` },
    ]);
    expect(await db.commerceCoupon.findFirstOrThrow({ where: { code: "OLD15" } })).toMatchObject({ status: "EXPIRED" });
    expect(await db.commerceCoupon.findFirstOrThrow({ where: { code: "WEEKEND5" } })).toMatchObject({ status: "VERIFIED" });
    let d = await deals();
    expect(d.text).toContain("WEEKEND5");
    expect(d.text).not.toContain("OLD15");

    // WEEKEND5's stated end passes: the next collect expires it (row kept).
    expect(await markExpiredCoupons(new Date(soon.getTime() + 86_400_000))).toBe(1);
    expect(await db.commerceCoupon.findFirstOrThrow({ where: { code: "WEEKEND5" } })).toMatchObject({ status: "EXPIRED" });
    expect(await db.commerceCoupon.count()).toBe(2);
    d = await deals();
    expect(d.text).not.toMatch(/OLD15|WEEKEND5/);
    expectNoDeals(d);
    const r = await reviewPage(review.slug);
    expect(r.text).not.toMatch(/OLD15|WEEKEND5/);
  });

  it("5. broken URL (link check 404 / redirect to the home page): BROKEN, hidden from /deals and the review, row kept", async () => {
    const { review } = await seedReviewAndBrand();
    const reviewed = productUrl("laptop13");
    const unreviewed = productUrl("laptop16");
    await crawl([
      pageItem(reviewed, [productLd(reviewed, { price: "799.00", list: { type: "https://schema.org/ListPrice", price: 999 } })]),
      // Not reviewed on Made4Buyers, but an official page with an identifier: its own offer.
      pageItem(unreviewed, [productLd(unreviewed, { name: "Framework Laptop 16", sku: "FRAGAACX01", price: "1299.00", list: { type: "https://schema.org/ListPrice", price: 1449 } })], "Framework Laptop 16"),
    ]);
    let d = await deals();
    expect(cards(section(d.markup, "drops-title"))).toBe(2);
    expect((await reviewPage(review.slug)).text).toContain("$799.00 at Framework");

    stub.site.set("/products/laptop13", [404]);
    stub.site.set("/products/laptop16", [301, "/"]);
    const checked = await runLinkValidation("test");
    expect(checked).toMatchObject({ checked: 2, changed: 2 });
    expect(stub.siteHits).toContain("GET /robots.txt");
    const offers = await db.commerceOffer.findMany({ orderBy: { price: "asc" } });
    expect(offers).toHaveLength(2); // never deleted
    expect(offers.map((o) => o.linkStatus)).toEqual(["BROKEN", "BROKEN"]);
    expect(offers[0].linkHttpStatus).toBe(404);
    expect(await db.auditLog.count({ where: { action: "LINK_REJECTED" } })).toBe(2);

    d = await deals();
    expectNoDeals(d);
    expect(d.text).not.toMatch(/799|1,299/);
    const r = await reviewPage(review.slug);
    expect(r.text).toContain(NO_VERIFIED_PRICE);
    expect(r.text).not.toMatch(/\$799/);
    expect(r.markup).not.toContain("/products/laptop13");
  });

  it("6. stale price (observed more than 48 h ago): STALE and hidden everywhere", async () => {
    const { review } = await seedReviewAndBrand();
    const url = productUrl("laptop13");
    const observed = new Date(Date.now() - 49 * HOUR);
    await crawl([pageItem(url, [productLd(url, { price: "799.00", list: { type: "https://schema.org/ListPrice", price: 999 } })])], observed);
    // Even before the job marks it, a 49-hour-old observation is never shown.
    expectNoDeals(await deals());
    const collect = await runCommerceCollect("test");
    expect(collect.staleOffers).toBe(1);
    expect(await db.commerceOffer.findFirstOrThrow()).toMatchObject({ status: "STALE", price: 799 });

    expectNoDeals(await deals());
    const r = await reviewPage(review.slug);
    expect(r.text).toContain(NO_VERIFIED_PRICE);
    expect(r.markup.match(/class="offer-alt"/g) ?? []).toHaveLength(0);
    expect(r.text).not.toMatch(/\$799|\$999/);
    expect(JSON.stringify(jsonLd(r.markup))).not.toContain('"Offer"');
  });

  // KNOWN BUG (reported): "Key facts" shows the product's resolved price from the stored fact
  // summary without re-checking its age. A page rebuilt after the price went stale (image backfill,
  // republish, …) shows "Price $799.00" and a price tier from a 49-hour-old observation.
  // Remove `.fails` once lib/pipeline/render-model.ts productDataOf (or the review page) drops
  // HIGH-volatility facts older than PRODUCT_PRICE_MAX_AGE_HOURS.
  it("6b. a stale price never reaches the review's Key facts, even after a page rebuild", async () => {
    const { review } = await seedReviewAndBrand();
    const url = productUrl("laptop13");
    await crawl([pageItem(url, [productLd(url, { price: "799.00", list: { type: "https://schema.org/ListPrice", price: 999 } })])], new Date(Date.now() - 49 * HOUR));
    await runCommerceCollect("test");
    await persistPageRenderModel(review.id);
    const r = await reviewPage(review.slug);
    expect(keyFactsText(r.markup)).not.toMatch(/799/);
  });

  it("7. conflicting price/spec facts from two manufacturer pages: field value null, not displayed", async () => {
    const { review, entityId } = await seedReviewAndBrand();
    const a = productUrl("laptop13");
    const b = productUrl("laptop13-diy-edition");
    await crawl([pageItem(a, [productLd(a, { price: "999.00", warranty: "1 Year Limited Warranty" })])]);
    // A rebuild (as the enrichment job does) shows the undisputed manufacturer value with provenance.
    await persistPageRenderModel(review.id);
    let r = await reviewPage(review.slug);
    expect(keyFactsRows(r.markup)).toContain("Warranty");
    expect(r.text).toContain("1 Year Limited Warranty");

    // A second official page states a different warranty and price for the same product.
    await crawl([pageItem(b, [productLd(b, { price: "1099.00", warranty: "3 Year Limited Warranty" })])]);
    type Summary = { fields: Record<string, { status: string; value: unknown }> };
    const s = (await db.productEntity.findUniqueOrThrow({ where: { id: entityId } })).factSummary as Summary;
    expect(s.fields.warranty).toMatchObject({ status: "CONFLICTING", value: null });
    expect(s.fields.price).toMatchObject({ status: "CONFLICTING", value: null });
    expect(await db.auditLog.count({ where: { action: "SOURCE_CONFLICT" } })).toBe(1);

    // The page rebuilt from the resolved facts shows neither value (nor a price row).
    await persistPageRenderModel(review.id);
    r = await reviewPage(review.slug);
    expect(keyFactsRows(r.markup)).not.toContain("Warranty");
    expect(keyFactsRows(r.markup)).not.toContain("Price");
    expect(r.text).not.toMatch(/Year Limited Warranty/);
  });

  // KNOWN BUG (reported): commerce-collect re-resolves the product's facts but never rebuilds the
  // stored render model of the published review, so the page keeps showing the now-disputed
  // "1 Year Limited Warranty" until the next enrichment pass for that product rebuilds it
  // (PRODUCT_ENRICH_INTERVAL_HOURS, default 24 h). Remove `.fails` once collect rebuilds the
  // touched reviews' models.
  it("7b. a value that became CONFLICTING disappears from the review without a separate rebuild", async () => {
    const { review } = await seedReviewAndBrand();
    const a = productUrl("laptop13");
    const b = productUrl("laptop13-diy-edition");
    await crawl([pageItem(a, [productLd(a, { price: "999.00", warranty: "1 Year Limited Warranty" })])]);
    await persistPageRenderModel(review.id);
    await crawl([pageItem(b, [productLd(b, { price: "1099.00", warranty: "3 Year Limited Warranty" })])]);
    const r = await reviewPage(review.slug);
    expect(r.text).not.toMatch(/Year Limited Warranty/);
  });

  it("7c. the enrichment pass rebuilds the page and the disputed value disappears", async () => {
    const { review } = await seedReviewAndBrand();
    const a = productUrl("laptop13");
    const b = productUrl("laptop13-diy-edition");
    await crawl([pageItem(a, [productLd(a, { price: "999.00", warranty: "1 Year Limited Warranty" })])]);
    await persistPageRenderModel(review.id);
    await crawl([pageItem(b, [productLd(b, { price: "1099.00", warranty: "3 Year Limited Warranty" })])]);
    await runProductEnrichment({ trigger: "test" });
    const r = await reviewPage(review.slug);
    expect(r.text).not.toMatch(/Year Limited Warranty/);
  });

  it("8. missing product data (no JSON-LD product / no price): no offer, no card, no $0 or null", async () => {
    const { review } = await seedReviewAndBrand();
    const noProduct = productUrl("laptop13-accessories");
    const noOffers = productUrl("laptop13");
    const noPrice = productUrl("laptop12");
    await crawl([
      pageItem(noProduct, []),
      pageItem(noOffers, [productLd(noOffers, { offers: null })]),
      pageItem(noPrice, [productLd(noPrice, { name: "Framework Laptop 12", sku: "FRAKCB0001", price: null })], "Framework Laptop 12"),
    ]);
    const run = await db.commerceRun.findFirstOrThrow({ where: { status: "COLLECTED" } });
    expect(JSON.stringify(run.errors)).toContain("NO_PRODUCT");
    expect(await db.commerceProduct.findUnique({ where: { canonicalUrl: noProduct } })).toBeNull();
    expect(await db.commerceProduct.findUniqueOrThrow({ where: { canonicalUrl: noOffers } })).toMatchObject({ identityStatus: "MATCHED" });
    // No priced offer exists anywhere. (The identified, unpriced official page does get an offer row
    // with price null — reported; it is never shown.)
    expect(await db.commerceOffer.count({ where: { price: { not: null } } })).toBe(0);
    expect(await db.commerceOffer.count({ where: { product: { canonicalUrl: { in: [noProduct, noOffers] } } } })).toBe(0);
    expect(await db.productFact.count({ where: { field: { in: ["price", "listPrice"] } } })).toBe(0);

    const d = await deals();
    expectNoDeals(d);
    expect(d.text).not.toMatch(/\$0\b|\bnull\b/);
    await persistPageRenderModel(review.id);
    const r = await reviewPage(review.slug);
    expect(r.text).toContain(NO_VERIFIED_PRICE);
    expect(r.text).not.toMatch(/\$\d/);
    expect(keyFactsRows(r.markup)).not.toContain("Price");
  });

  it("9. valid official price drop (ListPrice / StrikethroughPrice above price): listed with the correct saving; MSRP-only is not a drop", async () => {
    const { review } = await seedReviewAndBrand();
    const l13 = productUrl("laptop13");
    const l16 = productUrl("laptop16");
    const l12 = productUrl("laptop12");
    await crawl([
      pageItem(l13, [productLd(l13, { price: "799.00", list: { type: "https://schema.org/ListPrice", price: 999 } })]),
      pageItem(l16, [productLd(l16, { name: "Framework Laptop 16", sku: "FRAGAACX01", price: "1299.00", list: { type: "https://schema.org/StrikethroughPrice", price: 1449 } })], "Framework Laptop 16"),
      // MSRP only: a price and a manufacturer's suggested price, no stated list/strikethrough price.
      pageItem(l12, [productLd(l12, { name: "Framework Laptop 12", sku: "FRAKCB0001", price: "1099.00", list: { type: "https://schema.org/MSRP", price: 1199 } })], "Framework Laptop 12"),
    ]);
    const offers = await db.commerceOffer.findMany({ orderBy: { price: "asc" } });
    expect(offers.map((o) => [o.price, o.listPrice])).toEqual([
      [799, 999],
      [1099, null],
      [1299, 1449],
    ]);

    const d = await deals();
    const drops = section(d.markup, "drops-title");
    const dropsText = visibleText(drops);
    expect(d.text).toContain("Verified price drops");
    expect(cards(drops)).toBe(2);
    expect(dropsText).toContain("Official Framework store price");
    // The previous price is labelled as each page marked it (schema.org ListPrice / StrikethroughPrice).
    expect(dropsText).toContain("Regular price $999.00");
    expect(dropsText).toContain("Was $1,449.00");
    expect(dropsText).toContain("You save $200.00 (20%)");
    expect(dropsText).toContain("You save $150.00 (10%)");
    expect(dropsText.indexOf("$200.00")).toBeLessThan(dropsText.indexOf("$150.00")); // biggest saving first
    expect(dropsText).not.toMatch(/Laptop 12|1,099|1,199/);
    expect(drops).toContain(`href="${l13}"`);
    expect(drops).toContain(`href="/review/${review.slug}"`);
    const list = jsonLd(d.markup).find((x) => (x as { "@type": string })["@type"] === "ItemList") as { itemListElement: Array<{ item: { offers: { price: number } } }> };
    expect(list.itemListElement.map((e) => e.item.offers.price)).toEqual([799, 1299]);

    const r = await reviewPage(review.slug);
    expect(r.text).toContain("$799.00 at Framework");
    const product = jsonLd(r.markup).find((x) => (x as { "@type": string })["@type"] === "Product") as { offers: Record<string, unknown> };
    expect(product.offers).toMatchObject({ "@type": "Offer", price: 799, priceCurrency: "USD" });
  });

  it("10. valid coupon published on the brand's official promo page: VERIFIED and shown under promo codes", async () => {
    const { review } = await seedReviewAndBrand();
    const ends = new Date(Date.now() + 30 * 86_400_000);
    const endsText = ends.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
    await couponCrawl([{ code: "SAVE10", context: `Use code SAVE10 for 10% off laptops. Offer ends ${endsText}.` }]);
    const c = await db.commerceCoupon.findFirstOrThrow({ where: { code: "SAVE10" } });
    expect(c).toMatchObject({ status: "VERIFIED", discount: "10% off", discountType: "PERCENT", sourceUrl: promoUrl() });
    expect(c.verificationEvidence).toMatch(/^Published on /);
    expect(stub.siteHits).toContain("GET /robots.txt");

    const d = await deals();
    const codes = section(d.markup, "codes-title");
    expect(d.text).toContain("Latest verified coupons");
    expect(cards(codes)).toBe(1);
    expect(visibleText(codes)).toContain("SAVE10");
    expect(visibleText(codes)).toContain("Framework promo code");
    expect(visibleText(codes)).toContain("10% off");
    expect(visibleText(codes)).toMatch(/Verified just now on official brand site/);
    const r = await reviewPage(review.slug);
    expect(r.text).toContain("SAVE10");
    // The review page shows the same coupon card (same rule, same markup).
    expect(r.text).toMatch(/Verified just now on official brand site/);
  });

  it("11. no verified deals: the empty state and no cards", async () => {
    const { review } = await seedReviewAndBrand();
    // Only non-qualifying data from the pipeline: a price without a stated regular price, and a code
    // the page does not present as a promotion.
    const url = productUrl("laptop13");
    await crawl([pageItem(url, [productLd(url, { price: "999.00" })])]);
    await couponCrawl([{ code: "FW2026XL", context: "Model FW2026XL ships with a 65W charger." }]);
    expect(await db.commerceCoupon.count({ where: { status: "VERIFIED" } })).toBe(0);
    expect(await db.commerceOffer.count({ where: { listPrice: { not: null } } })).toBe(0);

    const d = await deals();
    expect(d.markup).not.toContain('id="drops-title"');
    expect(d.markup).not.toContain('id="codes-title"');
    expect(d.text).toContain(NO_VERIFIED_OFFER);
    // The reviewed product's current price is not a deal card under drops/codes.
    expect(cards(section(d.markup, "drops-title")) + cards(section(d.markup, "codes-title"))).toBe(0);

    // With nothing at all, not even a current-price card.
    await db.commerceOffer.updateMany({ data: { status: "STALE" } });
    expectNoDeals(await deals());
    await reviewPage(review.slug);
  });
});
