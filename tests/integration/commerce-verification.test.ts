import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { collectCouponRuns } from "@/lib/commerce/coupons-run";
import { markExpiredCoupons, verifiedCouponsFor } from "@/lib/commerce/coupons";
import { runLinkValidation } from "@/lib/commerce/link-check";
import { runOfficialVerify } from "@/lib/commerce/official";
import { collectCommerceRuns, startProductRun } from "@/lib/commerce/pipeline";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

// Local stand-ins for the Apify API and a merchant site. All data here is SAMPLE data.
type RunState = { status: string; items: unknown[] };
const runs = new Map<string, RunState>();
const siteHits: string[] = [];
let nextItems: unknown[] = [];
let server: http.Server;
let base = "";
let restore: () => void;
let seq = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    };
    // Merchant site
    if (url.pathname.startsWith("/site/") || url.pathname === "/robots.txt") {
      siteHits.push(url.pathname);
      if (url.pathname === "/robots.txt") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end("User-agent: *\nDisallow: /site/private\n");
      }
      if (url.pathname === "/site/ok") return void (res.writeHead(200), res.end());
      if (url.pathname === "/site/gone") return void (res.writeHead(301, { Location: "/" }), res.end());
      if (url.pathname === "/site/down") return void (res.writeHead(503), res.end());
      return void (res.writeHead(404), res.end());
    }
    // Apify API
    let m: RegExpExecArray | null;
    if (req.method === "POST" && /^\/v2\/acts\/[^/]+\/runs$/.test(url.pathname)) {
      const id = `run-${++seq}`;
      runs.set(id, { status: "SUCCEEDED", items: nextItems });
      return send(201, { data: { id, status: "RUNNING", defaultDatasetId: `ds-${id}` } });
    }
    if ((m = /^\/v2\/actor-runs\/([^/]+)$/.exec(url.pathname))) {
      const r = runs.get(m[1]);
      return r ? send(200, { data: { id: m[1], status: r.status, defaultDatasetId: `ds-${m[1]}`, finishedAt: "2026-10-06T10:00:00.000Z", usageTotalUsd: 0.01 } }) : send(404, {});
    }
    if ((m = /^\/v2\/datasets\/ds-([^/]+)\/items$/.exec(url.pathname))) return send(200, runs.get(m[1])?.items ?? []);
    send(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  restore = withEnv({ APIFY_API_TOKEN: "test-apify-token", APIFY_API_BASE_URL: `${base}/v2`, COMMERCE_APIFY_ACTOR_ID: undefined, COMMERCE_MONTHLY_BUDGET_USD: "100", PRODUCT_PRICE_MAX_AGE_HOURS: undefined, COMMERCE_LINK_CHECK_DELAY_MS: "0", COMMERCE_COUPON_MAX_AGE_DAYS: undefined });
});
afterAll(async () => {
  restore();
  await new Promise((r) => server.close(r));
});
beforeEach(async () => {
  await resetDb();
  runs.clear();
  siteHits.length = 0;
  nextItems = [];
});

const EXPRESS_URL = "https://www.breville.com/us/en/products/espresso/bes870.html";
type JsonLd = { offers: Record<string, unknown>; [k: string]: unknown };
const expressJsonLd = (): JsonLd => {
  const html = readFileSync(path.join(process.cwd(), "fixtures/product-pages/manufacturer-breville-barista-express.html"), "utf8");
  return JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]) as JsonLd;
};
const item = (mutate?: (ld: JsonLd) => void) => {
  const ld = expressJsonLd();
  mutate?.(ld);
  return { m4bCommerce: 1, url: EXPRESS_URL, canonicalUrl: EXPRESS_URL, title: "the Barista Express™ | Breville", jsonLd: [ld], meta: { "og:type": "product" }, h1: "the Barista Express™", breadcrumbs: [], specTables: [], images: [], lang: "en-US" };
};
const addBrand = (over: Record<string, unknown> = {}) => db.commerceBrand.create({ data: { name: "Breville", slug: "breville", officialDomain: "breville.com", crawlFrequencyHours: 24, ...over } });
const addEntity = (name: string, slug: string, brand = "Breville") => db.productEntity.create({ data: { slug, name, matchKey: slug, brand, brandSlug: brand.toLowerCase() } });
const mpnFact = (entityId: string) => db.productFact.create({ data: { productEntityId: entityId, field: "mpn", value: "BES870XL", source: "REVIEW_SOURCE", sourceName: "Example Reviews", sourceKey: "https://reviews.example.test/x", sourceUrl: "https://reviews.example.test/x", observedAt: new Date(), matchBasis: "review-source" } });

