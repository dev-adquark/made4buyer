import type { ReactElement } from "react";
import { prerender } from "react-dom/static";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Admin session cookie jar for getAdminSession() (next/headers is request-scoped in Next.js).
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn, revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  usePathname: () => "/admin/commerce",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, refresh: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
}));
// A brand run would fetch robots.txt / sitemaps and call Apify: the endpoint is tested against a stub.
vi.mock("@/lib/commerce/pipeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/commerce/pipeline")>()),
  startBrandRun: vi.fn(async (brand: { slug: string }) => ({ status: "STARTED", runId: "run-stub", brand: brand.slug, urls: 3, recheck: 1, discovery: "OK" })),
}));

import { GET as getCoupons } from "@/app/api/commerce/coupons/route";
import { GET as getDeals } from "@/app/api/commerce/deals/route";
import { GET as getProducts } from "@/app/api/commerce/products/route";
import { GET as getRuns } from "@/app/api/commerce/runs/route";
import { POST as postRun } from "@/app/api/commerce/apify/run/route";
import { POST as postRefresh } from "@/app/api/commerce/refresh/route";
import { POST as postVerify } from "@/app/api/commerce/verify/route";
import { ADMIN_COOKIE, createSession } from "@/lib/auth";
import { listDeals, parsePaging, UNCLASSIFIED } from "@/lib/commerce/admin-queries";
import { startBrandRun } from "@/lib/commerce/pipeline";
import { db } from "@/lib/db";
import { isJobName, JOBS } from "@/lib/jobs/registry";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

const ADMIN = "owner@made4buyers.test";
const HOUR = 3_600_000;
const ORIGIN = "http://localhost";

let restore: () => void;
beforeEach(async () => {
  await resetDb();
  jar.clear();
  restore = withEnv({ ADMIN_EMAIL: ADMIN, ADMIN_PASSWORD: "test-password-0123456789", APIFY_API_TOKEN: undefined });
  vi.mocked(startBrandRun).mockClear();
});
afterEach(() => {
  restore();
  vi.restoreAllMocks();
});

async function signIn() {
  const { token } = await createSession(ADMIN);
  jar.set(ADMIN_COOKIE, token);
}

