import { describe, expect, it } from "vitest";
import { feedicoDate, feedicoSourceUrl, normalizeFeedicoRows, parseFeedicoPage, type FeedicoCouponRow } from "@/lib/commerce/feedico";
import { couponDealStatus } from "@/lib/commerce/deal-status";

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

  it("drops non-codes and rows Feedico has not seen for over 30 days; upper-cases codes", () => {
    const n = normalizeFeedicoRows([row({ id: "a", code: "the" }), row({ id: "b", code: "OLD10", fetchedAt: "2026-07-01T00:00:00Z" }), row({ id: "c", code: "save5now" })], brand, NOW);
    expect(n.coupons.map((c) => c.code)).toEqual(["SAVE5NOW"]);
    expect(n.dropped.map((d) => d.id).sort()).toEqual(["a", "b"]);
  });

  it("merges one code listed by several networks, and marks it conflicting when they disagree", () => {
    const same = normalizeFeedicoRows([row(), row({ id: "c2", provider: "awin_affiliate", fetchedAt: "2026-10-08T01:00:00Z" })], brand, NOW);
    expect(same.coupons).toHaveLength(1);
    expect(same.coupons[0].conflict).toBeNull();
    const clash = normalizeFeedicoRows([row(), row({ id: "c2", title: "25% off sitewide", fetchedAt: "2026-10-08T01:00:00Z" })], brand, NOW);
    expect(clash.coupons).toHaveLength(1);
    expect(clash.coupons[0].conflict).toMatch(/disagree/);
  });

  it("a Feedico row can never be public on its own: its source is not the brand's site", () => {
    const verdict = couponDealStatus({ code: "SAVE20", status: "VERIFIED", startsAt: null, expiresAt: null, lastVerifiedAt: NOW, sourceUrl: feedicoSourceUrl(brand), brand }, NOW);
    expect(verdict.status).not.toBe("ACTIVE");
    expect(verdict.reasons.map((r) => r.code)).toContain("COUPON_NOT_FIRST_PARTY");
  });
});
