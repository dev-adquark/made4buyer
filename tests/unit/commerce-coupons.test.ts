import { describe, expect, it } from "vitest";
import { markCrossPageConflicts, normalizeCoupons, notACodeReason, parseStatedDate, statedDiscount, statedExpiry, verifyCoupon, type CouponObservation } from "@/lib/commerce/coupons";
import { buildCouponActorInput } from "@/lib/commerce/coupons-run";
import { COUPON_PAGE_FUNCTION, findCodesInText } from "@/lib/commerce/page-functions/coupon";

const brand = { id: "b1", name: "Acme", officialDomain: "acme.example", market: "US" };
const page = (candidates: unknown[], over: Record<string, unknown> = {}) => ({ m4bCoupon: 1, url: "https://www.acme.example/promotions", title: "Offers", candidates, jsonLd: [], ...over });
const cand = (code: string, context: string, element = "text") => ({ code, context, element });

describe("code extraction", () => {
  it("finds codes named by promo phrases", () => {
    expect(findCodesInText("Use code SAVE20 at checkout. Promo code: FALL-25 ends soon. Code: WELCOME10")).toEqual(["SAVE20", "FALL-25", "WELCOME10"]);
    expect(findCodesInText("The coupon code is SPRING15.")).toEqual(["SPRING15"]);
  });

  it("ignores words after 'code' that are not codes", () => {
    expect(findCodesInText("Use code at checkout. Enter code here. No code needed. Code below.")).toEqual([]);
    expect(findCodesInText("Promo code: 123456")).toEqual([]); // all digits
    expect(findCodesInText("Use code THISCODEISWAYTOOLONGTOBEREAL")).toEqual([]); // > 20 chars
  });

  it("drops common words, all-digit and CSS/class-like tokens", () => {
    for (const t of ["FREE", "SAVE", "CODE", "CHECKOUT", "SHIPPING", "COPY"]) expect(notACodeReason(t)).toBe("common word");
    for (const t of ["BTN-PRIMARY", "COL-MD-6", "100PX", "AAAA"]) expect(notACodeReason(t)).toBe("CSS/class-like token");
    expect(notACodeReason("123456")).toMatch(/letter/);
    expect(notACodeReason("save20")).toMatch(/uppercase/);
    expect(notACodeReason("-SAVE20")).not.toBeNull();
    expect(notACodeReason("SAVE20")).toBeNull();
    expect(notACodeReason("FALL-25")).toBeNull();
  });

  it("the page function is a bounded, self-contained function", () => {
    expect(COUPON_PAGE_FUNCTION.startsWith("async function pageFunction(context)")).toBe(true);
    expect(COUPON_PAGE_FUNCTION).toContain("m4bCoupon: 1");
    expect(COUPON_PAGE_FUNCTION).toContain("const MAX = 50");
    // Parses as JavaScript.
    expect(() => new Function(`return (${COUPON_PAGE_FUNCTION})`)).not.toThrow();
  });

  it("actor input: promo URLs only, depth 0, one page each, concurrency 1, robots respected", () => {
    const input = buildCouponActorInput(["https://acme.example/a", "https://acme.example/b"], "acme");
    expect(input).toMatchObject({ maxCrawlingDepth: 0, maxPagesPerCrawl: 2, maxConcurrency: 1, respectRobotsTxtFile: true, proxyConfiguration: { useApifyProxy: true } });
    expect(input.startUrls).toEqual([{ url: "https://acme.example/a" }, { url: "https://acme.example/b" }]);
  });
});