const get = (handler: (req: Request) => Promise<Response>, path: string, headers: Record<string, string> = {}) => handler(new Request(`${ORIGIN}${path}`, { headers }));
const post = (handler: (req: Request) => Promise<Response>, path: string, body: unknown, headers: Record<string, string> = { origin: ORIGIN }) =>
  handler(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

// ── Fixtures ────────────────────────────────────────────────────────────────

async function seedDeals() {
  const brand = await db.commerceBrand.create({ data: { name: "Framework", slug: "framework", officialDomain: "frame.work", categories: ["laptops"] } });
  const product = await db.commerceProduct.create({
    data: { canonicalUrl: "https://frame.work/products/laptop12", name: "Framework Laptop 12", sku: "FRAKCB0001", brandId: brand.id, identityStatus: "UNMATCHED", observedAt: new Date(), data: { offers: [{ type: "Offer", price: 799, listPrice: 999, listPriceType: "ListPrice", url: "https://frame.work/products/laptop12" }] } },
  });
  const offer = (over: Record<string, unknown>) =>
    db.commerceOffer.create({ data: { productId: product.id, seller: "Framework", sellerType: "MANUFACTURER", destinationUrl: "https://frame.work/products/laptop12", price: 999, currency: "USD", availability: "InStock", observedAt: new Date(Date.now() - HOUR), linkStatus: "OK", ...over } });
  const active = await offer({ price: 799, listPrice: 999, sourceRawId: "raw-internal-1", affiliateProvider: "internal-provider" });
  const noList = await offer({ destinationUrl: "https://frame.work/products/laptop12-b", price: 1099 });
  const stale = await offer({ destinationUrl: "https://frame.work/products/laptop12-c", price: 699, listPrice: 999, observedAt: new Date(Date.now() - 72 * HOUR) });
  const broken = await offer({ destinationUrl: "https://frame.work/products/laptop12-d", price: 749, listPrice: 999, linkStatus: "BROKEN" });
  const code = await db.commerceCoupon.create({ data: { brandId: brand.id, merchant: "Framework", code: "FALL25", discount: "$25 off", sourceUrl: "https://frame.work/promotions", status: "VERIFIED", observedAt: new Date(), lastVerifiedAt: new Date(Date.now() - HOUR) } });
  const unverified = await db.commerceCoupon.create({ data: { brandId: brand.id, merchant: "Framework", code: "FAKE20", sourceUrl: "https://frame.work/promo-b", status: "UNVERIFIED", observedAt: new Date() } });
  return { brand, product, active, noList, stale, broken, code, unverified };
}

const run = (data: Record<string, unknown> = {}) => db.commerceRun.create({ data: { purpose: "PRODUCT", actorId: "apify/web-scraper", trigger: "test", status: "COLLECTED", ...data } });

// ── Public deals endpoint ───────────────────────────────────────────────────

describe("GET /api/commerce/deals (public)", () => {
  it("returns only ACTIVE deals and codes, with no internal fields, CDN-cacheable", async () => {
    const s = await seedDeals();
    const res = await get(getDeals, "/api/commerce/deals", { "x-forwarded-for": "198.51.100.1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("s-maxage=300");
    const body = await res.json();
    expect(body.priceDrops).toHaveLength(1);
    expect(body.priceDrops[0]).toMatchObject({ productName: "Framework Laptop 12", price: 799, listPrice: 999, listPriceLabel: "Regular price", saving: 200, savingPercent: 20, currency: "USD", official: true });
    expect(body.promoCodes.map((c: { code: string }) => c.code)).toEqual(["FALL25"]);

    const text = JSON.stringify(body);
    for (const internal of [s.active.id, s.noList.id, s.stale.id, s.broken.id, s.code.id, s.unverified.id, s.product.id, s.brand.id, "raw-internal-1", "internal-provider"]) expect(text).not.toContain(internal);
    for (const key of ['"id"', "dealStatus", "linkStatus", "sourceRawId", "affiliateProvider", "affiliateStatus", "identityStatus", "productEntityId", "FAKE20"]) expect(text).not.toContain(key);
  });

  it("is rate-limited per IP", async () => {
    const headers = { "x-forwarded-for": "203.0.113.77" };
    for (let i = 0; i < 60; i++) expect((await get(getDeals, "/api/commerce/deals", headers)).status).toBe(200);
    const limited = await get(getDeals, "/api/commerce/deals", headers);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    // Another client is unaffected.
    expect((await get(getDeals, "/api/commerce/deals", { "x-forwarded-for": "203.0.113.78" })).status).toBe(200);
  });
});

// ── Admin read endpoints ─────────────────────────────────────────────────────

describe("admin read endpoints", () => {
  it("answer 401 JSON without a session (and with a forged cookie), never cached", async () => {
    for (const h of [getRuns, getProducts, getCoupons]) {
      const res = await get(h, "/api/commerce/x");
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(await res.json()).toEqual({ error: "Unauthorized" });
    }
    jar.set(ADMIN_COOKIE, "forged.signature");
    expect((await get(getRuns, "/api/commerce/runs")).status).toBe(401);
  });

  it("paginate runs (limit ≤ 100), filter by status and brand slug, and count what each run found", async () => {
    await signIn();
    const brand = await db.commerceBrand.create({ data: { name: "Acme", slug: "acme", officialDomain: "www.acme.com", categories: ["audio"] } });
    const r1 = await run({ brandId: brand.id, startedAt: new Date(Date.now() - 3 * HOUR), finishedAt: new Date(Date.now() - 3 * HOUR + 90_000), usageUsd: 0.12, computeUnits: 0.05, errors: [{ url: "https://www.acme.com/p/9", code: "NOT_EXTRACTED", reason: "no product data" }] });
    await run({ startedAt: new Date(Date.now() - 2 * HOUR), status: "FAILED" });
    await run({ startedAt: new Date(Date.now() - HOUR), purpose: "COUPON" });
    // r1's raw records source a product, a deal offer, a plain offer and a coupon.
    const raw1 = await db.commerceRawRecord.create({ data: { runId: r1.id, url: "https://www.acme.com/p/1", purpose: "PRODUCT", payload: { x: 1 }, contentHash: "h1" } });
    const raw2 = await db.commerceRawRecord.create({ data: { runId: r1.id, url: "https://www.acme.com/offers", purpose: "COUPON", payload: { x: 2 }, contentHash: "h2" } });
    const p = await db.commerceProduct.create({ data: { canonicalUrl: "https://www.acme.com/p/1", name: "Acme One", brandId: brand.id, observedAt: new Date(), lastRawId: raw1.id } });
    await db.commerceOffer.create({ data: { productId: p.id, seller: "Acme", sellerType: "MANUFACTURER", destinationUrl: "https://www.acme.com/p/1", price: 80, listPrice: 100, currency: "USD", observedAt: new Date(), sourceRawId: raw1.id } });
    await db.commerceOffer.create({ data: { productId: p.id, seller: "Acme", sellerType: "MANUFACTURER", destinationUrl: "https://www.acme.com/p/1?v=2", price: 100, currency: "USD", observedAt: new Date(), sourceRawId: raw1.id } });
    await db.commerceCoupon.create({ data: { brandId: brand.id, merchant: "Acme", code: "A10", sourceUrl: "https://www.acme.com/offers", observedAt: new Date(), sourceRawId: raw2.id } });

    let res = await get(getRuns, "/api/commerce/runs?limit=2&page=2");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    let body = await res.json();
    expect(body).toMatchObject({ page: 2, limit: 2, total: 3, pages: 2 });
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: r1.id, brand: { slug: "acme", name: "Acme" }, found: { products: 1, deals: 1, coupons: 1 }, usageUsd: 0.12, computeUnits: 0.05, durationMs: 90_000, errors: { count: 1, codes: [{ code: "NOT_EXTRACTED", count: 1 }] } });

    body = await (await get(getRuns, "/api/commerce/runs?limit=1000&page=-4")).json();
    expect(body).toMatchObject({ page: 1, limit: 100, total: 3 });
    body = await (await get(getRuns, "/api/commerce/runs?limit=0")).json();
    expect(body.limit).toBe(25);
    body = await (await get(getRuns, "/api/commerce/runs?status=failed")).json();
    expect(body.items.map((r: { status: string }) => r.status)).toEqual(["FAILED"]);
    body = await (await get(getRuns, "/api/commerce/runs?brand=acme")).json();
    expect(body.items.map((r: { id: string }) => r.id)).toEqual([r1.id]);
    // A brand filter is a slug, never a URL or anything else: garbage is ignored, not interpolated.
    body = await (await get(getRuns, `/api/commerce/runs?brand=${encodeURIComponent("https://evil.example/")}`)).json();
    expect(body.total).toBe(3);
    res = await get(getRuns, "/api/commerce/runs?purpose=COUPON");
    expect((await res.json()).total).toBe(1);
  });

  it("list products and coupons with filters and paging", async () => {
    await signIn();
    const s = await seedDeals();
    await db.commerceOffer.update({ where: { id: s.active.id }, data: { dealStatus: "ACTIVE", dealStatusReasons: [], dealStatusAt: new Date() } });
    let body = await (await get(getProducts, "/api/commerce/products?brand=framework&limit=5")).json();
    expect(body).toMatchObject({ page: 1, limit: 5, total: 1 });
    expect(body.items[0]).toMatchObject({ name: "Framework Laptop 12", brand: { slug: "framework" }, offerCount: 4, officialStatus: null });
    expect(body.items[0]).not.toHaveProperty("data");
    expect((await (await get(getProducts, "/api/commerce/products?status=MATCHED")).json()).total).toBe(0);
    expect((await (await get(getProducts, "/api/commerce/products?brand=nobody")).json()).total).toBe(0);

    body = await (await get(getCoupons, "/api/commerce/coupons?status=VERIFIED")).json();
    expect(body.items.map((c: { code: string }) => c.code)).toEqual(["FALL25"]);
    body = await (await get(getCoupons, "/api/commerce/coupons?limit=1&page=2")).json();
    expect(body).toMatchObject({ total: 2, pages: 2 });
    expect(body.items).toHaveLength(1);
  });
});

// ── Admin actions ────────────────────────────────────────────────────────────

describe("admin action endpoints", () => {
  it("reject cross-origin and session-less requests without running anything", async () => {
    const spy = vi.spyOn(JOBS["commerce-validate-links"], "run").mockResolvedValue({ status: "OK" } as never);
    // No session.
    expect((await post(postVerify, "/api/commerce/verify", { scope: "links" })).status).toBe(401);
    await signIn();
    // Cross-origin, a missing Origin, a cross-site fetch: all rejected even with a valid session.
    const rejected: Array<Record<string, string>> = [{ origin: "https://evil.example" }, {}, { "sec-fetch-site": "cross-site" }, { referer: "https://evil.example/page" }];
    for (const headers of rejected) {
      for (const [h, path, body] of [
        [postVerify, "/api/commerce/verify", { scope: "links" }],
        [postRun, "/api/commerce/apify/run", {}],
        [postRefresh, "/api/commerce/refresh", {}],
      ] as const) {
        const res = await post(h, path, body, headers);
        expect(res.status, `${path} ${JSON.stringify(headers)}`).toBe(403);
      }
    }
    expect(spy).not.toHaveBeenCalled();
    expect(await db.jobRun.count()).toBe(0);
    expect(vi.mocked(startBrandRun)).not.toHaveBeenCalled();
  });

  it("verify runs the job for each scope, as an admin trigger, audited", async () => {
    await signIn();
    const calls: Record<string, string[]> = {};
    for (const job of ["commerce-validate-links", "commerce-official-verify", "commerce-collect"] as const) {
      vi.spyOn(JOBS[job], "run").mockImplementation(async (trigger: string) => {
        (calls[job] ??= []).push(trigger);
        return { status: "OK", checked: 2 } as never;
      });
    }
    for (const [scope, job] of [["links", "commerce-validate-links"], ["official", "commerce-official-verify"], ["coupons", "commerce-collect"]] as const) {
      const res = await post(postVerify, "/api/commerce/verify", { scope });
      expect(res.status, scope).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(await res.json()).toMatchObject({ ok: true, job, status: "OK" });
      expect(calls[job]).toEqual([`admin:${ADMIN}`]);
      const log = await db.auditLog.findFirstOrThrow({ where: { action: `job.run.${job}` } });
      expect(log).toMatchObject({ actor: ADMIN, entityType: "job", entityId: job });
    }
    expect(await db.jobRun.count()).toBe(3);

    // Deal classification: the job the classifier registers; unavailable until it exists.
    const deals = await post(postVerify, "/api/commerce/verify", { scope: "deals" });
    if (isJobName("commerce-classify-deals")) expect([200, 422, 409]).toContain(deals.status);
    else expect(deals.status).toBe(503);
  });

  it("verify accepts only a known scope", async () => {
    await signIn();
    for (const scope of ["everything", "", null, "https://evil.example"]) expect((await post(postVerify, "/api/commerce/verify", { scope })).status).toBe(400);
    expect(await db.jobRun.count()).toBe(0);
  });

  it("refresh forces the weekly deals refresh via runJob", async () => {
    await signIn();
    const spy = vi.spyOn(JOBS["deals-weekly-refresh"], "run").mockResolvedValue({ status: "COMPLETED", reason: "swept" } as never);
    const res = await post(postRefresh, "/api/commerce/refresh", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, job: "deals-weekly-refresh", status: "COMPLETED" });
    expect(spy).toHaveBeenCalledWith(`admin:${ADMIN}`);
    expect(await db.auditLog.count({ where: { action: "job.run.deals-weekly-refresh", actor: ADMIN } })).toBe(1);
  });

  it("refresh reports a job that did not run (not a fake success)", async () => {
    await signIn();
    vi.spyOn(JOBS["deals-weekly-refresh"], "run").mockResolvedValue({ status: "BLOCKED_BY_ENVIRONMENT", reason: "APIFY_API_TOKEN not configured" } as never);
    const res = await post(postRefresh, "/api/commerce/refresh", {});
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ ok: false, status: "BLOCKED_BY_ENVIRONMENT" });
  });

  it("apify/run starts the due-brand jobs by purpose, or one brand's run by slug; never accepts URLs", async () => {
    await signIn();
    const discover = vi.spyOn(JOBS["commerce-discover"], "run").mockResolvedValue({ status: "OK", started: 2 } as never);
    const coupons = vi.spyOn(JOBS["commerce-coupons"], "run").mockResolvedValue({ status: "OK", started: 1 } as never);

    let res = await post(postRun, "/api/commerce/apify/run", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, job: "commerce-discover" });
    res = await post(postRun, "/api/commerce/apify/run", { purpose: "COUPON" });
    expect(await res.json()).toMatchObject({ ok: true, job: "commerce-coupons" });
    expect(discover).toHaveBeenCalledTimes(1);
    expect(coupons).toHaveBeenCalledTimes(1);

    const acme = await db.commerceBrand.create({ data: { name: "Acme", slug: "acme", officialDomain: "www.acme.com", categories: ["audio"] } });
    res = await post(postRun, "/api/commerce/apify/run", { brand: "acme", purpose: "DEAL" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, brand: "acme", purpose: "DEAL", status: "STARTED", runId: "run-stub", urls: 3 });
    expect(vi.mocked(startBrandRun)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startBrandRun).mock.calls[0][0]).toMatchObject({ id: acme.id, slug: "acme" });
    expect(vi.mocked(startBrandRun).mock.calls[0][1]).toBe(`admin:${ADMIN}`);
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "commerce.apify.run" } })).toMatchObject({ actor: ADMIN, entityId: acme.id });

    expect((await post(postRun, "/api/commerce/apify/run", { brand: "nobody" })).status).toBe(404);
    expect((await post(postRun, "/api/commerce/apify/run", { brand: "https://evil.example/sale" })).status).toBe(400);
    expect((await post(postRun, "/api/commerce/apify/run", { purpose: "SCRAPE_EVERYTHING" })).status).toBe(400);
    expect(vi.mocked(startBrandRun)).toHaveBeenCalledTimes(1);
  });

  it("apify/run refuses a disabled brand and a single-brand coupon run", async () => {
    await signIn();
    await db.commerceBrand.create({ data: { name: "Off", slug: "off", officialDomain: "www.off.com", categories: ["audio"], enabled: false } });
    await db.commerceBrand.create({ data: { name: "On", slug: "on", officialDomain: "www.on.com", categories: ["audio"] } });
    expect((await post(postRun, "/api/commerce/apify/run", { brand: "off" })).status).toBe(422);
    expect((await post(postRun, "/api/commerce/apify/run", { brand: "on", purpose: "COUPON" })).status).toBe(422);
    expect(vi.mocked(startBrandRun)).not.toHaveBeenCalled();
  });

  it("is rate-limited per admin, and rejects bodies that are not small JSON objects", async () => {
    await signIn();
    vi.spyOn(JOBS["deals-weekly-refresh"], "run").mockResolvedValue({ status: "OK" } as never);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await post(postRefresh, "/api/commerce/refresh", {})).status);
    expect(statuses).toEqual([200, 200, 200, 200, 429]);

    const raw = (body: string, type = "application/json") => postVerify(new Request(`${ORIGIN}/api/commerce/verify`, { method: "POST", headers: { origin: ORIGIN, "content-type": type }, body }));
    expect((await raw("{not json")).status).toBe(400);
    expect((await raw("[1,2]")).status).toBe(400);
    expect((await raw(JSON.stringify({ scope: "links", pad: "x".repeat(5000) }))).status).toBe(413);
    expect((await raw("scope=links", "application/x-www-form-urlencoded")).status).toBe(415);
  });
});

