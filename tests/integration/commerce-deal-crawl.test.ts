import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { buildDealActorInput, robotsRulesFor, type BrandRobots } from "@/lib/commerce/deal-crawl";
import { collectCommerceRuns, startBrandRun, startProductRun } from "@/lib/commerce/pipeline";
import { SEED_HASH_KEY, syncSeedFields } from "@/lib/commerce/seed-sync";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

// A local stand-in for the Apify API (runs, run status with stats, dataset items) that also serves a
// brand's robots.txt for the loopback brand. All data here is SAMPLE data.
type RunState = { status: string; usageTotalUsd?: number; computeUnits?: number; items: unknown[] };
const runs = new Map<string, RunState>();
const requests: Array<{ method: string; path: string; body?: unknown }> = [];
let nextItems: unknown[] = [];
let server: http.Server;
let base = "";
let host = "";
let restore: () => void;
let seq = 0;
const ROBOTS = "User-agent: *\nDisallow: /cart\nDisallow: /sale/private\n\nUser-agent: *\nDisallow: /*.json$\n";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://stub");
      requests.push({ method: req.method ?? "GET", path: url.pathname, body: body ? JSON.parse(body) : undefined });
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (url.pathname === "/robots.txt") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end(ROBOTS);
      }
      if (req.headers.authorization !== "Bearer test-apify-token") return send(401, { error: { type: "token-not-valid" } });
      let m: RegExpExecArray | null;
      if (req.method === "POST" && /^\/v2\/acts\/[^/]+\/runs$/.test(url.pathname)) {
        const id = `run-${++seq}`;
        runs.set(id, { status: "RUNNING", items: nextItems });
        return send(201, { data: { id, status: "RUNNING", defaultDatasetId: `ds-${id}` } });
      }
      if ((m = /^\/v2\/actor-runs\/([^/]+)$/.exec(url.pathname))) {
        const r = runs.get(m[1]);
        if (!r) return send(404, { error: { type: "record-not-found" } });
        return send(200, { data: { id: m[1], status: r.status, defaultDatasetId: `ds-${m[1]}`, finishedAt: r.status === "RUNNING" ? null : "2026-10-06T10:00:00.000Z", usageTotalUsd: r.usageTotalUsd ?? null, stats: r.computeUnits != null ? { computeUnits: r.computeUnits } : {} } });
      }
      if ((m = /^\/v2\/datasets\/ds-([^/]+)\/items$/.exec(url.pathname))) {
        const r = runs.get(m[1]);
        return send(200, (r?.items ?? []).slice(0, Number(url.searchParams.get("limit") ?? 1000)));
      }
      send(404, { error: { type: "not-found" } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  base = `http://${host}`;
  restore = withEnv({ APIFY_API_TOKEN: "test-apify-token", APIFY_API_BASE_URL: `${base}/v2`, COMMERCE_APIFY_ACTOR_ID: undefined, COMMERCE_MONTHLY_BUDGET_USD: undefined, COMMERCE_DEAL_PAGES_PER_RUN: undefined, PRODUCT_PRICE_MAX_AGE_HOURS: undefined });
});
afterAll(async () => {
  restore();
  await new Promise((r) => server.close(r));
});
beforeEach(async () => {
  await resetDb();
  runs.clear();
  requests.length = 0;
  nextItems = [];
});

// ── SAMPLE brand: an official Shopify store ───────────────────────────────────
const DOMAIN = "www.sample-sleep.com";
const SITE = `https://${DOMAIN}`;
const DEAL = `${SITE}/collections/sale`;
const PILLOW = `${SITE}/products/cloud-pillow`;
const robots: BrandRobots = { status: "READ", body: ROBOTS, rules: robotsRulesFor(ROBOTS) };
const addBrand = (over: Record<string, unknown> = {}) =>
  db.commerceBrand.create({ data: { name: "Sample Sleep", slug: "sample-sleep", officialDomain: DOMAIN, dealUrls: [DEAL], maxProductsPerRun: 20, crawlFrequencyHours: 24, crawlWindowStartHour: null, ...over } });

