import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifiedCouponsFor } from "@/lib/commerce/coupons";
import { feedicoSourceUrl, feedicoUsage, merchantName, runFeedicoSync } from "@/lib/commerce/feedico";
import { loadPromoCodes } from "@/lib/public/deals";
import { db } from "@/lib/db";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

/**
 * Local node:http stand-in for Feedico's POST /api/v1/catalog/coupons (SAMPLE data, never the real
 * API). `mode` switches the answer; every request is recorded (auth header, body).
 */
type Mode = "ok" | "401" | "429" | "500" | "malformed";
type Stub = { base: string; mode: Mode; catalog: unknown[]; requests: Array<{ auth?: string; body: Record<string, unknown> }>; close: () => Promise<void> };
const KEY = "fdco_testkey_0123456789";

async function startStub(): Promise<Stub> {
  const stub: Stub = { base: "", mode: "ok", catalog: [], requests: [], close: async () => undefined };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(typeof body === "string" ? body : JSON.stringify(body));
      };
      if (req.method !== "POST" || req.url !== "/api/v1/catalog/coupons") return send(404, { ok: false });
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      stub.requests.push({ auth: req.headers.authorization, body });
      if (req.headers.authorization !== `Bearer ${KEY}` || stub.mode === "401") return send(401, { ok: false, error: "unauthorized" });
      if (stub.mode === "429") return send(429, { ok: false, error: "monthly_api_limit", used: 1000, limit: 1000 });
      if (stub.mode === "500") return send(500, { ok: false });
      if (stub.mode === "malformed") return send(200, { ok: true, data: [] });
      // The whole coded-coupon catalogue, paged like Feedico (page, pageSize ≤ 200).
      const page = Number(body.page ?? 1);
      const size = Number(body.pageSize ?? 50);
      send(200, { ok: true, recordCount: stub.catalog.length, page, pageSize: size, availableProviders: ["cj_affiliate"], coupons: stub.catalog.slice((page - 1) * size, page * size) });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  stub.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.close = () => new Promise((r) => server.close(() => r()));
  return stub;
}

let stub: Stub;
let restore: () => void;
beforeAll(async () => {
  stub = await startStub();
  restore = withEnv({ FEEDICO_API_KEY: KEY, FEEDICO_API_BASE_URL: stub.base, UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: "true", FEEDICO_MONTHLY_REQUEST_BUDGET: undefined, FEEDICO_MIN_REFETCH_HOURS: undefined, FEEDICO_MAX_FEED_AGE_DAYS: undefined, FEEDICO_BRANDS_PER_RUN: undefined, FEEDICO_MAX_CATALOG_PAGES: undefined });
});
afterAll(async () => {
  restore();
  await stub.close();
});
beforeEach(async () => {
  await resetDb();
  await db.automationSetting.deleteMany({ where: { key: "feedico:state" } });
  stub.mode = "ok";
  stub.catalog = [];
  stub.requests.length = 0;
});

const row = (over: Record<string, unknown> = {}) => ({ id: "coupon_1", brandName: "Acme CJ Affiliate Program", provider: "cj_affiliate", code: "SAVE20", title: "20% off sitewide", description: null, startsAt: null, endsAt: null, merchantWebsiteUrl: "https://www.acme.com", fetchedAt: new Date().toISOString(), ...over });
const addBrand = (name = "Acme", domain = "acme.com") => db.commerceBrand.create({ data: { name, slug: name.toLowerCase(), officialDomain: domain, enabled: true } });
const feedRows = (brandId: string) => db.commerceCoupon.findMany({ where: { brandId, sourceUrl: { contains: "/api/v1/catalog/coupons" } }, orderBy: { code: "asc" } });
const day = 86_400_000;