// ── Deals page query ─────────────────────────────────────────────────────────

describe("admin deals query (persisted status only)", () => {
  it("shows a never-classified offer as unclassified, filters by status, brand and reason, and attaches verification events", async () => {
    const s = await seedDeals();
    const at = new Date();
    await db.commerceOffer.update({ where: { id: s.active.id }, data: { dealStatus: "ACTIVE", dealStatusReasons: [], dealStatusAt: at } });
    await db.commerceOffer.update({ where: { id: s.noList.id }, data: { dealStatus: "VERIFIED", dealStatusReasons: [{ code: "NO_LIST_PRICE", message: "no stated list price" }], dealStatusAt: at } });
    await db.commerceVerificationEvent.createMany({
      data: [
        { entityType: "offer", entityId: s.active.id, kind: "LINK", result: "OK", checkedAt: new Date(Date.now() - 2 * HOUR) },
        { entityType: "offer", entityId: s.active.id, kind: "DEAL_STATUS", result: "ACTIVE", checkedAt: new Date(Date.now() - HOUR) },
        { entityType: "offer", entityId: s.active.id, kind: "PRICE", result: "SAME", checkedAt: new Date(Date.now() - 3 * HOUR) },
        { entityType: "offer", entityId: s.active.id, kind: "LINK", result: "OK", checkedAt: new Date(Date.now() - 4 * HOUR) },
      ],
    });
    const paging = parsePaging(() => null, 40);

    const all = await listDeals({}, paging);
    expect(all.total).toBe(4);
    const unclassified = await listDeals({ status: UNCLASSIFIED }, paging);
    expect(unclassified.items.map((d) => d.id).sort()).toEqual([s.stale.id, s.broken.id].sort());
    expect(unclassified.items.every((d) => d.dealStatus === null && d.reasons.length === 0)).toBe(true);

    const active = await listDeals({ status: "ACTIVE", brandId: s.brand.id }, paging);
    expect(active.items).toHaveLength(1);
    expect(active.items[0]).toMatchObject({ price: 799, listPrice: 999, listPriceLabel: "Regular price", saving: { amount: 200, percent: 20 }, linkStatus: "OK", dealStatus: "ACTIVE" });
    expect(active.items[0].events.map((e) => `${e.kind}:${e.result}`)).toEqual(["DEAL_STATUS:ACTIVE", "LINK:OK", "PRICE:SAME"]);

    const byReason = await listDeals({ reason: "NO_LIST_PRICE" }, paging);
    expect(byReason.items.map((d) => d.id)).toEqual([s.noList.id]);
    expect(byReason.items[0].reasons).toEqual([{ code: "NO_LIST_PRICE", label: "no stated list price (not a drop)", message: "no stated list price" }]);
    expect((await listDeals({ status: "ACTIVE", brandId: "someone-else" }, paging)).total).toBe(0);
  });
});