const shopifyJson = () => ({
  id: 1,
  title: "Cloud Pillow",
  handle: "cloud-pillow",
  variants: [
    { id: 101, title: "Standard", sku: "CP-STD", barcode: "012345678905", available: false, price: 6900, compare_at_price: 8900 },
    { id: 102, title: "King", sku: "CP-KING", barcode: "4006381333931", available: true, price: 7900, compare_at_price: 9900 },
  ],
});
const item = (over: Record<string, unknown> = {}) => ({
  m4bCommerce: 1,
  url: PILLOW,
  requestUrl: PILLOW,
  crawlLabel: "LINKED",
  canonicalUrl: PILLOW,
  title: "Cloud Pillow – Sample Sleep",
  h1: "Cloud Pillow",
  jsonLd: [{ "@context": "https://schema.org", "@type": "Product", name: "Cloud Pillow", brand: { "@type": "Brand", name: "Sample Sleep" }, offers: [{ "@type": "Offer", price: "69.00", priceCurrency: "USD" }, { "@type": "Offer", price: "79.00", priceCurrency: "USD" }] }],
  meta: { "og:type": "product" },
  breadcrumbs: [],
  specTables: [],
  images: [],
  priceBlocks: [],
  shopifyProduct: shopifyJson(),
  shopifyCurrency: "USD",
  shopifyCountry: "US",
  shopifyNote: null,
  lang: "en",
  ...over,
});

async function collect(brand: Awaited<ReturnType<typeof addBrand>>, items: unknown[], computeUnits?: number) {
  nextItems = items;
  const started = await startProductRun(brand, [], "test", undefined, { listingUrls: [DEAL], robots });
  expect(started.status).toBe("STARTED");
  Object.assign(runs.get(started.apifyRunId!)!, { status: "SUCCEEDED", usageTotalUsd: 0.04, computeUnits });
  const collected = await collectCommerceRuns("test");
  return { started, collected };
}