async function crawl(items: unknown[], now = new Date()) {
  const brand = await db.commerceBrand.findFirstOrThrow();
  nextItems = items;
  const started = await startProductRun(brand, [EXPRESS_URL], "test");
  expect(started.status).toBe("STARTED");
  return collectCommerceRuns("test", now);
}
const audits = (action: string) => db.auditLog.findMany({ where: { action }, orderBy: { createdAt: "asc" } });

describe("official-source verification", () => {
  it("VERIFIED only from an exact match on the brand's official domain (set inline by collect)", async () => {
    await addBrand();
    const e = await addEntity("Breville Barista Express", "breville-barista-express");
    const r = await crawl([item()]);
    expect(r).toMatchObject({ collected: 1, official: { VERIFIED: 1 } });
    const row = await db.productEntity.findUniqueOrThrow({ where: { id: e.id } });
    const product = await db.commerceProduct.findUniqueOrThrow({ where: { canonicalUrl: EXPRESS_URL } });
    expect(row).toMatchObject({ officialStatus: "VERIFIED", officialUrl: EXPRESS_URL });
    expect(row.officialVerifiedAt?.getTime()).toBe(product.observedAt.getTime());
  });

  it("never VERIFIED from a matched page that is not on the official domain", async () => {
    await addBrand({ officialDomain: "breville-official.example" });
    const e = await addEntity("Breville Barista Express", "breville-barista-express");
    await crawl([item()]);
    // The page (breville.com, a known manufacturer host) matched, but it is not this brand's configured official domain.
    expect((await db.productEntity.findUniqueOrThrow({ where: { id: e.id } })).officialStatus).not.toBe("VERIFIED");
  });

  it("MISMATCH when the official page is a different variant; NOT_FOUND for other products of a crawled brand; null when the brand is not crawled", async () => {
    await addBrand();
    const pro = await addEntity("Breville Barista Pro", "breville-barista-pro");
    const oracle = await addEntity("Breville Oracle Touch", "breville-oracle-touch");
    const other = await addEntity("Sage Bambino", "sage-bambino", "Sage");
    await db.commerceBrand.create({ data: { name: "Sage", slug: "sage", officialDomain: "sageappliances.com" } });
    await crawl([item()]);
    expect(await db.commerceProduct.findUniqueOrThrow({ where: { canonicalUrl: EXPRESS_URL } })).toMatchObject({ identityStatus: "MATCH_REJECTED", productEntityId: null });
    expect((await db.productEntity.findUniqueOrThrow({ where: { id: pro.id } })).officialStatus).toBe("MISMATCH");

    const job = await runOfficialVerify("test");
    expect(job).toMatchObject({ status: "OK" });
    expect((await db.productEntity.findUniqueOrThrow({ where: { id: pro.id } })).officialStatus).toBe("MISMATCH");
    expect((await db.productEntity.findUniqueOrThrow({ where: { id: oracle.id } })).officialStatus).toBe("NOT_FOUND");
    expect((await db.productEntity.findUniqueOrThrow({ where: { id: other.id } })).officialStatus).toBeNull();
    // One OFFICIAL_VERIFICATION event per status change; re-running changes nothing.
    expect(await db.auditLog.count({ where: { action: "OFFICIAL_VERIFICATION" } })).toBe(2);
    await runOfficialVerify("test");
    expect(await db.auditLog.count({ where: { action: "OFFICIAL_VERIFICATION" } })).toBe(2);
  });
});