describe("normalizeCoupons: only what the page states", () => {
  it("quotes the discount exactly and types it only when the text says so", () => {
    const r = normalizeCoupons(page([cand("SAVE20", "Use code SAVE20 for 20% off sitewide. Offer ends Oct 31, 2026. Exclusions apply.")]), brand);
    expect(r.coupons).toHaveLength(1);
    expect(r.coupons[0]).toMatchObject({ merchant: "Acme", code: "SAVE20", discount: "20% off", discountType: "PERCENT", firstParty: true, sufficient: true, merchantUrl: "https://www.acme.example", restrictions: "Exclusions apply." });
    expect(r.coupons[0].expiresAt?.toISOString()).toBe("2026-10-31T23:59:59.999Z");
    expect(statedDiscount("Take $15 off orders over $75 with code TAKE15")).toEqual({ discount: "$15 off", type: "AMOUNT" });
    expect(statedDiscount("Free standard shipping with code SHIPIT")).toEqual({ discount: "Free standard shipping", type: "FREE_SHIPPING" });
  });

  it("never invents a discount or a date", () => {
    const r = normalizeCoupons(page([cand("WELCOME", "Use code WELCOME at checkout. Limited time.")]), brand);
    expect(r.coupons[0]).toMatchObject({ discount: null, discountType: null, expiresAt: null, startsAt: null, eligibility: null });
    // A date without a year, or an impossible date, is not a date.
    expect(statedExpiry("Use code FALL25. Ends Oct 31.")).toBeNull();
    expect(statedExpiry("Use code FALL25. Expires 02/31/2026.")).toBeNull();
    expect(parseStatedDate("2026-13-01")).toBeNull();
    // Numeric dates outside the US are only read when unambiguous.
    expect(parseStatedDate("05/06/2026", { market: "GB" })).toBeNull();
    expect(parseStatedDate("25/06/2026", { market: "GB" })?.toISOString()).toBe("2026-06-25T00:00:00.000Z");
  });

  it("reads JSON-LD offers only when they name a code", () => {
    const jsonLd = [
      { "@type": "Offer", name: "Fall sale: 25% off", couponCode: "FALL25", validFrom: "2026-10-01", validThrough: "2026-10-31T23:00:00Z" },
      { "@type": "Offer", name: "Everyday low price", priceSpecification: { price: 10 } },
    ];
    const r = normalizeCoupons(page([], { jsonLd }), brand);
    expect(r.coupons.map((c) => c.code)).toEqual(["FALL25"]);
    expect(r.coupons[0]).toMatchObject({ discount: "25% off", discountType: "PERCENT", evidence: "JSONLD" });
    expect(r.coupons[0].startsAt?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(r.coupons[0].expiresAt?.toISOString()).toBe("2026-10-31T23:00:00.000Z");
  });

  it("drops false positives and records why", () => {
    const r = normalizeCoupons(page([cand("BTN-PRIMARY", "Shop now", 'div data-code="BTN-PRIMARY"'), cand("FREE", "Use code FREE"), cand("12345", "Code: 12345")]), brand);
    expect(r.coupons).toEqual([]);
    expect(r.dropped.map((d) => d.code).sort()).toEqual(["12345", "BTN-PRIMARY", "FREE"]);
  });

  it("marks a code that is not presented as a promotion as insufficient evidence", () => {
    const r = normalizeCoupons(page([cand("XK29QZ", "Model XK29QZ in stock", 'span data-code="XK29QZ"')]), brand);
    expect(r.coupons[0]).toMatchObject({ code: "XK29QZ", sufficient: false });
  });

  it("is not first-party off the official domain", () => {
    const r = normalizeCoupons(page([cand("SAVE20", "Use code SAVE20 for 20% off")], { url: "https://coupons.example/acme" }), brand);
    expect(r.coupons[0].firstParty).toBe(false);
  });

  it("flags disagreement on one page and across official pages", () => {
    const one = normalizeCoupons(page([cand("SAVE20", "Use code SAVE20 for 20% off"), cand("SAVE20", "Use code SAVE20 for 30% off")]), brand);
    expect(one.coupons[0].conflict).toMatch(/20% off.*30% off/);
    const a = normalizeCoupons(page([cand("FALL25", "Use code FALL25 for 25% off. Ends Oct 31, 2026")]), brand).coupons;
    const b = normalizeCoupons(page([cand("FALL25", "Use code FALL25 for 25% off. Ends Nov 30, 2026")], { url: "https://acme.example/deals" }), brand).coupons;
    const both = markCrossPageConflicts([...a, ...b]);
    expect(both.every((c) => c.conflict)).toBe(true);
  });
});

describe("verifyCoupon status rules", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  const base: CouponObservation = { firstParty: true, seenInLatestCrawl: true, sufficient: true, conflict: null, expiresAt: null, consecutiveMisses: 0, sourceUrl: "https://acme.example/promotions", observedAt: now };

  it("VERIFIED only for a first-party sighting in the latest crawl, with evidence", () => {
    expect(verifyCoupon(base, now)).toEqual({ status: "VERIFIED", evidence: "Published on https://acme.example/promotions at 2026-10-06T12:00:00.000Z" });
    expect(verifyCoupon({ ...base, firstParty: false }, now).status).toBe("UNVERIFIED");
    expect(verifyCoupon({ ...base, sufficient: false }, now).status).toBe("UNKNOWN");
  });

  it("EXPIRED once the stated expiry passes, even if still published", () => {
    expect(verifyCoupon({ ...base, expiresAt: new Date("2026-10-05T23:59:59Z") }, now).status).toBe("EXPIRED");
    expect(verifyCoupon({ ...base, expiresAt: new Date("2026-10-07T00:00:00Z") }, now).status).toBe("VERIFIED");
  });

  it("CONFLICTING when first-party observations disagree", () => {
    expect(verifyCoupon({ ...base, conflict: "pages disagree" }, now)).toEqual({ status: "CONFLICTING", evidence: "pages disagree" });
  });

  it("one missed crawl keeps the status; two make it INVALID", () => {
    expect(verifyCoupon({ ...base, seenInLatestCrawl: false, consecutiveMisses: 1, previousStatus: "VERIFIED" }, now)).toEqual({ status: "VERIFIED" });
    expect(verifyCoupon({ ...base, seenInLatestCrawl: false, consecutiveMisses: 2, previousStatus: "VERIFIED" }, now).status).toBe("INVALID");
  });
});

describe("discount phrasing seen on live official pages", () => {
  it("reads 'save an extra' discounts exactly as stated", async () => {
    const { statedDiscount } = await import("@/lib/commerce/coupons");
    expect(statedDiscount("Save an extra 5% on bundles with code: PRIME26", "PRIME26")).toEqual({ discount: "Save an extra 5%", type: "PERCENT" });
    expect(statedDiscount("Plus, save an extra $199.99 to use toward installation (code 199OFF).", "199OFF")).toEqual({ discount: "save an extra $199.99", type: "AMOUNT" });
  });
});