describe("deal-page crawl input", () => {
  it("labels deal pages LISTING and product pages PRODUCT, follows only product links one level deep, capped", () => {
    const input = buildDealActorInput({ slug: "sample-sleep", officialDomain: DOMAIN, productUrlPatterns: [], maxProductsPerRun: 20, market: "US" }, [DEAL], [PILLOW], { robotsRules: robots.rules });
    expect(input.startUrls).toEqual([
      { url: DEAL, userData: { label: "LISTING" } },
      { url: PILLOW, userData: { label: "PRODUCT" } },
    ]);
    expect(input).toMatchObject({ linkSelector: "a[href]", maxCrawlingDepth: 1, maxConcurrency: 2, maxRequestRetries: 2, respectRobotsTxtFile: true, proxyConfiguration: { useApifyProxy: true } });
    // Followed pages: min(maxProductsPerRun 20, COMMERCE_DEAL_PAGES_PER_RUN 40) = 20, plus the 2 start URLs.
    expect(input.maxPagesPerCrawl).toBe(22);
    // No patterns: product-segment paths on the exact official host only.
    expect(input.globs.map((g) => g.glob)).toContain(`https://${DOMAIN}/**/products/*`);
    expect(input.globs.every((g) => g.glob.startsWith(`https://${DOMAIN}/`))).toBe(true);
    expect(input.excludes.map((g) => g.glob)).toContain("**/*refurb*");
    expect(input.customData).toMatchObject({ brand: "sample-sleep", officialHost: DOMAIN, dealCrawl: true, usOnly: true, followCap: 20, robotsRules: robots.rules });
    const follow = input.customData.followPatterns!.map((p) => new RegExp(p, "i"));
    expect(follow.some((re) => re.test(`${SITE}/products/cloud-pillow`))).toBe(true);
    expect(follow.some((re) => re.test(`${SITE}/collections/sale/products/cloud-pillow?variant=2`))).toBe(true);
    expect(follow.some((re) => re.test(`https://evil.example.com/products/cloud-pillow`))).toBe(false);
    expect(follow.some((re) => re.test(`${SITE}/pages/about`))).toBe(false);
    // Robots rules of every "User-agent: *" group are passed (merged).
    expect(robots.rules).toEqual([
      { allow: false, path: "/cart" },
      { allow: false, path: "/sale/private" },
      { allow: false, path: "/*.json$" },
    ]);
  });

  it("uses the brand's patterns as globs and honours COMMERCE_DEAL_PAGES_PER_RUN", () => {
    const undo = withEnv({ COMMERCE_DEAL_PAGES_PER_RUN: "5" });
    try {
      const input = buildDealActorInput({ slug: "s", officialDomain: DOMAIN, productUrlPatterns: [`${SITE}/products/*`], maxProductsPerRun: 20, market: "US" }, [DEAL, DEAL], []);
      expect(input.globs).toEqual([{ glob: `${SITE}/products/*` }]);
      // With patterns, only not-new items (refurbished, renewed …) are excluded.
      expect(input.excludes.map((e: { glob: string }) => e.glob)).toEqual(["**/*refurb*", "**/*renewed*", "**/*reconditioned*", "**/*open-box*", "**/*pre-owned*"]);
      expect(input.startUrls).toHaveLength(1);
      expect(input.maxPagesPerCrawl).toBe(1 + 5);
      expect(input.customData.robotsRules).toBeNull();
    } finally {
      undo();
    }
  });

  it("re-checks lead, then deal pages, then other product pages — one run per brand", async () => {
    const brand = await addBrand();
    await startProductRun(brand, [`${SITE}/products/recheck-1`, PILLOW], "test", undefined, { listingUrls: [DEAL], robots, recheckUrls: 1 });
    const body = requests.find((q) => q.method === "POST")!.body as ReturnType<typeof buildDealActorInput>;
    expect(body.startUrls).toEqual([
      { url: `${SITE}/products/recheck-1`, userData: { label: "PRODUCT" } },
      { url: DEAL, userData: { label: "LISTING" } },
      { url: PILLOW, userData: { label: "PRODUCT" } },
    ]);
    expect(await db.commerceRun.count()).toBe(1);
    // Budget, switch and backoff gates are the product run's own.
    const undo = withEnv({ COMMERCE_MONTHLY_BUDGET_USD: "0" });
    try {
      await db.commerceRun.updateMany({ data: { status: "COLLECTED" } });
      expect(await startProductRun(brand, [], "test", undefined, { listingUrls: [DEAL], robots })).toMatchObject({ status: "SKIPPED", code: "BUDGET_EXHAUSTED" });
    } finally {
      undo();
    }
  });

  it("startBrandRun adds the crawlable deal pages (robots.txt-checked, on-domain) and explicit product pages; product-only runs stay depth 0", async () => {
    const brand = await db.commerceBrand.create({ data: { name: "Loop", slug: "loop", officialDomain: host, dealUrls: [`${base}/collections/sale`, `${base}/sale/private`, "https://elsewhere.example.com/sale"], productUrls: [`${base}/products/explicit-1`], maxProductsPerRun: 5, crawlFrequencyHours: 24, crawlWindowStartHour: null } });
    const r = await startBrandRun(brand, "test", new Date(), { discovery: { persist: false, timeoutMs: 2_000 } });
    expect(r).toMatchObject({ status: "STARTED", dealPages: 1 });
    const posts = requests.filter((q) => q.method === "POST");
    expect(posts).toHaveLength(1);
    const body = posts[0].body as ReturnType<typeof buildDealActorInput>;
    // The crawlable deal page (the robots-disallowed and off-domain ones are left out), then the explicit product page.
    expect(body.startUrls).toEqual([
      { url: `${base}/collections/sale`, userData: { label: "LISTING" } },
      { url: `${base}/products/explicit-1`, userData: { label: "PRODUCT" } },
    ]);
    expect(body.maxCrawlingDepth).toBe(1);
    expect(body.customData.robotsRules).toEqual(robotsRulesFor(ROBOTS));
    const run = await db.commerceRun.findFirstOrThrow({ where: { brandId: brand.id } });
    expect(run.startUrls).toBe(2);

    // A brand without deal pages: the unchanged depth-0 product input (with robots rules for the page).
    await db.commerceRun.updateMany({ data: { status: "COLLECTED" } });
    requests.length = 0;
    await db.commerceBrand.update({ where: { id: brand.id }, data: { dealUrls: [] } });
    const again = await startBrandRun((await db.commerceBrand.findUniqueOrThrow({ where: { id: brand.id } })), "test", new Date(), { discovery: { persist: false, timeoutMs: 2_000 } });
    expect(again.status).toBe("STARTED");
    const body2 = requests.find((q) => q.method === "POST")!.body as Record<string, unknown>;
    expect(body2).toMatchObject({ maxCrawlingDepth: 0 });
    expect(body2.linkSelector).toBeUndefined();
    expect((body2.customData as { robotsRules: unknown }).robotsRules).toEqual(robotsRulesFor(ROBOTS));
  });
});