// ── Admin pages render (smoke) ───────────────────────────────────────────────

async function html(el: ReactElement | Promise<ReactElement>): Promise<string> {
  const { prelude } = await prerender(await el);
  return new Response(prelude).text();
}
const sp = (o: Record<string, string> = {}) => Promise.resolve(o);

describe("admin commerce pages", () => {
  it("render the registry, deals, runs and products pages from stored data; scraped javascript: URLs are never linked", async () => {
    await signIn();
    const s = await seedDeals();
    await db.commerceBrand.update({ where: { id: s.brand.id }, data: { dealUrls: ["https://frame.work/sale"], currency: "USD" } });
    await db.commerceOffer.update({ where: { id: s.active.id }, data: { dealStatus: "ACTIVE", dealStatusReasons: [], dealStatusAt: new Date() } });
    await db.commerceOffer.update({ where: { id: s.broken.id }, data: { destinationUrl: "javascript:alert(document.cookie)" } });
    await run({ brandId: s.brand.id, usageUsd: 0.5, errors: [{ code: "APIFY_RUN_FAILED", reason: "<script>alert(1)</script>" }], status: "FAILED" });

    const { default: Sources } = await import("@/app/admin/(console)/commerce/sources/page");
    const { default: Deals } = await import("@/app/admin/(console)/commerce/deals/page");
    const { default: Runs } = await import("@/app/admin/(console)/commerce/runs/page");
    const { default: Products } = await import("@/app/admin/(console)/commerce/products/page");
    const { default: Brands } = await import("@/app/admin/(console)/commerce/brands/page");

    const sources = await html(Sources({ searchParams: sp({ edit: s.brand.id }) }));
    expect(sources).toContain("Framework");
    expect(sources).toMatch(/Deal pages: (<!-- -->)?https:\/\/frame\.work\/sale/);
    expect(sources).toContain('name="dealUrls"');
    expect(sources).toContain('name="currency"');
    expect(sources).toContain("Add a brand");

    const deals = await html(Deals({ searchParams: sp() }));
    expect(deals).toContain("Not classified yet");
    expect(deals).toContain("Regular price");
    expect(deals).not.toContain('href="javascript:');
    expect(await html(Deals({ searchParams: sp({ status: "UNCLASSIFIED" }) }))).toContain("Framework Laptop 12");

    const runs = await html(Runs({ searchParams: sp() }));
    expect(runs).toContain("APIFY_RUN_FAILED");
    expect(runs).toContain("&lt;script&gt;");
    expect(runs).not.toContain("<script>alert(1)</script>");
    expect(runs).toContain("$0.500");

    const products = await html(Products({ searchParams: sp({ id: s.product.id }) }));
    expect(products).toContain("Deal status");
    expect(products).toContain("Not classified yet");
    expect(products).not.toContain('href="javascript:');

    await expect(Brands({ searchParams: sp({ edit: s.brand.id, ok: "saved" }) })).rejects.toThrow(`NEXT_REDIRECT /admin/commerce/sources?edit=${s.brand.id}&ok=saved#edit`);
  });
});