describe("Feedico coupon feed: the whole catalogue", () => {
  it("is blocked without FEEDICO_API_KEY and makes no request", async () => {
    const off = withEnv({ FEEDICO_API_KEY: undefined });
    expect(await runFeedicoSync("test")).toMatchObject({ status: "BLOCKED_BY_ENVIRONMENT" });
    off();
    expect(stub.requests).toHaveLength(0);
  });

  it("stores and publishes every merchant's current codes: registry brands under the brand, others under their own name", async () => {
    const brand = await addBrand();
    stub.catalog = [
      row(),
      row({ id: "c3", code: "FREESHIP", title: "Free shipping on orders" }),
      row({ id: "b1", brandName: "Banggood CJ Affiliate Program", code: "BGACCES5", title: "5% OFF for Electronic Accessories", merchantWebsiteUrl: "https://www.banggood.com" }),
      row({ id: "u1", brandName: "Acme UK Affiliate Program", code: "UKSAVE60", title: "save £60", merchantWebsiteUrl: "https://uk.acme.com" }),
      row({ id: "x1", brandName: "No Site", code: "NOSITE10", merchantWebsiteUrl: null }),
    ];
    const r = await runFeedicoSync("test");
    expect(r).toMatchObject({ status: "OK", requests: 1, recordCount: 5, pages: 1, complete: true, fetchedRows: 5, coupons: 4, dropped: 1 });
    expect(stub.requests[0]).toMatchObject({ auth: `Bearer ${KEY}`, body: { page: 1, pageSize: 200 } });
    expect(stub.requests[0].body.firmName).toBeUndefined();
    // A registry brand's codes (including its UK storefront) are its own; other merchants keep their name.
    expect((await feedRows(brand.id)).map((c) => c.code)).toEqual(["FREESHIP", "SAVE20", "UKSAVE60"]);
    expect(await db.commerceCoupon.findFirst({ where: { code: "BGACCES5" } })).toMatchObject({ brandId: null, merchant: "Banggood", status: "UNVERIFIED", merchantUrl: "https://www.banggood.com" });
    const shown = await loadPromoCodes();
    expect(shown.map((c) => [c.brandName, c.code]).sort()).toEqual([["Acme", "FREESHIP"], ["Acme", "SAVE20"], ["Acme", "UKSAVE60"], ["Banggood", "BGACCES5"]]);
    expect(shown.find((c) => c.code === "BGACCES5")).toMatchObject({ viaFeed: true, useUrl: "https://www.banggood.com/", sourceUrl: null });
    expect((await verifiedCouponsFor({ brandId: brand.id })).map((c) => c.code).sort()).toEqual(["FREESHIP", "SAVE20", "UKSAVE60"]);
    const raw = await db.commerceRawRecord.findFirst({ where: { url: { contains: "/api/v1/catalog/coupons?page=1" } } });
    expect(JSON.stringify(raw?.payload)).not.toContain(KEY);
    const source = await db.commerceSource.findUnique({ where: { slug: "feedico" } });
    expect(source).toMatchObject({ kind: "COUPON_FEED", enabled: true, termsStatus: "APPROVED", crawlStatus: "OK", consecutiveFailures: 0 });
  });

  it("reads every page of the catalogue (200 per page), one request each", async () => {
    stub.catalog = Array.from({ length: 450 }, (_, i) => row({ id: `c${i}`, brandName: `Shop ${i}`, code: `CODE${1000 + i}`, merchantWebsiteUrl: `https://shop${i}.com` }));
    const r = await runFeedicoSync("test");
    expect(r).toMatchObject({ status: "OK", requests: 3, pages: 3, complete: true, fetchedRows: 450, coupons: 450, merchants: 450, deactivated: 0 });
    expect(stub.requests.map((q) => q.body.page)).toEqual([1, 2, 3]);
  });

  it("still never lists expired, not-yet-started or non-code rows", async () => {
    stub.catalog = [
      row({ id: "a", code: "ENDED5", endsAt: new Date(Date.now() - 86_400_000).toISOString() }),
      row({ id: "b", code: "LATER5", startsAt: new Date(Date.now() + 5 * 86_400_000).toISOString() }),
      row({ id: "c", code: "the" }),
      row({ id: "d", code: "GOOD10" }),
    ];
    await addBrand();
    await runFeedicoSync("test");
    expect((await loadPromoCodes()).map((c) => c.code)).toEqual(["GOOD10"]);
  });

  it("is idempotent: a second run within 12 hours makes no request and changes nothing", async () => {
    stub.catalog = [row()];
    await runFeedicoSync("test");
    expect(await runFeedicoSync("test")).toMatchObject({ status: "NOT_DUE" });
    expect(stub.requests).toHaveLength(1);
    expect(await db.commerceCoupon.count()).toBe(1);
  });

  it("never replaces the official verdict: the official code stays the one public row", async () => {
    const brand = await addBrand();
    const now = new Date();
    await db.commerceCoupon.create({ data: { brandId: brand.id, merchant: "Acme", code: "SAVE20", sourceUrl: "https://acme.com/promotions", status: "VERIFIED", observedAt: now, lastVerifiedAt: now } });
    stub.catalog = [row({ title: "25% off sitewide" })];
    await runFeedicoSync("test");
    expect((await verifiedCouponsFor({ brandId: brand.id })).map((c) => [c.code, c.sourceUrl])).toEqual([["SAVE20", "https://acme.com/promotions"]]);
  });

  it("after a complete read, a code Feedico no longer lists is deactivated (row kept); a passed end date expires it", async () => {
    const brand = await addBrand();
    const t0 = new Date();
    const at = (d: number) => new Date(t0.getTime() + d * day);
    stub.catalog = [row({ fetchedAt: at(0).toISOString() }), row({ id: "c9", code: "ENDED5", endsAt: at(2).toISOString(), fetchedAt: at(0).toISOString() })];
    await runFeedicoSync("test", { now: at(0) });
    stub.catalog = [row({ id: "c9", code: "ENDED5", endsAt: at(2).toISOString(), fetchedAt: at(7).toISOString() })];
    await runFeedicoSync("test", { now: at(7) });
    expect((await feedRows(brand.id)).map((c) => [c.code, c.status])).toEqual([["ENDED5", "EXPIRED"], ["SAVE20", "INVALID"]]);
    expect((await feedRows(brand.id)).find((c) => c.code === "SAVE20")?.verificationEvidence).toMatch(/No longer listed in the Feedico catalogue/);
    expect(await db.commerceCoupon.count()).toBe(2);
  });

  it("an incomplete read (page limit) deactivates nothing", async () => {
    await addBrand();
    stub.catalog = [row()];
    await runFeedicoSync("test");
    stub.catalog = Array.from({ length: 300 }, (_, i) => row({ id: `n${i}`, brandName: `Shop ${i}`, code: `NEW${1000 + i}`, merchantWebsiteUrl: `https://shop${i}.com` }));
    const cap = withEnv({ FEEDICO_MAX_CATALOG_PAGES: "1" });
    const r = await runFeedicoSync("test", { force: true });
    cap();
    expect(r).toMatchObject({ complete: false, pages: 1, invalidated: 0 });
    expect(await db.commerceCoupon.findFirst({ where: { code: "SAVE20" } })).toMatchObject({ status: "UNVERIFIED" });
  });

  it("only accepts codes Feedico confirmed within 14 days (no date = rejected) and deactivates older stored ones", async () => {
    const brand = await addBrand();
    const now = new Date();
    stub.catalog = [row({ fetchedAt: new Date(now.getTime() - 13 * day).toISOString() }), row({ id: "c2", code: "OLD15", fetchedAt: new Date(now.getTime() - 15 * day).toISOString() }), row({ id: "c3", code: "NODATE5", fetchedAt: null })];
    expect(await runFeedicoSync("test", { now })).toMatchObject({ coupons: 1, dropped: 2 });
    expect((await feedRows(brand.id)).map((c) => c.code)).toEqual(["SAVE20"]);
    const off = withEnv({ FEEDICO_API_KEY: undefined });
    const r = await runFeedicoSync("test", { now: new Date(now.getTime() + 2 * day) });
    off();
    expect(r).toMatchObject({ status: "BLOCKED_BY_ENVIRONMENT", deactivated: 1 });
  });

  it("two triggers at once read each page once (no duplicate request)", async () => {
    await addBrand(); // a seeded registry (seeding an empty one is a one-time first-run step)
    stub.catalog = [row()];
    await Promise.all([runFeedicoSync("cron-a"), runFeedicoSync("cron-b")]);
    expect(stub.requests).toHaveLength(1);
  });

  it("a rejected key stops the run, makes one request and changes no coupon", async () => {
    stub.catalog = [row()];
    await runFeedicoSync("test");
    const before = await db.commerceCoupon.findMany();
    stub.mode = "401";
    const r = await runFeedicoSync("test", { force: true });
    expect(r).toMatchObject({ status: "AUTH_FAILED", requests: 1 });
    expect(await db.commerceCoupon.findMany()).toEqual(before);
    const source = await db.commerceSource.findUnique({ where: { slug: "feedico" } });
    expect(source?.crawlStatus).toBe("AUTH_FAILED");
    expect(source?.lastError).not.toContain(KEY);
  });

  it("Feedico's quota answer (429) ends the month: the next run makes no request", async () => {
    stub.mode = "429";
    expect(await runFeedicoSync("test")).toMatchObject({ status: "BUDGET_EXHAUSTED", requests: 1 });
    stub.mode = "ok";
    expect(await runFeedicoSync("test")).toMatchObject({ status: "BUDGET_EXHAUSTED", requests: 0 });
    expect(stub.requests).toHaveLength(1);
    expect(await feedicoUsage()).toMatchObject({ quotaExceeded: true, requests: 1 });
  });

  it("stops at FEEDICO_MONTHLY_REQUEST_BUDGET, counting attempts before they are made", async () => {
    stub.catalog = Array.from({ length: 450 }, (_, i) => row({ id: `c${i}`, code: `CODE${1000 + i}` }));
    const cap = withEnv({ FEEDICO_MONTHLY_REQUEST_BUDGET: "2" });
    const r = await runFeedicoSync("test");
    cap();
    expect(r).toMatchObject({ status: "BUDGET_EXHAUSTED", requests: 2 });
    expect(stub.requests).toHaveLength(2);
  });

  it("a server error is not retried (one request) and keeps the last good data", async () => {
    stub.catalog = [row()];
    await runFeedicoSync("test");
    stub.mode = "500";
    expect(await runFeedicoSync("test", { force: true })).toMatchObject({ status: "FAILED", requests: 1 });
    expect((await db.commerceCoupon.findMany()).map((c) => c.status)).toEqual(["UNVERIFIED"]);
  });

  it("a malformed response is rejected whole and changes nothing", async () => {
    stub.mode = "malformed";
    const r = await runFeedicoSync("test");
    expect(r.failures?.[0].error).toMatch(/RESPONSE_INVALID/);
    expect(await db.commerceCoupon.count()).toBe(0);
  });

  it("does nothing while the source is disabled in Admin", async () => {
    await runFeedicoSync("test"); // creates the source
    await db.commerceSource.update({ where: { slug: "feedico" }, data: { enabled: false } });
    stub.requests.length = 0;
    expect(await runFeedicoSync("test", { force: true })).toMatchObject({ status: "DISABLED" });
    expect(stub.requests).toHaveLength(0);
  });

  it("names merchants without the affiliate-programme suffix", () => {
    expect(merchantName("Banggood CJ Affiliate Program")).toBe("Banggood");
    expect(merchantName("Acme Affiliate Programme")).toBe("Acme");
    expect(merchantName("Shop (Impact Program)")).toBe("Shop");
    expect(merchantName("Plain Store")).toBe("Plain Store");
  });
});
