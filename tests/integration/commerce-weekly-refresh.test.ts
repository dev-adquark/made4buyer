import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { dueBrands } from "@/lib/commerce/brands";
import { collectCommerceRuns, runCommerceDiscover } from "@/lib/commerce/pipeline";
import { recheckCandidates } from "@/lib/commerce/recheck";
import { normalizeUrl } from "@/lib/pipeline/apify";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

/**
 * Weekly deals refresh and offer price re-checks against a local Apify stand-in that also serves the
 * brand's "official site" (robots.txt, product pages). Sitemap discovery is network-bound and covered
 * by tests/unit/commerce-discovery.test.ts: here it returns the URLs a test sets per brand.
 * All data here is SAMPLE data.
 */

const discovered = new Map<string, string[]>();
vi.mock("@/lib/commerce/discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/commerce/discovery")>()),
  discoverProductUrls: async (brand: { slug?: string }) => ({ status: "OK", urls: [...(discovered.get(brand.slug ?? "") ?? [])] }),
}));

const { JOBS, runJob } = await import("@/lib/jobs/registry");
const weekly = await import("@/lib/commerce/weekly-refresh");

type RunState = { status: string; items: unknown[]; brand?: string };
const stub = {
  runs: new Map<string, RunState>(),
  posts: [] as Array<{ brand?: string; purpose?: string; urls: string[] }>,
  /** Product pages by URL: the dataset of a run is the pages of its start URLs. */
  pages: new Map<string, unknown>(),
  /** Brands whose run start fails with HTTP 500. */
  failBrands: new Set<string>(),
  runStatus: "SUCCEEDED",
};
let server: http.Server;
let port = 0;
let seq = 0;
let restore: () => void;

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
          const body = (raw ? JSON.parse(raw) : {}) as { startUrls?: Array<{ url: string }>; customData?: { brand?: string; purpose?: string } };
          const urls = (body.startUrls ?? []).map((s) => s.url);
          stub.posts.push({ brand: body.customData?.brand, purpose: body.customData?.purpose, urls });
          if (body.customData?.brand && stub.failBrands.has(body.customData.brand)) return json(500, { error: { type: "internal-server-error" } });
          const id = `run-${++seq}`;
          stub.runs.set(id, { status: stub.runStatus, brand: body.customData?.brand, items: urls.map((u) => stub.pages.get(u)).filter(Boolean) });
          return json(201, { data: { id, status: "RUNNING", defaultDatasetId: `ds-${id}` } });
        }
        if ((m = /^\/v2\/actor-runs\/([^/]+)$/.exec(url.pathname))) {
          const r = stub.runs.get(m[1]);
          if (!r) return json(404, { error: { type: "record-not-found" } });
          return json(200, { data: { id: m[1], status: r.status, defaultDatasetId: `ds-${m[1]}`, finishedAt: r.status === "RUNNING" ? null : new Date().toISOString(), usageTotalUsd: 0.01 } });
        }
        if ((m = /^\/v2\/datasets\/ds-([^/]+)\/items$/.exec(url.pathname))) return json(200, stub.runs.get(m[1])?.items ?? []);
        return json(404, { error: { type: "not-found" } });
      }
      // The brand's official site.
      if (url.pathname === "/robots.txt") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end("User-agent: *\nDisallow: /private\n");
      }
      if (url.pathname.startsWith("/gone")) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><title>ok</title>");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  restore = withEnv({
    APIFY_API_TOKEN: "test-apify-token",
    APIFY_API_BASE_URL: `http://127.0.0.1:${port}/v2`,
    COMMERCE_APIFY_ACTOR_ID: undefined,
    COMMERCE_MONTHLY_BUDGET_USD: undefined,
    COMMERCE_LINK_CHECK_DELAY_MS: "0",
    COMMERCE_OFFER_RECHECK_HOURS: undefined,
    COMMERCE_WEEKLY_BRANDS_PER_INVOCATION: undefined,
    COMMERCE_WEEKLY_SETTLE_HOURS: undefined,
    PRODUCT_PRICE_MAX_AGE_HOURS: undefined,
    DEALS_WEEKLY_DAY: undefined,
    DEALS_WEEKLY_HOUR_UTC: undefined,
  });
});

