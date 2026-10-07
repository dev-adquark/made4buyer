import { afterEach, describe, expect, it } from "vitest";
import { couponRecheckHours } from "@/lib/commerce/coupons-run";
import { classifyCoupons, couponDealStatus, couponMaxAgeDays, couponSourceTier, couponVerifiedSince, DEFAULT_COUPON_MAX_AGE_DAYS, publicCoupons, type DealBrandInput, type DealCouponInput } from "@/lib/commerce/deal-status";
import { withEnv } from "../support/env";

/**
 * THE public coupon rule (lib/commerce/deal-status.ts): couponDealStatus for one row, classifyCoupons
 * for duplicates / conflicts across rows, publicCoupons for what any public surface may show, and the
 * re-verification cadence that keeps a still-published code inside the window (couponRecheckHours).
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-15T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms);
const ahead = (ms: number) => new Date(NOW + ms);

const brand: DealBrandInput = { name: "Framework", officialDomain: "frame.work", officialStoreUrl: "https://framework-store.myshopify.com/" };
const OFFICIAL = "https://frame.work/promotions";
const STORE = "https://framework-store.myshopify.com/pages/offers";

type Row = DealCouponInput & { id: string };
let seq = 0;
const row = (over: Partial<Row> = {}): Row => ({ id: `c${++seq}`, brandId: "b1", merchant: "Framework", code: "SAVE10", discount: "10% off laptops", status: "VERIFIED", startsAt: null, expiresAt: null, lastVerifiedAt: ago(DAY), observedAt: ago(DAY), sourceUrl: OFFICIAL, brand, ...over });
const status = (over: Partial<Row> = {}, opts = {}) => couponDealStatus(row(over), NOW, opts);
const reasons = (over: Partial<Row> = {}, opts = {}) => status(over, opts).reasons.map((r) => r.code);
const isPublic = (over: Partial<Row> = {}, opts = {}) => publicCoupons([row(over)], NOW, opts).length === 1;

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("the 7-day verification window", () => {
  it("defaults to 7 days, inclusive at exactly 7 days, hidden 1 ms later", () => {
    restore = withEnv({ COMMERCE_COUPON_MAX_AGE_DAYS: undefined });
    expect(couponMaxAgeDays()).toBe(DEFAULT_COUPON_MAX_AGE_DAYS);
    expect(DEFAULT_COUPON_MAX_AGE_DAYS).toBe(7);

    expect(status({ lastVerifiedAt: ago(7 * DAY) })).toEqual({ status: "ACTIVE", reasons: [] });
    expect(isPublic({ lastVerifiedAt: ago(7 * DAY) })).toBe(true);

    const late = status({ lastVerifiedAt: ago(7 * DAY + 1) });
    expect(late.status).toBe("EXPIRED");
    expect(late.reasons.map((r) => r.code)).toEqual(["COUPON_NOT_RESEEN"]);
    expect(isPublic({ lastVerifiedAt: ago(7 * DAY + 1) })).toBe(false);

    // The same instant as an ISO string (the shape the cached page data carries).
    expect(status({ lastVerifiedAt: ago(7 * DAY).toISOString() }).status).toBe("ACTIVE");
    expect(status({ lastVerifiedAt: ago(7 * DAY + 1).toISOString() }).status).toBe("EXPIRED");
  });

  it("2 days old is shown, 8 days old is not", () => {
    expect(isPublic({ lastVerifiedAt: ago(2 * DAY) })).toBe(true);
    expect(isPublic({ lastVerifiedAt: ago(8 * DAY) })).toBe(false);
  });

  it("a code never verified is not public", () => {
    expect(reasons({ lastVerifiedAt: null })).toEqual(["COUPON_NOT_RESEEN"]);
    expect(isPublic({ lastVerifiedAt: null })).toBe(false);
  });

  it("COMMERCE_COUPON_MAX_AGE_DAYS moves the boundary; out-of-range or non-numeric values fall back to 7", () => {
    restore = withEnv({ COMMERCE_COUPON_MAX_AGE_DAYS: "3" });
    expect(couponMaxAgeDays()).toBe(3);
    expect(status({ lastVerifiedAt: ago(3 * DAY) }).status).toBe("ACTIVE");
    expect(status({ lastVerifiedAt: ago(3 * DAY + 1) }).status).toBe("EXPIRED");
    expect(couponVerifiedSince(NOW).getTime()).toBe(NOW - 3 * DAY);
    restore();
    for (const bad of ["0", "91", "-5", "abc", ""]) {
      restore = withEnv({ COMMERCE_COUPON_MAX_AGE_DAYS: bad });
      expect(couponMaxAgeDays(), `COMMERCE_COUPON_MAX_AGE_DAYS=${JSON.stringify(bad)}`).toBe(7);
      restore();
    }
    restore = withEnv({ COMMERCE_COUPON_MAX_AGE_DAYS: "90" });
    expect(couponMaxAgeDays()).toBe(90);
  });

  it("an explicit maxAgeDays option wins over the environment", () => {
    restore = withEnv({ COMMERCE_COUPON_MAX_AGE_DAYS: "30" });
    expect(status({ lastVerifiedAt: ago(8 * DAY) }).status).toBe("ACTIVE");
    expect(status({ lastVerifiedAt: ago(8 * DAY) }, { maxAgeDays: 7 }).status).toBe("EXPIRED");
  });
});

describe("expiry and start", () => {
  it("expired: stored EXPIRED, or the stated expiry has passed (an expiry at exactly now has passed)", () => {
    expect(status({ status: "EXPIRED" }).status).toBe("EXPIRED");
    expect(reasons({ status: "EXPIRED" })).toContain("COUPON_EXPIRED");
    expect(reasons({ expiresAt: ago(1) })).toEqual(["COUPON_EXPIRED"]);
    expect(reasons({ expiresAt: new Date(NOW) })).toEqual(["COUPON_EXPIRED"]);
    expect(status({ expiresAt: ahead(1) }).status).toBe("ACTIVE");
    for (const over of [{ status: "EXPIRED" }, { expiresAt: ago(HOUR) }, { expiresAt: new Date(NOW) }]) expect(isPublic(over)).toBe(false);
    // A stored EXPIRED is final even with a stated expiry still ahead.
    expect(status({ status: "EXPIRED", expiresAt: ahead(DAY) }).status).toBe("EXPIRED");
  });

  it("not started: VERIFIED but never public until its stated start", () => {
    const future = status({ startsAt: ahead(1) });
    expect(future.status).toBe("VERIFIED");
    expect(future.reasons.map((r) => r.code)).toEqual(["COUPON_NOT_STARTED"]);
    expect(isPublic({ startsAt: ahead(2 * DAY) })).toBe(false);
    expect(status({ startsAt: new Date(NOW) }).status).toBe("ACTIVE");
    expect(status({ startsAt: ago(DAY), expiresAt: ahead(DAY) }).status).toBe("ACTIVE");
  });
});

describe("stored statuses other than VERIFIED are never public", () => {
  it.each([
    ["INVALID", "INVALID", "COUPON_INVALID"],
    ["CONFLICTING", "CONFLICTING", "COUPON_CONFLICTING"],
    ["UNVERIFIED", "UNVERIFIED", "COUPON_UNVERIFIED"],
    ["UNKNOWN", "UNVERIFIED", "COUPON_UNVERIFIED"],
    ["PENDING", "UNVERIFIED", "COUPON_UNVERIFIED"],
  ])("%s → %s", (stored, expected, reason) => {
    const v = status({ status: stored, lastVerifiedAt: ago(HOUR) });
    expect(v.status).toBe(expected);
    expect(v.reasons.map((r) => r.code)).toContain(reason);
    expect(isPublic({ status: stored, lastVerifiedAt: ago(HOUR) })).toBe(false);
  });

  it("no code (empty or whitespace) is INVALID", () => {
    for (const code of ["", "   ", null]) {
      expect(status({ code }).status).toBe("INVALID");
      expect(isPublic({ code })).toBe(false);
    }
  });
});

describe("source: the brand's official site (tier 1) or official store (tier 2) only", () => {
  it("official domain, a subdomain of it, and the official store are public with their tier", () => {
    expect(couponSourceTier(OFFICIAL, brand)).toBe(1);
    expect(couponSourceTier("https://www.frame.work/deals", brand)).toBe(1);
    expect(couponSourceTier("https://shop.frame.work/deals", brand)).toBe(1);
    expect(couponSourceTier(STORE, brand)).toBe(2);
    expect(isPublic({ sourceUrl: "https://shop.frame.work/deals" })).toBe(true);
    expect(isPublic({ sourceUrl: STORE })).toBe(true);
  });

  it("any other domain, a look-alike domain, an unparseable URL, or no brand is UNVERIFIED", () => {
    for (const sourceUrl of ["https://www.retailmenot.com/view/frame.work", "https://frame.work.evil.example/promotions", "https://notframe.work/promotions", "not a url", null]) {
      const v = status({ sourceUrl });
      expect(v.status, String(sourceUrl)).toBe("UNVERIFIED");
      expect(v.reasons.map((r) => r.code)).toContain("COUPON_NOT_FIRST_PARTY");
      expect(isPublic({ sourceUrl })).toBe(false);
    }
    expect(status({ brand: null }).status).toBe("UNVERIFIED");
    expect(isPublic({ brand: null })).toBe(false);
  });

  it("an APPROVED third-party source (retailer tier 3, coupon site tier 4) is known but never public", () => {
    const approvedSources = [
      { domain: "bestbuy.com", kind: "RETAILER" },
      { domain: "coupons.example.com", kind: "COUPON_SITE" },
    ];
    expect(couponSourceTier("https://www.bestbuy.com/site/promo", brand, approvedSources)).toBe(3);
    expect(couponSourceTier("https://coupons.example.com/framework", brand, approvedSources)).toBe(4);
    for (const sourceUrl of ["https://www.bestbuy.com/site/promo", "https://coupons.example.com/framework"]) {
      const v = status({ sourceUrl, lastVerifiedAt: ago(HOUR) }, { approvedSources });
      expect(v.status).toBe("UNVERIFIED");
      expect(v.reasons.map((r) => r.code)).toEqual(["COUPON_NOT_FIRST_PARTY"]);
      expect(publicCoupons([row({ sourceUrl, lastVerifiedAt: ago(HOUR) })], NOW, { approvedSources })).toEqual([]);
    }
  });
});

describe("duplicates: one listing per brand + code", () => {
  it("the official site wins over the official store even when the store saw it more recently", () => {
    const store = row({ id: "store", sourceUrl: STORE, lastVerifiedAt: ago(HOUR) });
    const site = row({ id: "site", sourceUrl: OFFICIAL, lastVerifiedAt: ago(3 * DAY) });
    expect(publicCoupons([store, site], NOW).map((c) => c.id)).toEqual(["site"]);
    const byId = Object.fromEntries(classifyCoupons([store, site], NOW).map((x) => [x.coupon.id, x.verdict]));
    expect(byId.store.status).toBe("VERIFIED");
    expect(byId.store.reasons.map((r) => r.code)).toEqual(["COUPON_DUPLICATE"]);
    expect(byId.site.status).toBe("ACTIVE");
  });

  it("within one tier the most recently verified wins; the code match ignores case and spacing", () => {
    const older = row({ id: "older", sourceUrl: "https://frame.work/promotions", lastVerifiedAt: ago(2 * DAY) });
    const newer = row({ id: "newer", code: " save10 ", sourceUrl: "https://frame.work/deals", lastVerifiedAt: ago(HOUR) });
    expect(publicCoupons([older, newer], NOW).map((c) => c.id)).toEqual(["newer"]);
  });

  it("the same code at two different brands is two listings", () => {
    const other: DealBrandInput = { name: "Acme", officialDomain: "acme.com" };
    const a = row({ id: "a" });
    const b = row({ id: "b", brandId: "b2", merchant: "Acme", brand: other, sourceUrl: "https://acme.com/offers" });
    expect(publicCoupons([a, b], NOW).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("a hidden row (expired, stale, third-party) never displaces the public one", () => {
    const good = row({ id: "good", lastVerifiedAt: ago(2 * DAY) });
    const stale = row({ id: "stale", lastVerifiedAt: ago(8 * DAY) });
    const third = row({ id: "third", sourceUrl: "https://coupons.example.com/framework", lastVerifiedAt: ago(HOUR) });
    const gone = row({ id: "gone", status: "EXPIRED", lastVerifiedAt: ago(HOUR) });
    expect(publicCoupons([stale, third, gone, good], NOW).map((c) => c.id)).toEqual(["good"]);
  });
});

describe("conflicts: official pages that disagree hide the code", () => {
  it("different stated offers for one code within the window: both CONFLICTING, none public", () => {
    const a = row({ id: "a", discount: "10% off laptops", sourceUrl: "https://frame.work/promotions" });
    const b = row({ id: "b", discount: "15% off laptops", sourceUrl: "https://frame.work/deals" });
    expect(classifyCoupons([a, b], NOW).map((x) => x.verdict.status)).toEqual(["CONFLICTING", "CONFLICTING"]);
    expect(publicCoupons([a, b], NOW)).toEqual([]);
  });

  it("different stated expiries conflict; the same offer differing only in letter case does not", () => {
    const a = row({ id: "a", expiresAt: ahead(3 * DAY) });
    const b = row({ id: "b", expiresAt: ahead(5 * DAY), sourceUrl: "https://frame.work/deals" });
    expect(publicCoupons([a, b], NOW)).toEqual([]);
    const c = row({ id: "c", discount: "10% OFF LAPTOPS", sourceUrl: "https://frame.work/deals", lastVerifiedAt: ago(HOUR) });
    expect(publicCoupons([row({ id: "d" }), c], NOW).map((x) => x.id)).toEqual(["c"]);
  });

  it("a stored CONFLICTING observation within the window hides the code; one older than the window does not", () => {
    const good = row({ id: "good" });
    const recentConflict = row({ id: "conflict", status: "CONFLICTING", sourceUrl: "https://frame.work/deals", observedAt: ago(6 * DAY), lastVerifiedAt: ago(6 * DAY) });
    expect(publicCoupons([good, recentConflict], NOW)).toEqual([]);
    expect(classifyCoupons([good, recentConflict], NOW)[0].verdict.status).toBe("CONFLICTING");
    const oldConflict = row({ id: "old", status: "CONFLICTING", sourceUrl: "https://frame.work/deals", observedAt: ago(8 * DAY), lastVerifiedAt: ago(8 * DAY) });
    expect(publicCoupons([good, oldConflict], NOW).map((c) => c.id)).toEqual(["good"]);
  });

  it("a stale row stating different terms does not conflict with the current one", () => {
    const current = row({ id: "current", discount: "10% off laptops" });
    const stale = row({ id: "stale", discount: "25% off laptops", sourceUrl: "https://frame.work/deals", lastVerifiedAt: ago(9 * DAY) });
    expect(publicCoupons([current, stale], NOW).map((c) => c.id)).toEqual(["current"]);
  });
});

describe("couponRecheckHours: a still-published code is re-verified inside the window", () => {
  it("defaults to 120 h (window 7 days minus 2 days of slack)", () => {
    restore = withEnv({ COMMERCE_COUPON_MAX_AGE_DAYS: undefined });
    expect(couponRecheckHours()).toBe(120);
  });

  it("is never under 24 h and always leaves at least 2 days of slack once the window allows it", () => {
    for (let days = 1; days <= 90; days++) {
      restore = withEnv({ COMMERCE_COUPON_MAX_AGE_DAYS: String(days) });
      const h = couponRecheckHours();
      expect(h, `window ${days} d`).toBeGreaterThanOrEqual(24);
      if (days >= 3) expect(h, `window ${days} d`).toBe((days - 2) * 24);
      else expect(h, `window ${days} d`).toBe(24);
      expect(h, `window ${days} d: re-checked before the window closes`).toBeLessThanOrEqual(days * 24);
      restore();
      restore = null;
    }
  });

  it("an invalid window setting falls back to the 7-day cadence", () => {
    restore = withEnv({ COMMERCE_COUPON_MAX_AGE_DAYS: "500" });
    expect(couponRecheckHours()).toBe(120);
  });
});
