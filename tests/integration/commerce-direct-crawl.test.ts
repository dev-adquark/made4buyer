import dns from "node:dns";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { runIngestion } from "@/lib/pipeline/ingest";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

/**
 * The direct-crawl path (lib/commerce/direct-crawl.ts, runDirectBrandCrawl/runCommerceDirectCrawl in
 * lib/commerce/pipeline.ts): no Apify at all. A local "official brand site" stub stands in for the
 * real brand domain (DNS redirected for this test process only); the test asserts the same product/
 * offer rows a successful Apify run would produce, using the real HTTP-fetch + HTML-parse code.
 *
 * Sitemap discovery (which URLs to fetch) is mocked exactly as tests/integration/commerce-scenarios.
 * test.ts does: it is a separate, already-provider-independent step (covered by tests/unit/commerce-
 * discovery.test.ts) and its own robots.txt pre-filter (lib/commerce/deal-crawl.ts) talks to the
 * brand's bare domain with no port, which a random-port test stub cannot stand in for. What this file
 * tests is everything downstream of "here is a URL to fetch": direct-crawl's own robots.txt check
 * (lib/pipeline/apify.ts checkRobots, which does use the URL's real origin/port), the HTML fetch and
 * parse, and the normalize → match → offer pipeline.
 */
const discovered: { urls: string[] } = { urls: [] };
vi.mock("@/lib/commerce/discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/commerce/discovery")>()),
  discoverProductUrls: async () => ({ status: "OK", urls: [...discovered.urls] }),
}));

const { runCommerceDirectCrawl, runDirectBrandCrawl } = await import("@/lib/commerce/pipeline");

const BRAND_HOST = "direct.example.test";
type Page = { status?: number; html?: string; json?: unknown };
const pages = new Map<string, Page>();

let server: http.Server;
let port = 0;
let restoreEnv: () => void;
const site = () => `http://${BRAND_HOST}:${port}`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    if (url.pathname === "/robots.txt" && !pages.has("/robots.txt")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("User-agent: *\nAllow: /\n");
    }
    const p = pages.get(url.pathname);
    if (!p) {
      res.writeHead(404);
      return res.end();
    }
    if (p.json !== undefined) {
      res.writeHead(p.status ?? 200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(p.json));
    }
    res.writeHead(p.status ?? 200, { "Content-Type": "text/html" });
    res.end(p.html ?? "");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;

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
    COMMERCE_BRANDS_PER_RUN: undefined,
    COMMERCE_MONTHLY_BUDGET_USD: undefined,
    CONTENT_API_URL: undefined,
    AUTO_PUBLISH_ENABLED: undefined,
    AFFILIATE_PROVIDER: undefined,
    PRODUCT_PRICE_MAX_AGE_HOURS: undefined,
  });
});

afterAll(async () => {
  restoreEnv();
  vi.restoreAllMocks();
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  await resetDb();
  pages.clear();
  discovered.urls = [];
});

let seq = 0;

/** A published review of "Laptop 13" (creates the ProductEntity the pipeline matches against) and a brand. discovered.urls (set per test) names the page(s) to fetch. */
async function seedReviewAndBrand() {
  const id = `direct-${++seq}`;
  await runIngestion({
    trigger: "test",
    source: "apify:example",
    items: [{ id, title: "Laptop 13 review", body: "A repairable, upgradeable laptop tested for two weeks of daily work and travel.".repeat(5), summary: "A laptop.", url: `https://reviews.example.test/reviews/${id}`, productName: "Laptop 13", brand: "Direct", category: "laptops", publishedAt: new Date(Date.now() - 86_400_000).toISOString() }],
  });
  const review = await db.normalizedReview.findFirstOrThrow({ where: { sourceId: id } });
  const brand = await db.commerceBrand.create({ data: { name: "Direct", slug: `direct-${seq}`, officialDomain: BRAND_HOST, categories: ["laptops"], maxProductsPerRun: 5, crawlFrequencyHours: 24 } });
  return { review, brand };
}