describe("field conflicts", () => {
  it("equal top-authority sources that disagree → CONFLICTING, not displayed, one SOURCE_CONFLICT event; a newer retailer never overrides the manufacturer", async () => {
    await addBrand();
    const e = await addEntity("Breville Barista Express", "breville-barista-express");
    await mpnFact(e.id);
    const now = new Date();
    await db.productFact.create({ data: { productEntityId: e.id, field: "warranty", value: "2 Year Limited Warranty", source: "MANUFACTURER", sourceName: "breville.com", sourceKey: "https://www.breville.com/us/en/support/warranty.html", sourceUrl: "https://www.breville.com/us/en/support/warranty.html", observedAt: now, matchBasis: "mpn" } });
    await db.productFact.create({ data: { productEntityId: e.id, field: "price", value: 549.99, unit: "USD", source: "RETAILER", sourceName: "shop.example", sourceKey: "https://shop.example/bes870", sourceUrl: "https://shop.example/bes870", observedAt: new Date(now.getTime() + 60_000), matchBasis: "mpn" } });
    await crawl([item()], now);
    type Summary = { fields: Record<string, { status: string; value: unknown }> };
    let s = (await db.productEntity.findUniqueOrThrow({ where: { id: e.id } })).factSummary as Summary;
    expect(s.fields.warranty).toMatchObject({ status: "CONFLICTING", value: null });
    expect(s.fields.price).toMatchObject({ status: "VERIFIED", value: 599.95 });
    const events = await audits("SOURCE_CONFLICT");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: "system", entityType: "product_entity", entityId: e.id });
    expect((events[0].metadata as { fields: string[] }).fields).toEqual(["warranty"]);
    // Same observation again: still conflicting, no new event.
    await crawl([item()], now);
    s = (await db.productEntity.findUniqueOrThrow({ where: { id: e.id } })).factSummary as Summary;
    expect(s.fields.warranty.status).toBe("CONFLICTING");
    expect(await db.auditLog.count({ where: { action: "SOURCE_CONFLICT" } })).toBe(1);
  });
});