afterAll(async () => {
  restore();
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  await resetDb();
  stub.runs.clear();
  stub.posts.length = 0;
  stub.pages.clear();
  stub.failBrands.clear();
  stub.runStatus = "SUCCEEDED";
  discovered.clear();
});

// ── Fixtures ──────────────────────────────────────────────────────────────

const HOUR = 3_600_000;
const site = () => `http://127.0.0.1:${port}`;
const pageUrl = (path: string) => normalizeUrl(`${site()}${path}`)!;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR);

const addBrand = (slug: string, over: Record<string, unknown> = {}) =>
  db.commerceBrand.create({ data: { name: slug[0].toUpperCase() + slug.slice(1), slug, officialDomain: "127.0.0.1", categories: [], maxProductsPerRun: 3, crawlFrequencyHours: 24, crawlWindowStartHour: null, lastCrawlAt: ago(2), nextCrawlAt: new Date(Date.now() + 20 * HOUR), ...over } });

type OfferSeed = { price: number; listPrice?: number | null; observedHoursAgo: number; status?: string; linkStatus?: string; identity?: string };

/** A stored product page of the brand and its one offer (as an earlier crawl would have left them). */
async function seedOffer(brandId: string, path: string, o: OfferSeed) {
  const url = pageUrl(path);
  const product = await db.commerceProduct.create({ data: { brandId, canonicalUrl: url, name: `Sample ${path}`, sku: `SKU${path.replace(/\W/g, "")}`, identityStatus: o.identity ?? "UNMATCHED", observedAt: ago(o.observedHoursAgo) } });
  return db.commerceOffer.create({ data: { productId: product.id, seller: "Sample", sellerType: "MANUFACTURER", destinationUrl: url, price: o.price, listPrice: o.listPrice ?? null, currency: "USD", observedAt: ago(o.observedHoursAgo), status: o.status ?? "FRESH", linkStatus: o.linkStatus ?? "OK" } });
}

/** What the brand's product page states (schema.org Product JSON-LD, as the page function returns it). */
function page(path: string, brand: string, price: number, listPrice?: number) {
  const url = pageUrl(path);
  const offer: Record<string, unknown> = { "@type": "Offer", url, price: price.toFixed(2), priceCurrency: "USD", availability: "https://schema.org/InStock" };
  if (listPrice) offer.priceSpecification = [{ "@type": "UnitPriceSpecification", priceType: "https://schema.org/ListPrice", price: listPrice, priceCurrency: "USD" }];
  const item = {
    m4bCommerce: 1,
    url,
    canonicalUrl: url,
    title: `Sample ${path}`,
    h1: `Sample ${path}`,
    jsonLd: [{ "@context": "https://schema.org", "@type": "Product", name: `${brand} Sample ${path.split("/").pop()}`, sku: `SKU${path.replace(/\W/g, "")}`, brand: { "@type": "Brand", name: brand }, offers: offer }],
    meta: {},
    breadcrumbs: [],
    specTables: [],
    images: [],
    lang: "en-US",
  };
  stub.pages.set(url, item);
  return item;
}

const productPosts = () => stub.posts.filter((p) => p.purpose !== "COUPON");

// ── Price re-checks ───────────────────────────────────────────────────────

