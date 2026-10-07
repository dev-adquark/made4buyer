import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifiedCouponsFor } from "@/lib/commerce/coupons";
import { collectCouponRuns, runCouponCrawl } from "@/lib/commerce/coupons-run";
import { importCommerceSources, readSourceSeed } from "@/lib/commerce/sources";
import { db } from "@/lib/db";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

/**
 * Local node:http stub for the Apify API (runs, run status, dataset items) and for the brand's
 * robots.txt. Dataset items are fixed per run at start time from `stub.items`.
 */
type Stub = { base: string; items: unknown[]; posts: Array<{ path: string; body: Record<string, unknown> }>; requests: string[]; close: () => Promise<void> };

async function startStub(): Promise<Stub> {
  const runs = new Map<string, unknown[]>();
  const stub: Stub = { base: "", items: [], posts: [], requests: [], close: async () => undefined };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    stub.requests.push(`${req.method} ${url.pathname}`);
    const send = (status: number, body: unknown, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (url.pathname === "/robots.txt") return send(200, "User-agent: *\nDisallow: /private\n", "text/plain");
    if (url.pathname.startsWith("/apify/v2/")) {
      if (req.headers.authorization !== "Bearer test-apify-token") return send(401, { error: { type: "token-not-valid" } });
      const p = url.pathname.slice("/apify/v2".length);
      if (req.method === "POST" && /^\/acts\/[^/]+\/runs$/.test(p)) {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          const id = `run-${runs.size + 1}`;
          runs.set(id, JSON.parse(JSON.stringify(stub.items)));
          stub.posts.push({ path: p, body: JSON.parse(raw) });
          send(201, { data: { id, status: "READY", defaultDatasetId: `ds-${id}` } });
        });
        return;
      }
      const run = p.match(/^\/actor-runs\/([^/]+)$/);
      if (run) return send(200, { data: { id: run[1], status: "SUCCEEDED", defaultDatasetId: `ds-${run[1]}`, finishedAt: new Date().toISOString(), usageTotalUsd: 0.02 } });
      if (/^\/actor-runs\/[^/]+\/abort$/.test(p)) return send(200, { data: { status: "ABORTED" } });
      const ds = p.match(/^\/datasets\/ds-([^/]+)\/items$/);
      if (ds) return send(200, runs.get(ds[1]) ?? []);
    }
    send(404, { error: "not found" });
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
  restore = withEnv({ APIFY_API_TOKEN: "test-apify-token", APIFY_API_BASE_URL: `${stub.base}/apify/v2`, COMMERCE_MONTHLY_BUDGET_USD: undefined });
});
afterAll(async () => {
  restore();
  await stub.close();
});
beforeEach(async () => {
  await resetDb();
  stub.items = [];
  stub.posts.length = 0;
  stub.requests.length = 0;
});

const promoUrl = () => `${stub.base}/promotions`;
const pageItem = (codes: Array<{ code: string; context: string }>) => ({ m4bCoupon: 1, url: promoUrl(), title: "Acme offers", candidates: codes.map((c) => ({ ...c, element: "p" })), jsonLd: [] });
const addBrand = (over: Record<string, unknown> = {}) => db.commerceBrand.create({ data: { name: "Acme", slug: "acme", officialDomain: "127.0.0.1", promoUrls: [promoUrl()], enabled: true, ...over } });
/** Lets the next crawl start: the previous coupon run is moved back past the brand's crawl interval. */
const ageRuns = () => db.commerceRun.updateMany({ data: { startedAt: new Date(Date.now() - 3 * 86_400_000) } });

