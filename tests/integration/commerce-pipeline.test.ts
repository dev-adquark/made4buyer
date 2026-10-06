import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { collectCommerceRuns, markStaleOffers, startProductRun } from "@/lib/commerce/pipeline";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

// A local stand-in for the Apify API (runs, run status, dataset items). All data here is SAMPLE data.
type RunState = { status: string; usageTotalUsd?: number; items: unknown[]; statusMessage?: string };
const runs = new Map<string, RunState>();
const requests: Array<{ method: string; path: string; body?: unknown; auth?: string }> = [];
let nextItems: unknown[] = [];
let server: http.Server;
let base = "";
let restore: () => void;
let seq = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://stub");
      requests.push({ method: req.method ?? "GET", path: url.pathname, body: body ? JSON.parse(body) : undefined, auth: req.headers.authorization });
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (req.headers.authorization !== "Bearer test-apify-token") return send(401, { error: { type: "token-not-valid" } });
      let m: RegExpExecArray | null;
      if (req.method === "POST" && (m = /^\/v2\/acts\/([^/]+)\/runs$/.exec(url.pathname))) {
        const id = `run-${++seq}`;
        runs.set(id, { status: "RUNNING", items: nextItems });
        return send(201, { data: { id, status: "RUNNING", defaultDatasetId: `ds-${id}`, actId: decodeURIComponent(m[1]) } });
      }
      if ((m = /^\/v2\/actor-runs\/([^/]+)$/.exec(url.pathname))) {
        const r = runs.get(m[1]);
        if (!r) return send(404, { error: { type: "record-not-found" } });
        return send(200, { data: { id: m[1], status: r.status, defaultDatasetId: `ds-${m[1]}`, finishedAt: r.status === "RUNNING" ? null : "2026-10-06T10:00:00.000Z", statusMessage: r.statusMessage ?? null, usageTotalUsd: r.usageTotalUsd ?? null } });
      }
      if ((m = /^\/v2\/datasets\/ds-([^/]+)\/items$/.exec(url.pathname))) {
        const r = runs.get(m[1]);
        const limit = Number(url.searchParams.get("limit") ?? 1000);
        return send(200, (r?.items ?? []).slice(0, limit));
      }
      send(404, { error: { type: "not-found" } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  restore = withEnv({ APIFY_API_TOKEN: "test-apify-token", APIFY_API_BASE_URL: `${base}/v2`, COMMERCE_APIFY_ACTOR_ID: undefined, COMMERCE_MONTHLY_BUDGET_USD: undefined, PRODUCT_PRICE_MAX_AGE_HOURS: undefined });
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

const EXPRESS_URL = "https://www.breville.com/us/en/products/espresso/bes870.html";
const expressJsonLd = () => {
  const html = readFileSync(path.join(process.cwd(), "fixtures/product-pages/manufacturer-breville-barista-express.html"), "utf8");
  return [JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1])];
};
const item = (over: Record<string, unknown> = {}) => ({
  m4bCommerce: 1,
  url: EXPRESS_URL,
  canonicalUrl: EXPRESS_URL,
  title: "the Barista Express™ | Breville",
  jsonLd: expressJsonLd(),
  meta: { "og:title": "the Barista Express™", "og:type": "product" },
  h1: "the Barista Express™",
  breadcrumbs: ["Home", "Espresso"],
  specTables: [{ name: "Bean Hopper Capacity", value: "250 g" }],
  images: [{ src: "https://www.breville.com/img/bes870.jpg", alt: "Barista Express" }],
  lang: "en-US",
  ...over,
});

const addBrand = () => db.commerceBrand.create({ data: { name: "Breville", slug: "breville", officialDomain: "breville.com", productUrlPatterns: ["https://www.breville.com/us/en/products/**"], crawlFrequencyHours: 24 } });
const addEntity = (name: string, slug: string) => db.productEntity.create({ data: { slug, name, matchKey: slug, brand: "Breville", brandSlug: "breville" } });

/** Starts a run for the brand with the given dataset, marks it SUCCEEDED and collects it. */
async function crawl(brand: Awaited<ReturnType<typeof addBrand>>, items: unknown[], now = new Date(), usage = 0.05) {
  nextItems = items;
  const started = await startProductRun(brand, [EXPRESS_URL], "test");
  expect(started.status).toBe("STARTED");
  runs.get(started.apifyRunId!)!.status = "SUCCEEDED";
  runs.get(started.apifyRunId!)!.usageTotalUsd = usage;
  const collected = await collectCommerceRuns("test", now);
  return { started, collected };
}

