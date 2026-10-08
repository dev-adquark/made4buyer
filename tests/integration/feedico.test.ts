import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifiedCouponsFor } from "@/lib/commerce/coupons";
import { feedicoSourceUrl, feedicoUsage, runFeedicoSync } from "@/lib/commerce/feedico";
import { db } from "@/lib/db";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

/**
 * Local node:http stand-in for Feedico's POST /api/v1/catalog/coupons (SAMPLE data, never the real
 * API). `mode` switches the answer; every request is recorded (auth header, body).
 */
type Mode = "ok" | "401" | "429" | "500" | "malformed";
type Stub = { base: string; mode: Mode; rows: Record<string, unknown[]>; requests: Array<{ auth?: string; body: Record<string, unknown> }>; close: () => Promise<void> };
const KEY = "fdco_testkey_0123456789";

async function startStub(): Promise<Stub> {
  const stub: Stub = { base: "", mode: "ok", rows: {}, requests: [], close: async () => undefined };
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
      const rows = stub.rows[String(body.firmName ?? "")] ?? [];
      send(200, { ok: true, recordCount: rows.length, page: body.page ?? 1, pageSize: body.pageSize ?? 50, availableProviders: ["cj_affiliate"], coupons: rows });
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
  restore = withEnv({ FEEDICO_API_KEY: KEY, FEEDICO_API_BASE_URL: stub.base, UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: "true", FEEDICO_MONTHLY_REQUEST_BUDGET: undefined, FEEDICO_MIN_REFETCH_HOURS: undefined, FEEDICO_MAX_FEED_AGE_DAYS: undefined, FEEDICO_BRANDS_PER_RUN: undefined });
});
afterAll(async () => {
  restore();
  await stub.close();
});
beforeEach(async () => {
  await resetDb();
  await db.automationSetting.deleteMany({ where: { key: "feedico:state" } });
  stub.mode = "ok";
  stub.rows = {};
  stub.requests.length = 0;
});

const row = (over: Record<string, unknown> = {}) => ({ id: "coupon_1", brandName: "Acme CJ Affiliate Program", provider: "cj_affiliate", code: "SAVE20", title: "20% off sitewide", description: null, startsAt: null, endsAt: null, merchantWebsiteUrl: "https://www.acme.com", fetchedAt: new Date().toISOString(), ...over });
const addBrand = (name = "Acme", domain = "acme.com") => db.commerceBrand.create({ data: { name, slug: name.toLowerCase(), officialDomain: domain, enabled: true } });
const feedRows = (brandId: string) => db.commerceCoupon.findMany({ where: { brandId, sourceUrl: { contains: "/api/v1/catalog/coupons" } }, orderBy: { code: "asc" } });
const day = 86_400_000;