describe("direct crawl: no Apify, a plain HTTP fetch per page", () => {
  it("reads a JSON-LD product page and creates a matched, fresh offer", async () => {
    const { review, brand } = await seedReviewAndBrand();
    discovered.urls = [`${site()}/products/laptop13`];
    const jsonLd = { "@context": "https://schema.org", "@type": "Product", name: "Laptop 13", sku: "LAP13", offers: { "@type": "Offer", price: "899.00", priceCurrency: "USD", availability: "https://schema.org/InStock" } };
    pages.set("/products/laptop13", { html: `<!doctype html><html><head><title>Laptop 13</title><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head><body><h1>Laptop 13</h1></body></html>` });

    const r = await runDirectBrandCrawl(brand, "test");
    expect(r).toMatchObject({ status: "OK", brand: brand.slug, pages: 1, extracted: 1, accepted: 1, rejected: 0 });

    const run = await db.commerceRun.findFirstOrThrow({ where: { brandId: brand.id } });
    expect(run).toMatchObject({ actorId: "direct-fetch", status: "COLLECTED", apifyRunId: null, usageUsd: null, purpose: "PRODUCT" });

    const offer = await db.commerceOffer.findFirstOrThrow({ where: { product: { brandId: brand.id } } });
    expect(offer).toMatchObject({ price: 899, currency: "USD", status: "FRESH", availability: "InStock" });

    const updated = await db.normalizedReview.findUniqueOrThrow({ where: { id: review.id } });
    expect(updated.dealStatus).not.toBe("NO_DEAL"); // a verified offer now exists for the reviewed product
  });

  it("reads a Shopify product's same-origin .js JSON directly, with its compare-at price as the list price", async () => {
    const { brand } = await seedReviewAndBrand();
    discovered.urls = [`${site()}/products/laptop13`];
    pages.set("/products/laptop13", {
      html:
        `<!doctype html><html><head><title>Laptop 13</title>` +
        `<script src="https://cdn.shopify.com/s/files/1/0001/theme.js"></script>` +
        `<script>var Shopify = Shopify || {}; Shopify.currency = {"active":"USD","rate":"1.0"};</script>` +
        `</head><body><h1>Laptop 13</h1></body></html>`,
    });
    pages.set("/products/laptop13.js", { json: { title: "Laptop 13", variants: [{ id: 123, sku: "LAP13", price: 89900, compare_at_price: 99900, available: true }] } });

    const r = await runDirectBrandCrawl(brand, "test");
    expect(r).toMatchObject({ status: "OK", extracted: 1, accepted: 1 });
    const offer = await db.commerceOffer.findFirstOrThrow({ where: { product: { brandId: brand.id } } });
    expect(offer).toMatchObject({ price: 899, listPrice: 999, currency: "USD" });
  });

  it("respects robots.txt: a disallowed path is never fetched, and the run records why", async () => {
    pages.set("/robots.txt", { html: "User-agent: *\nDisallow: /private\n" });
    const { brand } = await seedReviewAndBrand();
    discovered.urls = [`${site()}/private/laptop13`];
    pages.set("/private/laptop13", { html: `<!doctype html><title>should not be read</title>` });
    const r = await runDirectBrandCrawl(brand, "test");
    expect(r).toMatchObject({ status: "OK", pages: 0, extracted: 0, accepted: 0 });
    const run = await db.commerceRun.findFirstOrThrow({ where: { brandId: brand.id } });
    expect(JSON.stringify(run.errors)).toContain("ROBOTS_DISALLOWED");
    expect(await db.commerceOffer.count()).toBe(0);
  });

  it("commerce-direct-crawl: processes every due brand, no Apify token needed anywhere", async () => {
    const restore = withEnv({ APIFY_API_TOKEN: undefined });
    try {
      const { brand } = await seedReviewAndBrand();
      discovered.urls = [`${site()}/products/laptop13`];
      pages.set("/products/laptop13", { html: `<!doctype html><title>Laptop 13</title><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "Laptop 13", sku: "LAP13", offers: { "@type": "Offer", price: "799.00", priceCurrency: "USD" } })}</script><h1>Laptop 13</h1>` });
      const r = await runCommerceDirectCrawl("test");
      expect(r).toMatchObject({ status: "OK", started: 1 });
      expect(await db.commerceOffer.count({ where: { product: { brandId: brand.id } } })).toBe(1);
    } finally {
      restore();
    }
  });
});