describe("audit events (one per real change)", () => {
  it("product, price, run and rejected-price events are written once per change", async () => {
    await addBrand();
    await addEntity("Breville Barista Express", "breville-barista-express");
    await crawl([item()]);
    await crawl([item()]);
    expect(await db.auditLog.count({ where: { action: "PRODUCT_CREATED" } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "PRODUCT_UPDATED" } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: "PRICE_UPDATED" } })).toBe(1); // the offer's first price
    expect(await db.auditLog.count({ where: { action: "APIFY_RUN_COMPLETED" } })).toBe(2); // two runs
    expect(await db.auditLog.count({ where: { action: "OFFICIAL_VERIFICATION" } })).toBe(1);

    await crawl([item((ld) => (ld.offers.price = "549.95"))]);
    const price = await audits("PRICE_UPDATED");
    expect(price).toHaveLength(2);
    expect(price[1]).toMatchObject({ actor: "system", entityType: "commerce_offer", before: { price: 599.95, currency: "USD" }, after: { price: 549.95, currency: "USD" } });

    // A non-USD offer for a US brand is rejected (no offer written) and logged once however often it is seen.
    const cad = (ld: JsonLd) => (ld.offers = { ...ld.offers, url: `${EXPRESS_URL}?country=ca`, priceCurrency: "CAD", price: "799.99" });
    const offersBefore = await db.commerceOffer.count();
    await crawl([item((ld) => cad(ld))]);
    await crawl([item((ld) => cad(ld))]);
    expect(await db.commerceOffer.count()).toBe(offersBefore);
    const rejected = await audits("PRICE_REJECTED");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].metadata).toMatchObject({ currency: "CAD", price: 799.99 });
  });

  it("PRODUCT_UPDATED when the identity decision changes; APIFY_RUN_FAILED for a failed run", async () => {
    await addBrand();
    await crawl([item()]); // no Made4Buyers product yet: UNMATCHED
    await addEntity("Breville Barista Express", "breville-barista-express");
    await crawl([item()]);
    const updated = await audits("PRODUCT_UPDATED");
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ before: { identityStatus: "UNMATCHED" }, after: { identityStatus: "MATCHED" } });

    const brand = await db.commerceBrand.findFirstOrThrow();
    const started = await startProductRun(brand, [EXPRESS_URL], "test");
    runs.get(started.apifyRunId!)!.status = "FAILED";
    await collectCommerceRuns("test");
    await collectCommerceRuns("test");
    expect(await db.auditLog.count({ where: { action: "APIFY_RUN_FAILED" } })).toBe(1);
  });

  it("link checks: LINK_REJECTED / LINK_VALIDATED only on status change; robots-blocked URLs are never fetched", async () => {
    await addBrand();
    const p = await db.commerceProduct.create({ data: { canonicalUrl: `${base}/site/ok`, name: "Sample", observedAt: new Date() } });
    const mk = (u: string, status = "FRESH") => db.commerceOffer.create({ data: { productId: p.id, seller: "Sample", sellerType: "MANUFACTURER", destinationUrl: `${base}${u}`, observedAt: new Date(), status } });
    const ok = await mk("/site/ok");
    const gone = await mk("/site/gone");
    const down = await mk("/site/down", "STALE");
    const priv = await mk("/site/private/item");
    const t0 = new Date();
    const r1 = await runLinkValidation("test", t0);
    expect(r1).toMatchObject({ status: "OK", checked: 4 });
    const get = (id: string) => db.commerceOffer.findUniqueOrThrow({ where: { id } });
    expect(await get(ok.id)).toMatchObject({ linkStatus: "OK", linkHttpStatus: 200 });
    expect(await get(gone.id)).toMatchObject({ linkStatus: "BROKEN" });
    expect(await get(down.id)).toMatchObject({ linkStatus: "UNCHECKED", linkHttpStatus: 503 }); // first failure keeps status
    expect(await get(priv.id)).toMatchObject({ linkStatus: "BLOCKED" });
    expect(siteHits).not.toContain("/site/private/item");
    expect(siteHits.filter((h) => h === "/robots.txt")).toHaveLength(1); // cached per site within a run

    // Within 24 h nothing is due.
    expect(await runLinkValidation("test", new Date(t0.getTime() + 3_600_000))).toMatchObject({ due: 0 });
    // Next day: the 503 again → UNREACHABLE; the others are unchanged and write no new events.
    await runLinkValidation("test", new Date(t0.getTime() + 25 * 3_600_000));
    expect(await get(down.id)).toMatchObject({ linkStatus: "UNREACHABLE" });
    expect(await db.auditLog.count({ where: { action: "LINK_VALIDATED" } })).toBe(2); // ok + private (BLOCKED)
    expect(await db.auditLog.count({ where: { action: "LINK_REJECTED" } })).toBe(2); // gone + down
    expect(await db.commerceOffer.count()).toBe(4); // never deleted
  });
});

