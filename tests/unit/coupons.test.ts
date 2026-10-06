import { describe, expect, it } from "vitest";
import { couponIsCurrent } from "@/lib/pipeline/render-model";
import { canonicalProductUrl, normalizeCoupons } from "@/lib/sovrn/coupons";

describe("Sovrn promo codes: documented shape only", () => {
  it("canonicalises the retailer URL and refuses affiliate/redirect hosts", () => {
    expect(canonicalProductUrl("https://shop.example.com/p/123?utm_source=x&color=red&gclid=1#reviews")).toBe("https://shop.example.com/p/123?color=red");
    expect(canonicalProductUrl("https://redirect.viglink.com/?key=a&u=https%3A%2F%2Fshop.example.com")).toBeUndefined();
    expect(canonicalProductUrl("javascript:alert(1)")).toBeUndefined();
    expect(canonicalProductUrl(null)).toBeUndefined();
  });

  it("keeps documented fields, drops coupons without a code or with a non-Sovrn affiliated_url, never invents values", () => {
    const n = normalizeCoupons({
      merchant: { domain: "shop.example.com", group_id: 7, group_name: "Example", logo_url: null },
      scan: { verification_active: true, when_to_check_back: 900 },
      coupons: [
        { id: "c1", code: "SAVE20", affiliated_url: "https://sovrn.co/abc", currency: "usd", verified: true, original_price: 100, price_with_code: 80, verified_at: "2026-10-05T10:00:00Z", code_description: "20% off" },
        { id: "c2", code: "", affiliated_url: "https://sovrn.co/x", currency: "USD", verified: true },
        { id: "c3", code: "EVIL", affiliated_url: "https://evil.example/x", currency: "USD", verified: true },
        { id: "c4", code: "MAYBE", affiliated_url: "https://redirect.viglink.com/x", currency: "USD", verified: false, original_price: null, price_with_code: null, verified_at: null, code_description: null },
      ],
    })!;
    expect(n.merchant).toEqual({ domain: "shop.example.com", name: "Example" });
    expect(n.scan).toEqual({ verificationActive: true, whenToCheckBackSec: 900 });
    expect(n.coupons.map((c) => c.code)).toEqual(["SAVE20", "MAYBE"]);
    expect(n.coupons[0]).toMatchObject({ currency: "USD", verified: true, originalPrice: 100, priceWithCode: 80, description: "20% off" });
    expect(n.coupons[1]).toMatchObject({ verified: false, originalPrice: null, priceWithCode: null, verifiedAt: null, description: null });
    expect(normalizeCoupons({ offers: [] })).toBeUndefined();
  });

  it("a code is current only while recently verified", () => {
    const now = Date.parse("2026-10-06T00:00:00Z");
    expect(couponIsCurrent({ verifiedAt: "2026-10-01T00:00:00Z" }, now, 7)).toBe(true);
    expect(couponIsCurrent({ verifiedAt: "2026-09-20T00:00:00Z" }, now, 7)).toBe(false);
    expect(couponIsCurrent({ verifiedAt: "not a date" }, now, 7)).toBe(false);
  });
});