describe("deal crawl collection", () => {
  it("listing pages and followed non-product pages create no product; the Shopify product page becomes an offer with its compare-at price", async () => {
    const brand = await addBrand();
    const { collected } = await collect(
      brand,
      [
        {}, // a listing page returns null: an empty dataset item
        item({ url: DEAL, requestUrl: DEAL, crawlLabel: "LISTING", canonicalUrl: DEAL, shopifyProduct: null }),
        item({ url: `${SITE}/pages/about`, requestUrl: `${SITE}/pages/about`, canonicalUrl: `${SITE}/pages/about`, shopifyProduct: null }),
        item({ url: `https://other.example.com/products/cloud-pillow`, requestUrl: `https://other.example.com/products/cloud-pillow`, canonicalUrl: null }),
        item({ url: `${SITE}/fr-fr/products/cloud-pillow`, requestUrl: `${SITE}/fr-fr/products/cloud-pillow`, canonicalUrl: null }),
        item(),
      ],
      0.0123,
    );
    expect(collected).toMatchObject({ collected: 1 });
    const run = await db.commerceRun.findFirstOrThrow({ where: { brandId: brand.id } });
    expect(run).toMatchObject({ status: "COLLECTED", pagesProcessed: 6, extracted: 1, computeUnits: 0.0123, usageUsd: 0.04 });
    const errors = run.errors as Array<{ url: string; reason: string }>;
    expect(errors.find((e) => e.url === DEAL)?.reason).toMatch(/LINK_NOT_PRODUCT/);
    expect(errors.find((e) => e.url.includes("/pages/about"))?.reason).toMatch(/LINK_NOT_PRODUCT/);
    expect(errors.find((e) => e.url.includes("other.example.com"))?.reason).toMatch(/not the official host/);
    expect(errors.find((e) => e.url.includes("/fr-fr/"))?.reason).toMatch(/not a US storefront/);

    const products = await db.commerceProduct.findMany({ include: { offers: true } });
    expect(products).toHaveLength(1);
    const [product] = products;
    // The first AVAILABLE variant (King), never a mix with the out-of-stock Standard variant.
    expect(product).toMatchObject({ canonicalUrl: `${PILLOW}?variant=102`, name: "Cloud Pillow – King", sku: "CP-KING", gtin: "4006381333931", identityStatus: "UNMATCHED" });
    expect((product.data as { extractionMethod: string }).extractionMethod).toBe("apify-web-scraper:shopify-product-json");
    expect(product.offers).toHaveLength(1);
    const [offer] = product.offers;
    expect(offer).toMatchObject({ destinationUrl: `${PILLOW}?variant=102`, price: 79, listPrice: 99, currency: "USD", availability: "InStock", seller: "Sample Sleep", sellerType: "MANUFACTURER", status: "FRESH" });
    // Stated as the merchant's compare-at price; the classifier (run at collect) finds nothing missing.
    const stated = (product.data as { offers: Array<Record<string, unknown>> }).offers[0];
    expect(stated).toMatchObject({ listPriceType: "CompareAtPrice", source: "shopify" });
    expect(offer.dealStatus).toBe("ACTIVE");
  });

  it("re-collecting the same page updates the same rows (idempotent)", async () => {
    const brand = await addBrand();
    await collect(brand, [item()]);
    await db.commerceRun.updateMany({ data: { status: "COLLECTED" } });
    await collect(brand, [item({ shopifyProduct: { ...shopifyJson(), variants: shopifyJson().variants.map((v) => (v.id === 102 ? { ...v, price: 7500 } : v)) } })]);
    const offers = await db.commerceOffer.findMany();
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ price: 75, listPrice: 99 });
    expect(await db.commerceProduct.count()).toBe(1);
  });
});