describe("commerce coupon crawl", () => {
  it("crawls only official promo pages allowed by robots.txt, never a disabled or unapproved third-party source", async () => {
    await addBrand();
    const blocked = await addBrand({ name: "Blocked", slug: "blocked", promoUrls: [`${stub.base}/private/offers`] });
    await db.commerceSource.create({ data: { name: "RetailMeNot", slug: "retailmenot", kind: "COUPON_SITE", domain: "127.0.0.1", startUrls: [`${stub.base}/tp-disabled`], enabled: false, termsStatus: "UNREVIEWED" } });
    // Enabled but terms never approved: still never crawled.
    await db.commerceSource.create({ data: { name: "Slickdeals", slug: "slickdeals", kind: "COUPON_SITE", domain: "127.0.0.1", startUrls: [`${stub.base}/tp-unapproved`], enabled: true, termsStatus: "UNREVIEWED" } });

    const r = await runCouponCrawl("test");
    expect(r).toMatchObject({ status: "OK", started: 1 });
    expect(stub.posts).toHaveLength(1);
    const input = stub.posts[0].body;
    expect(input).toMatchObject({ startUrls: [{ url: promoUrl() }], maxCrawlingDepth: 0, maxPagesPerCrawl: 1, maxConcurrency: 1, respectRobotsTxtFile: true, proxyConfiguration: { useApifyProxy: true } });
    expect(stub.posts[0].path).toBe("/acts/moJRLRc85AitArpNN/runs");
    expect(JSON.stringify(stub.posts)).not.toContain("/tp-");

    const skipped = await db.commerceRun.findFirstOrThrow({ where: { brandId: blocked.id } });
    expect(skipped).toMatchObject({ status: "ROBOTS_DISALLOWED", apifyRunId: null, purpose: "COUPON" });
    expect(JSON.stringify(skipped.errors)).toContain("/private/offers");
    expect(await db.commerceRun.count({ where: { sourceId: { not: null } } })).toBe(0);
  });

  it("first-party code → VERIFIED; one missed crawl keeps it; two make it INVALID (row kept); raw stored unchanged", async () => {
    const brand = await addBrand();
    stub.items = [pageItem([{ code: "SAVE20", context: "Use code SAVE20 for 20% off sitewide. Offer ends Dec 31, 2099." }]), { not: "ours" }];
    expect(await runCouponCrawl("test")).toMatchObject({ started: 1 });
    const c1 = await collectCouponRuns("test");
    expect(c1).toMatchObject({ collected: 1 });

    const raw = await db.commerceRawRecord.findFirstOrThrow({ where: { url: promoUrl() } });
    expect(raw.payload).toEqual(stub.items[0]);
    expect(raw.purpose).toBe("COUPON");
    let coupon = await db.commerceCoupon.findFirstOrThrow({ where: { code: "SAVE20" } });
    expect(coupon).toMatchObject({ merchant: "Acme", brandId: brand.id, status: "VERIFIED", discount: "20% off", discountType: "PERCENT", sourceUrl: promoUrl(), sourceRawId: raw.id });
    expect(coupon.expiresAt?.toISOString()).toBe("2099-12-31T23:59:59.999Z");
    expect(coupon.verificationEvidence).toMatch(new RegExp(`^Published on ${promoUrl()} at \\d{4}-`));
    expect(coupon.lastVerifiedAt).not.toBeNull();
    const run = await db.commerceRun.findFirstOrThrow({ where: { brandId: brand.id } });
    expect(run).toMatchObject({ status: "COLLECTED", pagesProcessed: 1, accepted: 1, usageUsd: 0.02 });
    expect((await verifiedCouponsFor({ brandId: brand.id })).map((c) => c.code)).toEqual(["SAVE20"]);
    // Collecting again is a no-op.
    expect(await collectCouponRuns("test")).toMatchObject({ checked: 0, collected: 0 });

    // Second crawl: SAVE20 is gone, a new code appears.
    await ageRuns();
    stub.items = [pageItem([{ code: "NEW25", context: "Promo code: NEW25 takes $25 off orders over $200." }])];
    expect(await runCouponCrawl("test")).toMatchObject({ started: 1 });
    await collectCouponRuns("test");
    coupon = await db.commerceCoupon.findFirstOrThrow({ where: { code: "SAVE20" } });
    expect(coupon.status).toBe("VERIFIED");
    expect(await db.commerceCoupon.findFirstOrThrow({ where: { code: "NEW25" } })).toMatchObject({ status: "VERIFIED", discount: "$25 off", discountType: "AMOUNT", expiresAt: null });

    // Third crawl: absent twice in a row → INVALID, never deleted.
    await ageRuns();
    expect(await runCouponCrawl("test")).toMatchObject({ started: 1 });
    await collectCouponRuns("test");
    coupon = await db.commerceCoupon.findFirstOrThrow({ where: { code: "SAVE20" } });
    expect(coupon.status).toBe("INVALID");
    expect(coupon.verificationEvidence).toMatch(/absent from 2 consecutive crawls/);
    expect(await db.commerceCoupon.count()).toBe(2);
    expect((await verifiedCouponsFor({ brandId: brand.id })).map((c) => c.code)).toEqual(["NEW25"]);
    expect(await db.commerceRawRecord.count()).toBe(3);
  });

  it("marks stated expiries as EXPIRED and never shows them", async () => {
    const brand = await addBrand();
    stub.items = [pageItem([{ code: "OLD10", context: "Use code OLD10 for 10% off. Expires Jan 1, 2020." }])];
    await runCouponCrawl("test");
    await collectCouponRuns("test");
    expect(await db.commerceCoupon.findFirstOrThrow({ where: { code: "OLD10" } })).toMatchObject({ status: "EXPIRED" });
    expect(await verifiedCouponsFor({ brandId: brand.id })).toEqual([]);
  });

  it("honours the monthly budget and needs an Apify token", async () => {
    const brand = await addBrand();
    await db.commerceRun.create({ data: { purpose: "PRODUCT", brandId: brand.id, actorId: "x", trigger: "test", status: "COLLECTED", usageUsd: 30.5 } });
    expect(await runCouponCrawl("test")).toMatchObject({ status: "BUDGET_EXHAUSTED", started: 0 });
    expect(stub.posts).toHaveLength(0);
    const r = withEnv({ APIFY_API_TOKEN: undefined });
    expect(await runCouponCrawl("test")).toMatchObject({ status: "BLOCKED_BY_ENVIRONMENT", started: 0 });
    r();
  });

  it("imports third-party coupon sites disabled with terms unreviewed, and re-import never enables them", async () => {
    const seed = readSourceSeed();
    expect(seed.length).toBeGreaterThan(0);
    expect(await importCommerceSources()).toMatchObject({ created: seed.length });
    const rows = await db.commerceSource.findMany();
    expect(rows.every((s) => s.kind === "COUPON_SITE" && !s.enabled && s.termsStatus === "UNREVIEWED" && /prohibit automated collection/.test(s.notes ?? ""))).toBe(true);
    await db.commerceSource.update({ where: { slug: "retailmenot" }, data: { termsStatus: "REJECTED" } });
    await importCommerceSources();
    expect((await db.commerceSource.findUniqueOrThrow({ where: { slug: "retailmenot" } })).termsStatus).toBe("REJECTED");
    await addBrand();
    await runCouponCrawl("test");
    expect(await db.commerceRun.count({ where: { sourceId: { not: null } } })).toBe(0);
  });
});