describe("offer price re-checks", () => {
  it("puts due offer pages first (deals, then matched, oldest first), skips robots-disallowed and dead ones, and updates the same offer row", async () => {
    const brand = await addBrand("acme", { nextCrawlAt: null });
    const plain = await seedOffer(brand.id, "/products/plain", { price: 50, observedHoursAgo: 30, identity: "MATCHED" });
    const deal = await seedOffer(brand.id, "/products/deal", { price: 79.99, listPrice: 99.99, observedHoursAgo: 22 });
    await seedOffer(brand.id, "/products/recent", { price: 20, listPrice: 40, observedHoursAgo: 2 }); // checked recently: not due
    await seedOffer(brand.id, "/private/hidden-deal", { price: 10, listPrice: 30, observedHoursAgo: 30 }); // robots.txt disallows /private
    await seedOffer(brand.id, "/products/dead", { price: 10, listPrice: 30, observedHoursAgo: 30, linkStatus: "BROKEN" });
    discovered.set("acme", [pageUrl("/products/new-1"), pageUrl("/products/new-2"), pageUrl("/products/new-3")]);

    const r = await recheckCandidates(brand, new Date(), 10);
    expect(r.urls).toEqual([pageUrl("/products/deal"), pageUrl("/products/plain")]);
    expect(r.skipped).toEqual([expect.objectContaining({ url: pageUrl("/private/hidden-deal"), reason: expect.stringMatching(/robots\.txt/) })]);

    const job = await runCommerceDiscover("test");
    expect(job).toMatchObject({ started: 1, results: [expect.objectContaining({ brand: "acme", status: "STARTED", recheck: 2 })] });
    // Re-checks first, then discovered URLs fill the run up to maxProductsPerRun (3).
    expect(productPosts()[0].urls).toEqual([pageUrl("/products/deal"), pageUrl("/products/plain"), pageUrl("/products/new-1")]);

    // The crawl finds a new price on the deal page: the same offer row is updated, not a second one.
    page("/products/deal", "Acme", 69.99, 99.99);
    page("/products/plain", "Acme", 55);
    const run = [...stub.runs.values()][0];
    run.items = [stub.pages.get(pageUrl("/products/deal")), stub.pages.get(pageUrl("/products/plain"))];
    await collectCommerceRuns("test");
    const after = await db.commerceOffer.findUniqueOrThrow({ where: { id: deal.id } });
    expect(after).toMatchObject({ price: 69.99, listPrice: 99.99, status: "FRESH" });
    expect(after.observedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(await db.commerceOffer.count({ where: { product: { canonicalUrl: pageUrl("/products/deal") } } })).toBe(1);
    expect(await db.commerceOffer.count({ where: { product: { canonicalUrl: pageUrl("/products/plain") } } })).toBe(1);
    expect(plain.id).toBeTruthy();
  });

  it("re-checks alone fill the run when there are enough of them (no discovery needed)", async () => {
    const brand = await addBrand("acme", { nextCrawlAt: null, maxProductsPerRun: 2 });
    for (const p of ["a", "b", "c"]) await seedOffer(brand.id, `/products/${p}`, { price: 10, listPrice: 20, observedHoursAgo: 25 });
    discovered.set("acme", [pageUrl("/products/new")]);
    const job = await runCommerceDiscover("test");
    expect(job.results?.[0]).toMatchObject({ status: "STARTED", discovery: "NOT_NEEDED", recheck: 2 });
    expect(productPosts()[0].urls).toHaveLength(2);
    expect(productPosts()[0].urls).not.toContain(pageUrl("/products/new"));
  });

  it("makes a brand due outside its crawl window when its oldest public offer would otherwise go stale", async () => {
    const outside = (new Date().getUTCHours() + 12) % 24;
    const brand = await addBrand("acme", { crawlWindowStartHour: outside, crawlWindowHours: 2, timezone: "UTC", lastCrawlAt: ago(40), nextCrawlAt: new Date(Date.now() + 10 * HOUR) });
    const offer = await seedOffer(brand.id, "/products/deal", { price: 10, listPrice: 20, observedHoursAgo: 30 });
    expect((await dueBrands(new Date(), 10)).map((b) => b.slug)).toEqual([]);

    // Observed 40 h ago: it would pass 48 h before the next window → due now.
    await db.commerceOffer.update({ where: { id: offer.id }, data: { observedAt: ago(40) } });
    expect((await dueBrands(new Date(), 10)).map((b) => b.slug)).toEqual(["acme"]);

    // Urgent brands come before normally due ones.
    await addBrand("zeta", { priority: 999, nextCrawlAt: null });
    expect((await dueBrands(new Date(), 10)).map((b) => b.slug)).toEqual(["acme", "zeta"]);

    // Cost guard: never more often than every 6 h. A failure backoff is respected.
    await db.commerceBrand.update({ where: { id: brand.id }, data: { lastCrawlAt: ago(2) } });
    expect((await dueBrands(new Date(), 10)).map((b) => b.slug)).toEqual(["zeta"]);
    await db.commerceBrand.update({ where: { id: brand.id }, data: { lastCrawlAt: ago(40), consecutiveFailures: 2 } });
    expect((await dueBrands(new Date(), 10)).map((b) => b.slug)).toEqual(["zeta"]);
  });
});

// ── Weekly sweep ──────────────────────────────────────────────────────────

describe("weekly deals refresh", () => {
  it("computes the weekly slot in UTC, defaults to Sunday 06:00, and saves an audited admin schedule", async () => {
    const s = { weekday: 0, hourUtc: 6 };
    expect(weekly.slotOnOrBefore(new Date("2026-10-07T12:00:00Z"), s).toISOString()).toBe("2026-10-04T06:00:00.000Z");
    expect(weekly.slotOnOrBefore(new Date("2026-10-11T05:59:00Z"), s).toISOString()).toBe("2026-10-04T06:00:00.000Z");
    expect(weekly.slotOnOrBefore(new Date("2026-10-11T06:00:00Z"), s).toISOString()).toBe("2026-10-11T06:00:00.000Z");
    expect(weekly.nextSlotAfter(new Date("2026-10-07T12:00:00Z"), s).toISOString()).toBe("2026-10-11T06:00:00.000Z");

    expect(await weekly.getWeeklySchedule()).toEqual({ weekday: 0, hourUtc: 6, source: "default" });
    const undo = withEnv({ DEALS_WEEKLY_DAY: "3", DEALS_WEEKLY_HOUR_UTC: "9" });
    expect(await weekly.getWeeklySchedule()).toEqual({ weekday: 3, hourUtc: 9, source: "env" });
    undo();

    expect(await weekly.setWeeklySchedule({ weekday: "7", hourUtc: "1" }, { actor: "admin@example.test" })).toMatchObject({ ok: false });
    expect(await weekly.setWeeklySchedule({ weekday: "5", hourUtc: "22" }, { actor: "admin@example.test" })).toMatchObject({ ok: true, before: { weekday: 0, hourUtc: 6 }, after: { weekday: 5, hourUtc: 22 } });
    expect(await weekly.getWeeklySchedule()).toEqual({ weekday: 5, hourUtc: 22, source: "admin" });
    expect(await db.auditLog.findFirst({ where: { action: "commerce.weekly_schedule.set", actor: "admin@example.test" } })).not.toBeNull();
    const status = await weekly.weeklyRefreshStatus(new Date("2026-10-07T12:00:00Z"));
    expect(status).toMatchObject({ schedule: { weekday: 5, hourUtc: 22, label: "Friday 22:00 UTC" }, timezone: "UTC", nextSlot: "2026-10-09T22:00:00.000Z", current: null, lastSweep: null, paused: false });
  });

  it("runs when this week's slot has passed, is SKIPPED until the next slot after completing, and Run now forces it", async () => {
    await addBrand("acme");
    expect((await weekly.weeklyRefreshStatus()).dueNow).toBe(true);

    const first = (await runJob("deals-weekly-refresh", "cron")) as Awaited<ReturnType<typeof weekly.runWeeklyRefresh>>;
    expect(first).toMatchObject({ status: "COMPLETED", stage: "done" });
    const ok = await db.jobRun.findFirstOrThrow({ where: { job: "deals-weekly-refresh" }, orderBy: { startedAt: "desc" } });
    expect(ok).toMatchObject({ status: "SUCCEEDED", outcome: "COMPLETED" });
    expect(ok.reason).toMatch(/^week \S+ completed: .*deals \+0 created/);

    // Same week: a second scheduled invocation does nothing.
    const posts = stub.posts.length;
    const second = (await runJob("deals-weekly-refresh", "cron")) as { status: string; reason: string; nextSlot: string };
    expect(second.status).toBe("SKIPPED");
    expect(second.reason).toContain(`not due until ${second.nextSlot}`);
    expect(new Date(second.nextSlot).getTime()).toBeGreaterThan(Date.now());
    expect(await db.jobRun.findFirstOrThrow({ where: { job: "deals-weekly-refresh" }, orderBy: { startedAt: "desc" } })).toMatchObject({ status: "SKIPPED", outcome: "SKIPPED" });
    expect(stub.posts.length).toBe(posts);
    expect(await weekly.weeklyRefreshStatus()).toMatchObject({ dueNow: false, current: null, lastSweep: { status: expect.stringMatching(/^COMPLETED/) } });

    // Admin "Run now" forces a new sweep.
    expect(await runJob("deals-weekly-refresh", "admin:owner@example.test")).toMatchObject({ status: "COMPLETED" });
    // Hourly passes find nothing in progress and never start one.
    expect(await weekly.continueWeeklyRefresh("cron")).toMatchObject({ status: "IDLE" });
    expect(await JOBS["commerce-discover"].run("test")).toMatchObject({ weekly: { status: "IDLE" } });
  });

  it("resumes across invocations (brand cap, waiting for runs), continued by the hourly passes, and records counters", async () => {
    const undo = withEnv({ COMMERCE_WEEKLY_BRANDS_PER_INVOCATION: "1" });
    try {
      stub.runStatus = "RUNNING";
      const brands = await Promise.all(["alpha", "beta", "gamma"].map((s) => addBrand(s)));
      for (const b of brands) {
        await seedOffer(b.id, `/products/${b.slug}-deal`, { price: 80, listPrice: 100, observedHoursAgo: 25 });
        page(`/products/${b.slug}-deal`, b.name, 75, 100);
      }
      // alpha: a new page with a deal (deal created); a deal whose page robots.txt now disallows goes stale (expired, hidden).
      discovered.set("alpha", [pageUrl("/products/alpha-new")]);
      page("/products/alpha-new", "Alpha", 40, 60);
      await seedOffer(brands[0].id, "/private/alpha-old", { price: 5, listPrice: 9, observedHoursAgo: 50 });
      // gamma: a recent deal whose page is gone (link check hides it).
      await seedOffer(brands[2].id, "/gone/gamma-recent", { price: 1, listPrice: 2, observedHoursAgo: 1 });

      const r1 = (await runJob("deals-weekly-refresh", "cron")) as Awaited<ReturnType<typeof weekly.runWeeklyRefresh>>;
      expect(r1).toMatchObject({ status: "IN_PROGRESS", stage: "recheck" });
      expect(r1.progress).toContain("1 of 3 brands");
      expect(productPosts()).toHaveLength(1);

      const r2 = await weekly.continueWeeklyRefresh("cron", { budgetMs: 60_000 });
      expect(r2).toMatchObject({ status: "IN_PROGRESS", stage: "recheck" });
      expect(productPosts()).toHaveLength(2);

      // Third invocation: last brand, then discovery/coupons, then waits for the RUNNING Apify runs.
      const r3 = await weekly.continueWeeklyRefresh("cron", { budgetMs: 60_000 });
      expect(r3).toMatchObject({ status: "IN_PROGRESS", stage: "settle" });
      expect(r3.reason).toMatch(/waiting for this sweep's Apify runs/);
      expect(productPosts().map((p) => p.brand).sort()).toEqual(["alpha", "beta", "gamma"]);
      // Re-check pages lead each run.
      expect(productPosts().find((p) => p.brand === "alpha")!.urls).toEqual([pageUrl("/products/alpha-deal"), pageUrl("/products/alpha-new")]);

      for (const run of stub.runs.values()) run.status = "SUCCEEDED";
      const r4 = await weekly.continueWeeklyRefresh("cron", { budgetMs: 60_000 });
      expect(r4).toMatchObject({ status: "COMPLETED", stage: "done" });

      const state = (await weekly.readSweepState())!;
      expect(state).toMatchObject({ stage: "done", invocations: 4 });
      expect(state.counters).toMatchObject({
        brandsTargeted: 3,
        brandsProcessed: 3,
        runsStarted: 3,
        runsFailed: 0,
        recordsDiscovered: 4,
        recordsAccepted: 0, // no Made4Buyers product to match: official-site offers only
        dealsAtStart: 5,
        dealsCreated: 1,
        dealsExpired: 1,
        dealsHidden: 2,
        linksFailed: 1,
        apiErrors: 0,
      });
      expect(state.counters.offersUpdated).toBeGreaterThanOrEqual(4);
      expect(state.counters.linksChecked).toBeGreaterThanOrEqual(5);
      // Re-crawled offers are the same rows with the new price.
      expect(await db.commerceOffer.findFirstOrThrow({ where: { destinationUrl: pageUrl("/products/beta-deal") } })).toMatchObject({ price: 75, status: "FRESH" });
      // The completion (by an hourly continuation) is in job_runs, and the next scheduled call is SKIPPED.
      expect(await db.jobRun.findFirst({ where: { job: "deals-weekly-refresh", outcome: "COMPLETED" } })).not.toBeNull();
      expect(await runJob("deals-weekly-refresh", "cron")).toMatchObject({ status: "SKIPPED" });
      expect((await weekly.readLastSweep())!.counters.dealsCreated).toBe(1);
    } finally {
      undo();
    }
  });

  it("one brand failing never stops the sweep: the reason is recorded and the others run", async () => {
    const brands = await Promise.all(["alpha", "beta", "gamma"].map((s) => addBrand(s)));
    for (const b of brands) {
      await seedOffer(b.id, `/products/${b.slug}-deal`, { price: 80, listPrice: 100, observedHoursAgo: 25 });
      page(`/products/${b.slug}-deal`, b.name, 80, 100);
    }
    stub.failBrands.add("beta");

    const r = (await runJob("deals-weekly-refresh", "cron")) as Awaited<ReturnType<typeof weekly.runWeeklyRefresh>>;
    expect(r).toMatchObject({ status: "COMPLETED" });
    expect(r.counters).toMatchObject({ brandsProcessed: 3, runsStarted: 2, runsFailed: 1 });
    expect(r.counters!.apiErrors).toBeGreaterThanOrEqual(1);
    expect(r.errors).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "recheck", target: "beta", code: "APIFY_RUN_FAILED" })]));
    // The failed brand is backed off (existing backoff); its offer is untouched, the others were refreshed.
    expect(await db.commerceBrand.findUniqueOrThrow({ where: { slug: "beta" } })).toMatchObject({ consecutiveFailures: 1 });
    expect((await db.commerceOffer.findFirstOrThrow({ where: { destinationUrl: pageUrl("/products/beta-deal") } })).observedAt.getTime()).toBeLessThan(Date.now() - 24 * HOUR);
    expect((await db.commerceOffer.findFirstOrThrow({ where: { destinationUrl: pageUrl("/products/gamma-deal") } })).observedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(await weekly.readLastSweep()).toMatchObject({ status: "COMPLETED_WITH_ERRORS" });
  });
});