describe("commerce product runs", () => {
  it("records a started run with depth-0 input limited to the discovered URLs", async () => {
    const brand = await addBrand();
    const r = await startProductRun(brand, [EXPRESS_URL, `${EXPRESS_URL}?utm_source=x`], "test");
    expect(r.status).toBe("STARTED");
    const post = requests.find((q) => q.method === "POST")!;
    expect(post.path).toBe("/v2/acts/moJRLRc85AitArpNN/runs");
    expect(post.body).toMatchObject({ startUrls: [{ url: EXPRESS_URL }], maxCrawlingDepth: 0, maxPagesPerCrawl: 1, maxConcurrency: 2, respectRobotsTxtFile: true, proxyConfiguration: { useApifyProxy: true }, customData: { brand: "breville" } });
    expect((post.body as { pageFunction: string }).pageFunction).toContain("m4bCommerce");
    const run = await db.commerceRun.findUniqueOrThrow({ where: { id: r.runId } });
    expect(run).toMatchObject({ purpose: "PRODUCT", actorId: "moJRLRc85AitArpNN", apifyRunId: r.apifyRunId, trigger: "test", status: "RUNNING", startUrls: 1, brandId: brand.id });
    // A second start while the first is still running does nothing.
    expect(await startProductRun(brand, [EXPRESS_URL], "test")).toMatchObject({ status: "SKIPPED", code: "ACTIVE_RUN" });
    // Still running: collect only polls.
    expect(await collectCommerceRuns("test")).toMatchObject({ checked: 1, collected: 0 });
  });

  it("stores raw items unchanged, matches exactly and writes facts and an offer with provenance", async () => {
    const brand = await addBrand();
    const entity = await addEntity("Breville Barista Express", "breville-barista-express");
    await db.productFact.create({ data: { productEntityId: entity.id, field: "mpn", value: "BES870XL", source: "REVIEW_SOURCE", sourceName: "Example Reviews", sourceKey: "https://reviews.example.test/x", sourceUrl: "https://reviews.example.test/x", observedAt: new Date(), matchBasis: "review-source" } });
    const raw = item();
    const { collected } = await crawl(brand, [raw]);
    expect(collected).toMatchObject({ collected: 1 });

    const stored = await db.commerceRawRecord.findMany();
    expect(stored).toHaveLength(1);
    expect(stored[0].payload).toEqual(raw);
    expect(stored[0]).toMatchObject({ url: EXPRESS_URL, purpose: "PRODUCT" });
    expect(stored[0].contentHash).toMatch(/^[0-9a-f]{64}$/);

    const product = await db.commerceProduct.findUniqueOrThrow({ where: { canonicalUrl: EXPRESS_URL } });
    expect(product).toMatchObject({ identityStatus: "MATCHED", productEntityId: entity.id, name: "Breville Barista Express", mpn: "BES870XL", gtin: "0021614062161", brandId: brand.id, lastRawId: stored[0].id });
    const log = await db.commerceMatchLog.findMany();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ result: "MATCHED", basis: "mpn", productEntityId: entity.id });

    const price = await db.productFact.findFirstOrThrow({ where: { productEntityId: entity.id, field: "price" } });
    expect(price).toMatchObject({ value: 599.95, unit: "USD", source: "MANUFACTURER", sourceKey: EXPRESS_URL, sourceUrl: EXPRESS_URL, matchBasis: "mpn", confidence: 1, extractionMethod: "apify-web-scraper:json-ld" });
    expect(price.discoveredAt).toBeInstanceOf(Date);
    expect(price.verifiedAt).toBeInstanceOf(Date);
    expect(await db.productFact.findFirst({ where: { productEntityId: entity.id, field: "officialUrl", value: { equals: EXPRESS_URL } } })).not.toBeNull();

    const offers = await db.commerceOffer.findMany();
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ productId: product.id, seller: "Breville USA", sellerType: "MANUFACTURER", destinationUrl: EXPRESS_URL, affiliateUrl: null, affiliateProvider: null, affiliateStatus: "NONE", price: 599.95, listPrice: 749.95, currency: "USD", availability: "InStock", status: "FRESH", sourceRawId: stored[0].id });

    const run = await db.commerceRun.findFirstOrThrow();
    expect(run).toMatchObject({ status: "COLLECTED", pagesProcessed: 1, extracted: 1, accepted: 1, rejected: 0, usageUsd: 0.05 });
    expect(run.collectedAt).toBeInstanceOf(Date);
    expect(run.finishedAt).toBeInstanceOf(Date);
    const b = await db.commerceBrand.findUniqueOrThrow({ where: { id: brand.id } });
    expect(b).toMatchObject({ crawlStatus: "OK", consecutiveFailures: 0 });
    expect(b.nextCrawlAt!.getTime() - b.lastCrawlAt!.getTime()).toBe(24 * 3_600_000);
    // The resolver's snapshot now shows the manufacturer price.
    const e = await db.productEntity.findUniqueOrThrow({ where: { id: entity.id } });
    expect((e.factSummary as { fields: { price: { value: number; source: string } } }).fields.price).toMatchObject({ value: 599.95, source: "MANUFACTURER" });
  });

  it("matches on brand + name with confidence 0.9 when no identifier is known", async () => {
    const brand = await addBrand();
    const entity = await addEntity("Breville Barista Express", "breville-barista-express");
    await crawl(brand, [item()]);
    const f = await db.productFact.findFirstOrThrow({ where: { productEntityId: entity.id, field: "productName" } });
    expect(f).toMatchObject({ matchBasis: "brand+name", confidence: 0.9 });
  });

  it("rejects a variant and an ambiguous match with a logged reason and writes no facts or offers", async () => {
    const brand = await addBrand();
    await addEntity("Breville Barista Pro", "breville-barista-pro");
    await crawl(brand, [item()]);
    let p = await db.commerceProduct.findUniqueOrThrow({ where: { canonicalUrl: EXPRESS_URL } });
    expect(p).toMatchObject({ identityStatus: "MATCH_REJECTED", productEntityId: null });
    expect(p.identityReason).toContain("Barista Pro");
    expect(await db.commerceMatchLog.count({ where: { result: "MATCH_REJECTED" } })).toBe(1);
    expect(await db.productFact.count()).toBe(0);
    expect(await db.commerceOffer.count()).toBe(0);

    // Two Made4Buyers products that both read as this page: ambiguous, never attached.
    await addEntity("Breville Barista Express", "breville-barista-express");
    await addEntity("Breville the Barista Express", "breville-the-barista-express");
    await crawl(brand, [item()]);
    p = await db.commerceProduct.findUniqueOrThrow({ where: { canonicalUrl: EXPRESS_URL } });
    expect(p).toMatchObject({ identityStatus: "MATCH_REJECTED", productEntityId: null });
    expect(p.identityReason).toMatch(/ambiguous: 2/);
    expect(await db.commerceMatchLog.count()).toBe(2);
    expect(await db.productFact.count()).toBe(0);
    expect(await db.commerceOffer.count()).toBe(0);
  });

  it("marks a product UNMATCHED when the brand has no Made4Buyers product, and counts unreadable items", async () => {
    const brand = await addBrand();
    await crawl(brand, [item(), { m4bCommerce: 1, url: "https://www.breville.com/us/en/products/espresso/none.html", jsonLd: [] }]);
    expect(await db.commerceProduct.findUniqueOrThrow({ where: { canonicalUrl: EXPRESS_URL } })).toMatchObject({ identityStatus: "UNMATCHED" });
    const run = await db.commerceRun.findFirstOrThrow();
    expect(run).toMatchObject({ pagesProcessed: 2, extracted: 1, accepted: 0, rejected: 2 });
    expect(JSON.stringify(run.errors)).toContain("NO_PRODUCT");
    expect(await db.commerceRawRecord.count()).toBe(2);
  });

  it("keeps all existing data and backs the brand off when a run fails", async () => {
    const brand = await addBrand();
    const entity = await addEntity("Breville Barista Express", "breville-barista-express");
    await crawl(brand, [item()]);
    const before = { facts: await db.productFact.count(), offers: await db.commerceOffer.findMany(), product: await db.commerceProduct.findFirstOrThrow() };

    const started = await startProductRun((await db.commerceBrand.findUniqueOrThrow({ where: { id: brand.id } })), [EXPRESS_URL], "test");
    runs.get(started.apifyRunId!)!.status = "FAILED";
    runs.get(started.apifyRunId!)!.statusMessage = "crawler crashed";
    const now = new Date();
    const r = await collectCommerceRuns("test", now);
    expect(r.results?.[0]).toMatchObject({ status: "FAILED" });
    expect(await db.commerceRun.findUniqueOrThrow({ where: { id: started.runId } })).toMatchObject({ status: "FAILED" });
    const b = await db.commerceBrand.findUniqueOrThrow({ where: { id: brand.id } });
    expect(b).toMatchObject({ crawlStatus: "FAILED", consecutiveFailures: 1 });
    expect(b.lastError).toContain("crawler crashed");
    expect(b.nextCrawlAt!.getTime() - now.getTime()).toBe(2 * 3_600_000);
    expect(await db.productFact.count()).toBe(before.facts);
    expect(await db.commerceOffer.findMany()).toEqual(before.offers);
    expect(await db.commerceProduct.findFirstOrThrow()).toEqual(before.product);
    expect((await db.productEntity.findUniqueOrThrow({ where: { id: entity.id } })).id).toBe(entity.id);
    // The next failure doubles the backoff.
    const again = await startProductRun(b, [EXPRESS_URL], "test");
    runs.get(again.apifyRunId!)!.status = "TIMED-OUT";
    await collectCommerceRuns("test", now);
    const b2 = await db.commerceBrand.findUniqueOrThrow({ where: { id: brand.id } });
    expect(b2.consecutiveFailures).toBe(2);
    expect(b2.nextCrawlAt!.getTime() - now.getTime()).toBe(4 * 3_600_000);
    // Admin "Retry failed" marks failed runs RETRY_QUEUED: never polled, never blocking a new run.
    await db.commerceRun.updateMany({ where: { status: { in: ["FAILED", "TIMED-OUT"] } }, data: { status: "RETRY_QUEUED" } });
    // Coupon runs belong to the coupon collector and are never touched here.
    await db.commerceRun.create({ data: { purpose: "COUPON", brandId: brand.id, actorId: "moJRLRc85AitArpNN", apifyRunId: "coupon-run-1", trigger: "test", status: "RUNNING" } });
    expect(await collectCommerceRuns("test", now)).toMatchObject({ checked: 0 });
    expect(await db.commerceRun.findUniqueOrThrow({ where: { apifyRunId: "coupon-run-1" } })).toMatchObject({ status: "RUNNING" });
    expect(await startProductRun(b2, [EXPRESS_URL], "test")).toMatchObject({ status: "STARTED" });
  });

  it("skips (and records why) when the monthly budget is spent or the switch is off", async () => {
    const brand = await addBrand();
    await db.commerceRun.create({ data: { purpose: "PRODUCT", brandId: brand.id, actorId: "moJRLRc85AitArpNN", trigger: "test", status: "COLLECTED", usageUsd: 4.01 } });
    const r = await startProductRun(brand, [EXPRESS_URL], "test");
    expect(r).toMatchObject({ status: "SKIPPED", code: "BUDGET_EXHAUSTED" });
    expect(await db.commerceRun.findUniqueOrThrow({ where: { id: r.runId } })).toMatchObject({ status: "SKIPPED", startUrls: 1 });
    expect(JSON.stringify((await db.commerceRun.findUniqueOrThrow({ where: { id: r.runId } })).errors)).toContain("budget");
    expect(requests.filter((q) => q.method === "POST")).toHaveLength(0);

    const env = withEnv({ COMMERCE_MONTHLY_BUDGET_USD: "10" });
    await db.automationSetting.create({ data: { key: "commerce_engine", value: "off" } });
    const off = await startProductRun(brand, [EXPRESS_URL], "test");
    env();
    expect(off).toMatchObject({ status: "SKIPPED", code: "SWITCH_OFF" });
    expect(await db.commerceRun.findUniqueOrThrow({ where: { id: off.runId } })).toMatchObject({ status: "SKIPPED" });
    expect(requests.filter((q) => q.method === "POST")).toHaveLength(0);
  });

  it("skips without a token or without URLs", async () => {
    const brand = await addBrand();
    expect(await startProductRun(brand, [], "test")).toMatchObject({ status: "SKIPPED", code: "NO_URLS" });
    const env = withEnv({ APIFY_API_TOKEN: undefined });
    expect(await startProductRun(brand, [EXPRESS_URL], "test")).toMatchObject({ status: "SKIPPED", code: "APIFY_NOT_CONFIGURED" });
    expect(await collectCommerceRuns("test")).toMatchObject({ status: "BLOCKED_BY_ENVIRONMENT" });
    env();
    expect(await db.commerceRun.count({ where: { status: "SKIPPED" } })).toBe(2);
  });

  it("marks offers stale after 48 hours without deleting them", async () => {
    const brand = await addBrand();
    await addEntity("Breville Barista Express", "breville-barista-express");
    const now = new Date();
    await crawl(brand, [item()], now);
    expect(await markStaleOffers(new Date(now.getTime() + 47 * 3_600_000))).toBe(0);
    expect(await markStaleOffers(new Date(now.getTime() + 49 * 3_600_000))).toBe(1);
    expect(await db.commerceOffer.findFirstOrThrow()).toMatchObject({ status: "STALE", price: 599.95 });
  });

  it("is idempotent: re-collecting creates no duplicate raws, offers or facts", async () => {
    const brand = await addBrand();
    await addEntity("Breville Barista Express", "breville-barista-express");
    const first = new Date("2026-10-06T08:00:00Z");
    const { started } = await crawl(brand, [item()], first);
    const counts = async () => ({ raws: await db.commerceRawRecord.count(), offers: await db.commerceOffer.count(), facts: await db.productFact.count(), products: await db.commerceProduct.count() });
    const before = await counts();
    expect(await collectCommerceRuns("test")).toMatchObject({ checked: 0, collected: 0 });
    // Force a re-collect of the same run.
    await db.commerceRun.update({ where: { id: started.runId }, data: { status: "SUCCEEDED" } });
    const later = new Date("2026-10-06T09:00:00Z");
    expect(await collectCommerceRuns("test", later)).toMatchObject({ collected: 1 });
    expect(await counts()).toEqual(before);
    const f = await db.productFact.findFirstOrThrow({ where: { field: "price" } });
    expect(f.discoveredAt!.toISOString()).toBe(first.toISOString());
    expect(f.verifiedAt!.toISOString()).toBe(later.toISOString());
  });

  it("keeps a previous value when the page no longer states it", async () => {
    const brand = await addBrand();
    await crawl(brand, [item()]);
    const ld = expressJsonLd() as Array<Record<string, unknown>>;
    delete ld[0].gtin13;
    delete ld[0].color;
    await crawl(await db.commerceBrand.findUniqueOrThrow({ where: { id: brand.id } }), [item({ jsonLd: ld })]);
    const p = await db.commerceProduct.findUniqueOrThrow({ where: { canonicalUrl: EXPRESS_URL } });
    expect(p.gtin).toBe("0021614062161");
    const data = p.data as { product: Record<string, unknown>; preservedFields: string[] };
    expect(data.product.color).toBe("Brushed Stainless Steel");
    expect(data.preservedFields.sort()).toEqual(["color", "gtin"]);
    expect(await db.commerceRawRecord.count()).toBe(2); // one per run, both unchanged
  });
});

describe("live-sample regressions", () => {
  it("an official-site page without a stated brand is that brand's product; non-USD offers are not written for a US brand", async () => {
    const brand = await addBrand();
    await addEntity("Breville Barista Express", "breville-barista-express");
    const ld = expressJsonLd()[0] as Record<string, unknown>;
    delete ld.brand;
    const offers = ([] as unknown[]).concat(ld.offers ?? []).map((o) => ({ ...(o as Record<string, unknown>), priceCurrency: "EUR" }));
    const { collected } = await crawl(brand, [item({ jsonLd: [{ ...ld, offers }] })]);
    expect(collected).toMatchObject({ collected: 1 });
    expect(await db.commerceProduct.findFirstOrThrow()).toMatchObject({ identityStatus: "MATCHED" });
    expect(await db.commerceOffer.count()).toBe(0);
  });
});