describe("seed sync", () => {
  const seed = [
    { name: "Sample Sleep", slug: "sample-sleep", officialDomain: DOMAIN, dealUrls: [DEAL], productUrls: [PILLOW], productUrlPatterns: [`${SITE}/products/*`], promoUrls: [`${SITE}/pages/offers`] },
    { name: "Other", slug: "other-brand", officialDomain: "www.other-brand.com", dealUrls: ["https://www.other-brand.com/sale"], promoUrls: ["https://not-theirs.example.com/promo"] },
    { name: "Missing", slug: "not-in-db", officialDomain: "www.missing.com", dealUrls: ["https://www.missing.com/sale"] },
  ];

  it("fills only EMPTY fields from the seed, never an admin's list, and is idempotent", async () => {
    const a = await addBrand({ dealUrls: [], promoUrls: [`${SITE}/admin-chosen`] });
    const b = await db.commerceBrand.create({ data: { name: "Other", slug: "other-brand", officialDomain: "www.other-brand.com", dealUrls: ["https://www.other-brand.com/admin-deals"] } });
    const r1 = await syncSeedFields(seed);
    expect(r1.status).toBe("SYNCED");
    const a1 = await db.commerceBrand.findUniqueOrThrow({ where: { id: a.id } });
    expect(a1).toMatchObject({ dealUrls: [DEAL], productUrls: [PILLOW], productUrlPatterns: [`${SITE}/products/*`], promoUrls: [`${SITE}/admin-chosen`] });
    const b1 = await db.commerceBrand.findUniqueOrThrow({ where: { id: b.id } });
    expect(b1.dealUrls).toEqual(["https://www.other-brand.com/admin-deals"]);
    // An off-domain seed URL is never copied.
    expect(b1.promoUrls).toEqual([]);
    expect(r1.skipped).toEqual([expect.objectContaining({ slug: "other-brand", field: "promoUrls" })]);
    expect(await db.commerceBrand.count()).toBe(2); // never creates brands
    expect((await db.automationSetting.findUniqueOrThrow({ where: { key: SEED_HASH_KEY } })).value).toBe(r1.hash);

    // Same seed: nothing to do (one settings read), even after an admin clears a field.
    await db.commerceBrand.update({ where: { id: a.id }, data: { dealUrls: [] } });
    expect((await syncSeedFields(seed)).status).toBe("UNCHANGED");
    expect((await db.commerceBrand.findUniqueOrThrow({ where: { id: a.id } })).dealUrls).toEqual([]);

    // A changed seed fills empty fields again, still never overwriting a set one.
    const r3 = await syncSeedFields([{ ...seed[0], dealUrls: [`${SITE}/collections/clearance`], promoUrls: [`${SITE}/other`] }, seed[1]]);
    expect(r3.status).toBe("SYNCED");
    const a3 = await db.commerceBrand.findUniqueOrThrow({ where: { id: a.id } });
    expect(a3.dealUrls).toEqual([`${SITE}/collections/clearance`]);
    expect(a3.promoUrls).toEqual([`${SITE}/admin-chosen`]);
    expect(a3.productUrls).toEqual([PILLOW]);
  });
});