describe("Feedico coupon feed", () => {
  it("is blocked without FEEDICO_API_KEY and makes no request", async () => {
    await addBrand();
    const off = withEnv({ FEEDICO_API_KEY: undefined });
    expect(await runFeedicoSync("test")).toMatchObject({ status: "BLOCKED_BY_ENVIRONMENT" });
    off();
    expect(stub.requests).toHaveLength(0);
  });

  it("stores the brand's codes (UNVERIFIED: not checked on the brand's page) and publishes them, with the raw response and the source", async () => {
    const brand = await addBrand();
    stub.rows.Acme = [row(), row({ id: "c2", code: "TOOLS10", merchantWebsiteUrl: "https://acmetools.example" }), row({ id: "c3", code: "FREESHIP", title: "Free shipping on orders" })];
    const r = await runFeedicoSync("test");
    expect(r).toMatchObject({ status: "OK", brandsChecked: 1, requests: 1, coupons: 2, created: 2 });
    expect(stub.requests[0]).toMatchObject({ auth: `Bearer ${KEY}`, body: { page: 1, pageSize: 200, firmName: "Acme" } });
    const rows = await feedRows(brand.id);
    expect(rows.map((c) => [c.code, c.status, c.discount])).toEqual([["FREESHIP", "UNVERIFIED", "Free shipping"], ["SAVE20", "UNVERIFIED", "20% off"]]);
    expect(rows.every((c) => c.sourceUrl === feedicoSourceUrl(brand) && c.merchant === "Acme")).toBe(true);
    expect((await verifiedCouponsFor({ brandId: brand.id })).map((c) => c.code).sort()).toEqual(["FREESHIP", "SAVE20"]); // public as feed codes
    const raw = await db.commerceRawRecord.findFirst({ where: { url: feedicoSourceUrl(brand) } });
    expect(JSON.stringify(raw?.payload)).not.toContain(KEY);
    expect(JSON.stringify(raw?.payload)).not.toContain("TOOLS10"); // another merchant's row is not kept
    const source = await db.commerceSource.findUnique({ where: { slug: "feedico" } });
    expect(source).toMatchObject({ kind: "COUPON_FEED", enabled: true, termsStatus: "APPROVED", crawlStatus: "OK", consecutiveFailures: 0 });
    const run = await db.commerceRun.findFirst({ where: { sourceId: source!.id } });
    expect(run).toMatchObject({ purpose: "COUPON", status: "COLLECTED", apifyRunId: null, accepted: 2 });
  });

  it("is idempotent: a second run within 12 hours makes no request and changes nothing", async () => {
    await addBrand();
    stub.rows.Acme = [row()];
    await runFeedicoSync("test");
    const again = await runFeedicoSync("test");
    expect(again).toMatchObject({ status: "NOT_DUE" });
    expect(stub.requests).toHaveLength(1);
    expect(await db.commerceCoupon.count()).toBe(1);
  });

  it("never replaces the official verdict: the official code stays the one public row", async () => {
    const brand = await addBrand();
    const now = new Date();
    await db.commerceCoupon.create({ data: { brandId: brand.id, merchant: "Acme", code: "SAVE20", sourceUrl: "https://acme.com/promotions", status: "VERIFIED", observedAt: now, lastVerifiedAt: now } });
    stub.rows.Acme = [row({ title: "25% off sitewide" })];
    await runFeedicoSync("test");
    const pub = await verifiedCouponsFor({ brandId: brand.id });
    expect(pub.map((c) => [c.code, c.sourceUrl])).toEqual([["SAVE20", "https://acme.com/promotions"]]);
    expect(await db.commerceCoupon.findFirst({ where: { brandId: brand.id, sourceUrl: "https://acme.com/promotions" } })).toMatchObject({ status: "VERIFIED" });
  });

  it("deactivates a code missing from two consecutive successful fetches, and expires a passed end date", async () => {
    const brand = await addBrand();
    const t0 = new Date();
    const at = (d: number) => new Date(t0.getTime() + d * day);
    const ended = (d: number) => row({ id: "c9", code: "ENDED5", endsAt: at(2).toISOString(), fetchedAt: at(d).toISOString() });
    stub.rows.Acme = [row({ fetchedAt: at(0).toISOString() }), ended(0)];
    await runFeedicoSync("test", { now: at(0) });
    stub.rows.Acme = [ended(7)];
    await runFeedicoSync("test", { now: at(7) });
    expect((await feedRows(brand.id)).map((c) => [c.code, c.status])).toEqual([["ENDED5", "EXPIRED"], ["SAVE20", "UNVERIFIED"]]); // one miss: kept
    stub.rows.Acme = [ended(13)];
    await runFeedicoSync("test", { now: at(13) });
    expect((await feedRows(brand.id)).map((c) => [c.code, c.status])).toEqual([["ENDED5", "EXPIRED"], ["SAVE20", "INVALID"]]);
    expect(await db.commerceCoupon.count()).toBe(2); // rows are never deleted
  });

  it("one weekly run fetches every brand", async () => {
    for (const n of ["Acme", "Bolt", "Core"]) await addBrand(n, `${n.toLowerCase()}.com`);
    const r = await runFeedicoSync("test");
    expect(r).toMatchObject({ status: "OK", brandsChecked: 3, requests: 3, remaining: 0 });
    expect(stub.requests.map((q) => q.body.firmName).sort()).toEqual(["Acme", "Bolt", "Core"]);
  });

  it("only accepts codes Feedico confirmed within 14 days (no date = rejected)", async () => {
    const brand = await addBrand();
    const now = new Date();
    stub.rows.Acme = [row({ fetchedAt: new Date(now.getTime() - 13 * day).toISOString() }), row({ id: "c2", code: "OLD15", fetchedAt: new Date(now.getTime() - 15 * day).toISOString() }), row({ id: "c3", code: "NODATE5", fetchedAt: null })];
    const r = await runFeedicoSync("test", { now });
    expect(r).toMatchObject({ coupons: 1, dropped: 2 });
    expect((await feedRows(brand.id)).map((c) => c.code)).toEqual(["SAVE20"]);
  });

  it("deactivates a stored code once Feedico's last confirmation is older than 14 days, and reactivates it when Feedico confirms it again", async () => {
    const brand = await addBrand();
    const t0 = new Date();
    const at = (d: number) => new Date(t0.getTime() + d * day);
    stub.rows.Acme = [row({ fetchedAt: at(0).toISOString() })];
    await runFeedicoSync("test", { now: at(0) });
    // Feedico still lists it a week later, but has not re-confirmed it since day 0.
    expect(await runFeedicoSync("test", { now: at(7) })).toMatchObject({ coupons: 1, deactivated: 0 });
    expect((await feedRows(brand.id))[0].status).toBe("UNVERIFIED");
    const r = await runFeedicoSync("test", { now: at(15) });
    expect(r).toMatchObject({ coupons: 0, dropped: 1, deactivated: 1 });
    const [gone] = await feedRows(brand.id);
    expect(gone.status).toBe("INVALID");
    expect(await verifiedCouponsFor({ brandId: brand.id }, at(15))).toEqual([]); // deactivated: off the site
    expect(gone.verificationEvidence).toMatch(/last confirmed it on .*more than 14 days ago/);
    stub.rows.Acme = [row({ fetchedAt: at(16).toISOString() })];
    await runFeedicoSync("test", { now: at(16) });
    expect((await feedRows(brand.id)).map((c) => c.status)).toEqual(["UNVERIFIED"]); // confirmed again: a candidate again
    expect(await db.commerceCoupon.count()).toBe(1);
  });

  it("deactivates stale codes even when nothing can be fetched (no key)", async () => {
    const brand = await addBrand();
    const t0 = new Date();
    stub.rows.Acme = [row({ fetchedAt: t0.toISOString() })];
    await runFeedicoSync("test", { now: t0 });
    const off = withEnv({ FEEDICO_API_KEY: undefined });
    const r = await runFeedicoSync("test", { now: new Date(t0.getTime() + 15 * day) });
    off();
    expect(r).toMatchObject({ status: "BLOCKED_BY_ENVIRONMENT", deactivated: 1 });
    expect((await feedRows(brand.id))[0].status).toBe("INVALID");
  });

  it("a rejected key stops the run and changes no coupon", async () => {
    await addBrand();
    await addBrand("Bolt", "bolt.com");
    stub.rows.Acme = [row()];
    await runFeedicoSync("test");
    const before = await db.commerceCoupon.findMany();
    stub.mode = "401";
    const r = await runFeedicoSync("test", { force: true });
    expect(r).toMatchObject({ status: "AUTH_FAILED", brandsFailed: 1, requests: 1 });
    expect(await db.commerceCoupon.findMany()).toEqual(before);
    const source = await db.commerceSource.findUnique({ where: { slug: "feedico" } });
    expect(source?.crawlStatus).toBe("AUTH_FAILED");
    expect(source?.lastError).not.toContain(KEY);
    expect(await db.commerceRun.findFirst({ where: { status: "FAILED" } })).not.toBeNull();
  });

  it("Feedico's quota answer (429) ends the month: the next run makes no request", async () => {
    await addBrand();
    stub.mode = "429";
    expect(await runFeedicoSync("test")).toMatchObject({ status: "BUDGET_EXHAUSTED", requests: 1 });
    stub.mode = "ok";
    expect(await runFeedicoSync("test")).toMatchObject({ status: "BUDGET_EXHAUSTED", requests: 0 });
    expect(stub.requests).toHaveLength(1);
    expect(await feedicoUsage()).toMatchObject({ quotaExceeded: true, requests: 1 });
  });

  it("stops at FEEDICO_MONTHLY_REQUEST_BUDGET, counting attempts before they are made", async () => {
    for (const n of ["Acme", "Bolt", "Core"]) await addBrand(n, `${n.toLowerCase()}.com`);
    const cap = withEnv({ FEEDICO_MONTHLY_REQUEST_BUDGET: "2" });
    const r = await runFeedicoSync("test");
    cap();
    expect(r).toMatchObject({ status: "BUDGET_EXHAUSTED", requests: 2, brandsChecked: 2 });
    expect(stub.requests).toHaveLength(2);
  });

  it("a server error is retried once, keeps the last good data, and the brand is retried on the next run", async () => {
    const brand = await addBrand();
    stub.rows.Acme = [row()];
    await runFeedicoSync("test");
    stub.mode = "500";
    const r = await runFeedicoSync("test", { force: true });
    expect(r).toMatchObject({ status: "FAILED", brandsFailed: 1, requests: 2 });
    expect((await feedRows(brand.id)).map((c) => c.status)).toEqual(["UNVERIFIED"]);
    stub.mode = "ok";
    expect(await runFeedicoSync("test")).toMatchObject({ status: "OK", brandsChecked: 1 }); // failed brand is due again
  });

  it("a malformed response is rejected whole and changes nothing", async () => {
    await addBrand();
    stub.mode = "malformed";
    const r = await runFeedicoSync("test");
    expect(r.failures?.[0].error).toMatch(/RESPONSE_INVALID/);
    expect(await db.commerceCoupon.count()).toBe(0);
  });

  it("does nothing while the source is disabled in Admin", async () => {
    await addBrand();
    await runFeedicoSync("test"); // creates the source
    await db.commerceSource.update({ where: { slug: "feedico" }, data: { enabled: false } });
    stub.requests.length = 0;
    expect(await runFeedicoSync("test", { force: true })).toMatchObject({ status: "DISABLED" });
    expect(stub.requests).toHaveLength(0);
  });
});