describe("coupons drop out when expired or not re-verified", () => {
  const coupon = (over: Record<string, unknown>) =>
    db.commerceCoupon.create({ data: { merchant: "Breville", code: "SAMPLE10", sourceUrl: "https://www.breville.com/us/en/offers", status: "VERIFIED", observedAt: new Date(), lastVerifiedAt: new Date(), ...over } });

  it("a VERIFIED code not re-seen within COMMERCE_COUPON_MAX_AGE_DAYS is no longer public", async () => {
    const brand = await addBrand();
    const now = new Date();
    await coupon({ brandId: brand.id, code: "RECENT10", lastVerifiedAt: new Date(now.getTime() - 2 * 86_400_000) });
    await coupon({ brandId: brand.id, code: "OLDCODE10", lastVerifiedAt: new Date(now.getTime() - 10 * 86_400_000) });
    expect((await verifiedCouponsFor({ brandId: brand.id }, now)).map((c) => c.code)).toEqual(["RECENT10"]);
    const env = withEnv({ COMMERCE_COUPON_MAX_AGE_DAYS: "14" });
    expect((await verifiedCouponsFor({ brandId: brand.id }, now)).map((c) => c.code).sort()).toEqual(["OLDCODE10", "RECENT10"]);
    env();
  });

  it("expired codes become EXPIRED on every collect (even without Apify), with one COUPON_EXPIRED event", async () => {
    const brand = await addBrand();
    const past = new Date(Date.now() - 86_400_000);
    const c = await coupon({ brandId: brand.id, code: "ENDED10", expiresAt: past });
    expect(await verifiedCouponsFor({ brandId: brand.id })).toHaveLength(0); // never shown once past its stated end
    const env = withEnv({ APIFY_API_TOKEN: undefined });
    const r = await collectCouponRuns("test");
    env();
    expect(r).toMatchObject({ status: "BLOCKED_BY_ENVIRONMENT", expired: 1 });
    expect(await db.commerceCoupon.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: "EXPIRED" });
    expect(await markExpiredCoupons()).toBe(0);
    await collectCouponRuns("test");
    const events = await audits("COUPON_EXPIRED");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: "system", entityType: "commerce_coupon", entityId: c.id, before: { status: "VERIFIED" }, after: { status: "EXPIRED" } });
  });
});

describe("duplicate protection", () => {
  it("tracking variants of one destination share one offer row", async () => {
    await addBrand();
    await addEntity("Breville Barista Express", "breville-barista-express");
    await crawl([item((ld) => (ld.offers.url = `${EXPRESS_URL}?utm_source=newsletter&utm_campaign=x#buy`))]);
    await crawl([item((ld) => (ld.offers.url = `${EXPRESS_URL}?gclid=abc123`))]);
    await crawl([item((ld) => (ld.offers.url = `${EXPRESS_URL}?fbclid=zzz`))]);
    const offers = await db.commerceOffer.findMany();
    expect(offers).toHaveLength(1);
    expect(offers[0].destinationUrl).toBe(EXPRESS_URL);
  });

  it("the database rejects duplicate products, offers, coupons and raw records", async () => {
    const brand = await addBrand();
    const p = await db.commerceProduct.create({ data: { canonicalUrl: EXPRESS_URL, name: "Sample", observedAt: new Date() } });
    await expect(db.commerceProduct.create({ data: { canonicalUrl: EXPRESS_URL, name: "Sample", observedAt: new Date() } })).rejects.toMatchObject({ code: "P2002" });
    const offer = { productId: p.id, seller: "Sample", sellerType: "MANUFACTURER", destinationUrl: EXPRESS_URL, observedAt: new Date() };
    await db.commerceOffer.create({ data: offer });
    await expect(db.commerceOffer.create({ data: offer })).rejects.toMatchObject({ code: "P2002" });
    const c = { brandId: brand.id, merchant: "Breville", code: "SAMPLE10", sourceUrl: "https://www.breville.com/us/en/offers", observedAt: new Date() };
    await db.commerceCoupon.create({ data: c });
    await expect(db.commerceCoupon.create({ data: c })).rejects.toMatchObject({ code: "P2002" });
    const run = await db.commerceRun.create({ data: { purpose: "PRODUCT", actorId: "x", trigger: "test", status: "COLLECTED" } });
    const raw = { runId: run.id, url: EXPRESS_URL, purpose: "PRODUCT", payload: {}, contentHash: "0" };
    await db.commerceRawRecord.create({ data: raw });
    await expect(db.commerceRawRecord.create({ data: raw })).rejects.toMatchObject({ code: "P2002" });
  });
});
