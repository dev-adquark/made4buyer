import { describe, expect, it } from "vitest";
import { feedicoDate, feedicoSourceUrl, normalizeFeedicoRows, parseFeedicoPage, type FeedicoCouponRow } from "@/lib/commerce/feedico";
import { couponDealStatus, nonUsFeedMarket, publicCoupons } from "@/lib/commerce/deal-status";
import { toPromoCode } from "@/lib/public/deals";

// SAMPLE rows shaped like POST /api/v1/catalog/coupons (feedico.io/openapi-customer.yaml v1.4).
const NOW = new Date("2026-10-08T12:00:00Z");
const brand = { id: "b1", slug: "acme", name: "Acme", officialDomain: "acme.com" };
const row = (over: Partial<FeedicoCouponRow> = {}): FeedicoCouponRow => ({ id: "coupon_1", brandName: "Acme CJ Affiliate Program", provider: "cj_affiliate", code: "SAVE20", title: "20% off sitewide", description: null, startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-12-31 23:59:59", merchantWebsiteUrl: "https://www.acme.com", fetchedAt: "2026-10-07T08:00:00.000Z", ...over });

describe("Feedico response contract", () => {
  it("accepts only the documented page shape and drops rows without id, code or brand", () => {
    expect(parseFeedicoPage({ ok: false, error: "monthly_api_limit" })).toBeNull();
    expect(parseFeedicoPage({ ok: true, coupons: [] })).toBeNull(); // no recordCount
    expect(parseFeedicoPage("nope")).toBeNull();
    const p = parseFeedicoPage({ ok: true, recordCount: 3, page: 1, pageSize: 200, availableProviders: ["cj_affiliate"], coupons: [row(), { id: "x", brandName: "Acme" }, { code: "A1B2", brandName: "Acme" }] });
    expect(p?.recordCount).toBe(3);
    expect(p?.coupons.map((c) => c.code)).toEqual(["SAVE20"]);
  });

  it("reads both timestamp forms as UTC and treats a year ≥ 2100 as no stated end", () => {
    expect(feedicoDate("2026-12-31 23:59:59")?.toISOString()).toBe("2026-12-31T23:59:59.000Z");
    expect(feedicoDate("2026-01-01T00:00:00.000Z")?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(feedicoDate("2199-09-11 16:00:00")).toBeNull();
    expect(feedicoDate("not a date")).toBeNull();
    expect(feedicoDate(null)).toBeNull();
  });
});

describe("normalizeFeedicoRows", () => {
  it("keeps only the brand's own merchant domain (the firmName filter is a substring search)", () => {
    const n = normalizeFeedicoRows([row(), row({ id: "c2", code: "OTHER10", merchantWebsiteUrl: "https://acmetools.example" }), row({ id: "c3", code: "SHOP15", merchantWebsiteUrl: "shop.acme.com" })], brand, NOW);
    expect(n.matched).toBe(2);
    expect(n.coupons.map((c) => c.code).sort()).toEqual(["SAVE20", "SHOP15"]);
  });

  it("states only what the row states: discount from its text, dates, merchant origin; never first-party", () => {
    const [c] = normalizeFeedicoRows([row()], brand, NOW).coupons;
    expect(c).toMatchObject({ merchant: "Acme", code: "SAVE20", discount: "20% off", discountType: "PERCENT", merchantUrl: "https://www.acme.com", firstParty: false, eligibility: null, restrictions: null });
    expect(c.expiresAt?.toISOString()).toBe("2026-12-31T23:59:59.000Z");
    expect(new URL(c.sourceUrl).hostname).toBe("api.feedico.io");
    const [noOffer] = normalizeFeedicoRows([row({ title: "Exclusive code", description: null })], brand, NOW).coupons;
    expect(noOffer.discount).toBeNull();
  });

  it("drops non-codes, rows Feedico has not confirmed within 14 days, and rows with no confirmation date; upper-cases codes", () => {
    const n = normalizeFeedicoRows(
      [
        row({ id: "a", code: "the" }),
        row({ id: "b", code: "OLD10", fetchedAt: "2026-09-24T11:59:00Z" }), // 14 days + 1 minute
        row({ id: "d", code: "NODATE5", fetchedAt: null }),
        row({ id: "e", code: "EDGE13", fetchedAt: "2026-09-25T12:00:00Z" }), // 13 days
        row({ id: "c", code: "save5now" }),
      ],
      brand,
      NOW,
    );
    expect(n.coupons.map((c) => c.code)).toEqual(["EDGE13", "SAVE5NOW"]);
    expect(Object.fromEntries(n.dropped.map((d) => [d.id, d.reason]))).toMatchObject({ a: expect.stringMatching(/^code:/), b: expect.stringMatching(/^stale:.*14 days/), d: "no fetchedAt: age unknown" });
  });

  it("merges one code listed by several networks, and marks it conflicting when they disagree", () => {
    const same = normalizeFeedicoRows([row(), row({ id: "c2", provider: "awin_affiliate", fetchedAt: "2026-10-08T01:00:00Z" })], brand, NOW);
    expect(same.coupons).toHaveLength(1);
    expect(same.coupons[0].conflict).toBeNull();
    const clash = normalizeFeedicoRows([row(), row({ id: "c2", title: "25% off sitewide", fetchedAt: "2026-10-08T01:00:00Z" })], brand, NOW);
    expect(clash.coupons).toHaveLength(1);
    expect(clash.coupons[0].conflict).toMatch(/disagree/);
  });

  it("the site lists US coupons only: the sync stores every storefront, the display drops non-US ones", () => {
    const n = normalizeFeedicoRows([row(), row({ id: "uk", code: "UKSAVE60", title: "save £60", merchantWebsiteUrl: "https://uk.acme.com" })], brand, NOW);
    expect(n.coupons.map((c) => c.code)).toEqual(["SAVE20", "UKSAVE60"]); // sync logic unchanged
    const b = { name: "Acme", slug: "acme", categories: [], officialDomain: "acme.com", officialStoreUrl: null };
    const promo = (over: Record<string, unknown>) => toPromoCode({ id: "u", code: "UKSAVE60", discount: null, eligibility: null, restrictions: null, expiresAt: null, lastVerifiedAt: null, sourceUrl: feedicoSourceUrl(brand), merchantUrl: "https://www.acme.com", observedAt: NOW, ...over }, b);
    expect(promo({ merchantUrl: "https://uk.acme.com" })).toBeNull();
    expect(promo({ discount: "save £60" })).toBeNull();
    expect(promo({ merchant: "Acme UK" })).toBeNull();
    expect(promo({})).toMatchObject({ code: "UKSAVE60", viaFeed: true });
  });

  it("recognises non-US storefronts, programmes and currencies; US, worldwide and global stay", () => {
    expect(nonUsFeedMarket("https://uk.jackery.com", null)).toMatch(/non-US storefront/);
    expect(nonUsFeedMarket("https://www.shop.co.uk", null)).toMatch(/non-US country domain \(\.co\.uk\)/);
    expect(nonUsFeedMarket("https://www.brand.de", null)).toMatch(/\.de/);
    expect(nonUsFeedMarket("https://www.acme.com/en-gb/", null)).toMatch(/non-US storefront/);
    expect(nonUsFeedMarket("https://www.acme.com", null, "Acme DE")).toMatch(/non-US programme \(DE\)/);
    expect(nonUsFeedMarket("https://www.acme.com", "Save €20 on orders")).toMatch(/non-USD/);
    expect(nonUsFeedMarket("https://www.acme.com", "C$15 off")).toMatch(/non-USD/);
    expect(nonUsFeedMarket("https://www.acme.com", "$25 off orders over $200", "Willwork Jewelry US")).toBeNull();
    expect(nonUsFeedMarket("https://www.aliexpress.com", "5% off", "AliExpress WW")).toBeNull();
    expect(nonUsFeedMarket("https://shop.io", null, "Harfington Many GEOs")).toBeNull();
    expect(nonUsFeedMarket("https://www.acme.com/us/", null)).toBeNull();
  });

  it("a fresh Feedico code is public in its own right (tier 5); stale, expired, invalid or conflicting ones are not", () => {
    const base = { code: "SAVE20", status: "UNVERIFIED", startsAt: null, expiresAt: null, lastVerifiedAt: null, observedAt: NOW, sourceUrl: feedicoSourceUrl(brand), brand };
    expect(couponDealStatus(base, NOW)).toEqual({ status: "ACTIVE", reasons: [] });
    expect(couponDealStatus({ ...base, observedAt: new Date(NOW.getTime() - 15 * 86_400_000) }, NOW).reasons.map((r) => r.code)).toContain("COUPON_NOT_RESEEN");
    expect(couponDealStatus({ ...base, expiresAt: new Date(NOW.getTime() - 1000) }, NOW).status).toBe("EXPIRED");
    expect(couponDealStatus({ ...base, startsAt: new Date(NOW.getTime() + 86_400_000) }, NOW).status).not.toBe("ACTIVE");
    for (const status of ["INVALID", "EXPIRED", "CONFLICTING", "UNKNOWN"]) expect(couponDealStatus({ ...base, status }, NOW).status, status).not.toBe("ACTIVE");
    expect(couponDealStatus({ ...base, brand: undefined }, NOW).status).not.toBe("ACTIVE");
    // Any other third-party page still never makes a code public on its own.
    expect(couponDealStatus({ ...base, sourceUrl: "https://coupons.example.com/acme" }, NOW).status).not.toBe("ACTIVE");
  });

  it("the brand's own page outranks the feed: the same code is listed once, as the official one, never a conflict", () => {
    const official = { id: "o", code: "SAVE20", discount: "20% off", status: "VERIFIED", startsAt: null, expiresAt: null, lastVerifiedAt: NOW, observedAt: NOW, sourceUrl: "https://acme.com/promotions", brand };
    const feed = { id: "f", code: "SAVE20", discount: "25% off", status: "UNVERIFIED", startsAt: null, expiresAt: null, lastVerifiedAt: null, observedAt: NOW, sourceUrl: feedicoSourceUrl(brand), brand };
    expect(publicCoupons([feed, official], NOW).map((c) => c.id)).toEqual(["o"]);
    expect(publicCoupons([feed], NOW).map((c) => c.id)).toEqual(["f"]);
  });

  it("a feed code is shown as 'Via Feedico', links to the brand's own website, never to the Feedico API", () => {
    const p = toPromoCode({ id: "f", code: "SAVE20", discount: "20% off", eligibility: null, restrictions: null, expiresAt: null, lastVerifiedAt: null, sourceUrl: feedicoSourceUrl(brand), merchantUrl: "https://www.acme.com", observedAt: NOW }, { name: "Acme", slug: "acme", categories: ["audio"], officialDomain: "acme.com", officialStoreUrl: null });
    expect(p).toMatchObject({ viaFeed: true, sourceUrl: null, useUrl: "https://www.acme.com/", source: "Feedico (affiliate network)", verifiedVia: "Affiliate feed (Feedico)", lastVerifiedAt: null, checkedAt: NOW.toISOString() });
    const offsite = toPromoCode({ id: "g", code: "SAVE20", discount: null, eligibility: null, restrictions: null, expiresAt: null, lastVerifiedAt: null, sourceUrl: feedicoSourceUrl(brand), merchantUrl: "https://elsewhere.example", observedAt: NOW }, { name: "Acme", slug: "acme", categories: [], officialDomain: "acme.com", officialStoreUrl: null });
    expect(offsite?.useUrl).toBeNull();
  });
});
