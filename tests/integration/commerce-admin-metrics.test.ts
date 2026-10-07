import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { commerceMetrics, nextCommerceRuns } from "@/lib/commerce/admin-actions";
import { DATA_AUDIT_SETTING } from "@/lib/ops/data-audit";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Fixed clock: mid-month, so "this month" and "last 24 h" never straddle a month boundary. */
const NOW = new Date("2026-10-15T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const LAST_MONTH = new Date("2026-09-20T08:00:00Z");

let restoreEnv: () => void = () => {};
beforeEach(async () => {
  await resetDb();
  restoreEnv = withEnv({ COMMERCE_MONTHLY_BUDGET_USD: undefined, PRODUCT_PRICE_MAX_AGE_HOURS: undefined, COMMERCE_COUPON_MAX_AGE_DAYS: undefined });
});
afterEach(() => restoreEnv());

const run = (status: string, startedAt: Date, data: Record<string, unknown> = {}) =>
  db.commerceRun.create({ data: { purpose: "PRODUCT", actorId: "apify/web-scraper", trigger: "test", status, startedAt, ...data } });

let p = 0;
const product = (brandId: string, identityStatus: string) => {
  p++;
  return db.commerceProduct.create({ data: { brandId, canonicalUrl: `https://www.acme-audio.com/products/p${p}`, name: `Acme Speaker ${p}`, identityStatus, observedAt: ago(HOUR) } });
};

const offer = (productId: string, data: Record<string, unknown> = {}) =>
  db.commerceOffer.create({
    data: { productId, seller: "Acme", sellerType: "MANUFACTURER", destinationUrl: "https://www.acme-audio.com/products/p1", price: 90, currency: "USD", observedAt: ago(2 * HOUR), linkStatus: "OK", ...data },
  });

let c = 0;
const coupon = (brandId: string, data: Record<string, unknown> = {}) => {
  c++;
  return db.commerceCoupon.create({ data: { brandId, merchant: "Acme", code: `SAVE${c}`, sourceUrl: "https://www.acme-audio.com/promotions", observedAt: ago(DAY), discount: "10% off", ...data } });
};

/** Seeds one known data set; every expected number below is derived from it by hand. */
async function seed() {
  // Runs this month: $5 + $10 + $1 = $16 used. Last month's $50 must not count.
  await run("SUCCEEDED", ago(2 * HOUR), { usageUsd: 5, finishedAt: ago(HOUR) });
  await run("COLLECTED", ago(3 * DAY), { usageUsd: 10, finishedAt: ago(3 * DAY - 600_000), collectedAt: ago(3 * DAY - 300_000) });
  await run("FAILED", ago(HOUR), { usageUsd: 1 });
  await run("COLLECT_FAILED", ago(5 * DAY));
  await run("START_FAILED", ago(30 * 60_000));
  await run("SKIPPED", ago(10 * 60_000));
  await run("COLLECTED", LAST_MONTH, { usageUsd: 50, finishedAt: LAST_MONTH });

  const brand = await db.commerceBrand.create({ data: { name: "Acme", slug: "acme", officialDomain: "acme-audio.com", categories: ["audio"] } });
  const p1 = await product(brand.id, "MATCHED");
  await product(brand.id, "MATCH_REJECTED");
  await product(brand.id, "UNMATCHED");
  await product(brand.id, "UNMATCHED");

  // Public (fresh, link not hidden, USD, price > 0): a, b, i.
  await offer(p1.id, { price: 80, listPrice: 100, observedAt: ago(HOUR) }); // a: also the one price drop
  await offer(p1.id, { seller: "Best Buy", sellerType: "RETAILER", destinationUrl: "https://www.bestbuy.com/site/acme/1.p", linkStatus: "UNCHECKED" }); // b
  await offer(p1.id, { seller: "Best Buy", sellerType: "RETAILER", destinationUrl: "https://www.bestbuy.com/site/acme/1.p?utm_source=mail" }); // i: duplicate of b
  await offer(p1.id, { destinationUrl: "https://www.acme-audio.com/en-gb/products/p1", price: 70, listPrice: 95, currency: "GBP" }); // c: not USD
  await offer(p1.id, { destinationUrl: "https://www.acme-audio.com/products/p1-b", price: null }); // d: no price
  await offer(p1.id, { destinationUrl: "https://www.acme-audio.com/products/p1-c", price: 60, listPrice: 100, linkStatus: "BROKEN" }); // e: hidden link
  await offer(p1.id, { destinationUrl: "https://www.acme-audio.com/products/p1-d", status: "STALE", linkStatus: "OFF_SITE" }); // f: hidden + stale
  await offer(p1.id, { destinationUrl: "https://www.acme-audio.com/products/p1-e", price: 50, listPrice: 100, observedAt: ago(72 * HOUR) }); // g: FRESH past the 48 h window
  await offer(p1.id, { destinationUrl: "https://www.acme-audio.com/products/p1-f", status: "STALE", observedAt: ago(100 * HOUR) }); // h: stale

  // Price rejections: 2 this month, 1 last month; another action does not count.
  for (const at of [ago(DAY), ago(2 * DAY), LAST_MONTH]) await db.auditLog.create({ data: { actor: "system", action: "PRICE_REJECTED", entityType: "commerce_product", entityId: p1.id, createdAt: at } });
  await db.auditLog.create({ data: { actor: "system", action: "PRICE_UPDATED", entityType: "commerce_product", entityId: p1.id, createdAt: ago(DAY) } });

  // Coupons: 6 total; VERIFIED + active (started, unexpired) = 2; shown on /deals = 1.
  await coupon(brand.id, { status: "VERIFIED", lastVerifiedAt: ago(DAY) });
  await coupon(brand.id, { status: "VERIFIED", lastVerifiedAt: ago(30 * DAY) }); // active, but not re-seen recently: not public
  await coupon(brand.id, { status: "VERIFIED", lastVerifiedAt: ago(DAY), expiresAt: ago(DAY) });
  await coupon(brand.id, { status: "VERIFIED", lastVerifiedAt: ago(DAY), startsAt: new Date(NOW.getTime() + 2 * DAY) });
  await coupon(brand.id, { status: "CONFLICTING" });
  await coupon(brand.id, { status: "UNVERIFIED" });

  // One product entity whose facts conflict.
  await db.productEntity.create({ data: { slug: "acme-one", name: "Acme One", matchKey: "acme one", factSummary: { conflicting: ["weight"] } } });
}

describe("commerceMetrics", () => {
  it("reports every overview number from the seeded data", async () => {
    await seed();
    const m = await commerceMetrics(NOW);

    expect(m.monthStart.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(m.budget.budgetUsd).toBe(30);
    expect(m.budget.usedUsd).toBeCloseTo(16);
    expect(m.budget.remainingUsd).toBeCloseTo(14);
    expect(m.budget.ratio).toBeCloseTo(16 / 30);
    expect(m.budget.warn).toBe(false);
    expect(m.budget.exhausted).toBe(false);
    expect(m.budget.pausedUntil).toBeNull();

    expect(m.runs.last24h).toEqual({ total: 4, succeeded: 1, failed: 2 });
    expect(m.runs.month).toEqual({ total: 6, succeeded: 2, failed: 3 });
    expect(m.runs.lastSuccessAt?.toISOString()).toBe(ago(HOUR).toISOString());

    expect(m.products).toEqual({ total: 4, matched: 1, rejected: 1, unmatched: 2 });
    expect(m.offers).toEqual({ total: 9, public: 3, stale: 3, hiddenLink: 2, priceRejectedThisMonth: 2, duplicateGroups: 1 });
    expect(m.conflicts).toEqual({ coupons: 1, factFields: 1, total: 2 });
    expect(m.integrity.source).toBe("live");
    expect(m.integrity.lastAuditAt).toBeNull();
    expect(m.coupons).toEqual({ total: 6, verifiedActive: 2, publicCodes: 1 });
    expect(m.deals.priceDrops).toBe(1);

    // Deals by status (lib/commerce/deal-status.ts, the functions /deals uses), from the same seed:
    // a ACTIVE · b, i UNVERIFIED (retailer, product not confirmed on the official site) · c INVALID (GBP)
    // · d INVALID (no price) · e, f BROKEN · g EXPIRED (past 48 h) · h EXPIRED (STALE).
    expect(m.dealStatus.offers.byStatus).toEqual({ ACTIVE: 1, VERIFIED: 0, EXPIRED: 2, INVALID: 2, BROKEN: 2, CONFLICTING: 0, UNVERIFIED: 2 });
    expect(m.dealStatus.offers).toMatchObject({ total: 9, stored: 9, truncated: false });
    expect(m.dealStatus.offers.topReasons.BROKEN).toEqual([{ code: "LINK_BROKEN", count: 2 }]);
    expect(m.dealStatus.offers.topReasons.EXPIRED).toEqual([{ code: "NOT_FRESH", count: 1 }, { code: "STALE", count: 1 }]);
    expect(m.dealStatus.offers.topReasons.INVALID).toEqual([{ code: "NO_PRICE", count: 1 }, { code: "NOT_USD", count: 1 }]);
    expect(m.dealStatus.offers.topReasons.UNVERIFIED).toEqual([{ code: "NO_OFFICIAL_CONFIRMATION", count: 2 }]);
    // Coupons: 1 ACTIVE · 2 EXPIRED (not re-seen in 30 days; stated expiry passed) · 1 VERIFIED (starts later) · 1 CONFLICTING · 1 UNVERIFIED.
    expect(m.dealStatus.coupons.byStatus).toEqual({ ACTIVE: 1, VERIFIED: 1, EXPIRED: 2, INVALID: 0, BROKEN: 0, CONFLICTING: 1, UNVERIFIED: 1 });
    expect(m.dealStatus.coupons.topReasons.EXPIRED).toEqual([{ code: "COUPON_EXPIRED", count: 1 }, { code: "COUPON_NOT_RESEEN", count: 1 }]);
    expect(m.dealStatus.coupons.topReasons.VERIFIED).toEqual([{ code: "COUPON_NOT_STARTED", count: 1 }]);
    expect(m.dealStatus).toMatchObject({ publicPriceDrops: 1, publicPromoCodes: 1, brokenLinks: 2 });
    // The ACTIVE counts are exactly what /deals lists.
    expect(m.dealStatus.offers.byStatus.ACTIVE).toBe(m.deals.priceDrops);
    expect(m.dealStatus.coupons.byStatus.ACTIVE).toBe(m.coupons.publicCodes);
  });

  it("is all zeros on an empty database", async () => {
    const m = await commerceMetrics(NOW);
    expect(m.budget.usedUsd).toBe(0);
    expect(m.budget.remainingUsd).toBe(30);
    expect(m.runs.lastSuccessAt).toBeNull();
    expect(m.products.total + m.offers.total + m.offers.public + m.coupons.total + m.deals.priceDrops + m.conflicts.total + m.offers.duplicateGroups).toBe(0);
    expect(m.dealStatus.offers.total + m.dealStatus.coupons.total + m.dealStatus.brokenLinks).toBe(0);
  });

  it("warns at 80% of the budget and pauses until the next UTC month at 100%", async () => {
    await run("COLLECTED", ago(DAY), { usageUsd: 16 });

    let restore = withEnv({ COMMERCE_MONTHLY_BUDGET_USD: "20" });
    try {
      const m = await commerceMetrics(NOW);
      expect(m.budget.ratio).toBeCloseTo(0.8);
      expect(m.budget.warn).toBe(true);
      expect(m.budget.exhausted).toBe(false);
      expect(m.budget.remainingUsd).toBeCloseTo(4);
      expect(m.budget.pausedUntil).toBeNull();
    } finally {
      restore();
    }

    restore = withEnv({ COMMERCE_MONTHLY_BUDGET_USD: "16" });
    try {
      const m = await commerceMetrics(NOW);
      expect(m.budget.exhausted).toBe(true);
      expect(m.budget.remainingUsd).toBe(0);
      expect(m.budget.pausedUntil?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    } finally {
      restore();
    }

    // December rolls over to January.
    await run("COLLECTED", new Date("2026-12-10T00:00:00Z"), { usageUsd: 99 });
    const dec = await commerceMetrics(new Date("2026-12-31T23:00:00Z"));
    expect(dec.budget.pausedUntil?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("labels the stored data-audit timestamp", async () => {
    const finishedAt = "2026-10-15T11:00:00.000Z";
    await db.automationSetting.create({ data: { key: DATA_AUDIT_SETTING, value: JSON.stringify({ status: "OK", trigger: "cron", startedAt: finishedAt, finishedAt, durationMs: 1, counts: { "duplicate-offers": 7 }, fixed: { offersMarkedStale: 0, couponsMarkedExpired: 0 }, totalFlagged: 7 }) } });
    const m = await commerceMetrics(NOW);
    // Counts are computed live (the stored 7 is history), and the stored run's time is reported.
    expect(m.integrity.source).toBe("live");
    expect(m.offers.duplicateGroups).toBe(0);
    expect(m.integrity.lastAuditAt?.toISOString()).toBe(finishedAt);
  });
});

describe("nextCommerceRuns", () => {
  it("recognises commerce-discover cron paths with a query string", () => {
    // 12:41 UTC: the hourly GitHub pass (minute 40) has just gone; the next is the Vercel pass at 13:05.
    const at1241 = nextCommerceRuns(new Date("2026-10-15T12:41:00Z")).find((r) => r.job === "commerce-discover");
    expect(at1241?.at.toISOString()).toBe("2026-10-15T13:05:00.000Z");
    expect(at1241?.path).toBe("/api/cron/commerce-discover?pass=13");
    expect(at1241?.origin).toBe("vercel");
    // 24 hourly Vercel passes (23 with ?pass=HH plus the plain path) + the GitHub schedule.
    expect(at1241?.schedules).toBeGreaterThanOrEqual(25);

    // 09:41: next is the plain-path 10:05 pass.
    const at0941 = nextCommerceRuns(new Date("2026-10-15T09:41:00Z")).find((r) => r.job === "commerce-discover");
    expect(at0941?.path).toBe("/api/cron/commerce-discover");
    expect(at0941?.at.toISOString()).toBe("2026-10-15T10:05:00.000Z");
  });

  it("lists each commerce job once, soonest first", () => {
    const runs = nextCommerceRuns(NOW);
    const jobs = runs.map((r) => r.job);
    expect(new Set(jobs).size).toBe(jobs.length);
    expect(jobs).toContain("commerce-discover");
    expect(jobs.every((j) => j.startsWith("commerce-"))).toBe(true);
    for (let i = 1; i < runs.length; i++) expect(runs[i].at.getTime()).toBeGreaterThanOrEqual(runs[i - 1].at.getTime());
  });
});
