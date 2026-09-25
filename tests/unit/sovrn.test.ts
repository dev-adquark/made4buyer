import { describe, expect, it } from "vitest";
import { generateAffiliateUrl } from "@/lib/sovrn/affiliate";
import { buildSovrnRequestUrl } from "@/lib/sovrn/client";
import { buildQueryString, normalizeOffers, productSimilarity, rankOffers, scoreOffer, selectionReason } from "@/lib/sovrn/offers";

const trusted = ["amazon", "best buy"];
const query = { productName: "Pixel 10", brand: "Google", categorySlug: "phones", deviceType: "smartphone", modelNumber: null };

describe("offer normalisation", () => {
  it("accepts Sovrn and common field variants, discards unusable offers", () => {
    const offers = normalizeOffers({
      data: {
        offers: [
          { id: "1", name: "Google Pixel 10 128GB", merchant: { name: "Best Buy", id: "bb" }, salePrice: "799.00", currency: "usd", deepLink: "https://sovrn.co/abc", merchantUrl: "https://www.bestbuy.com/p/1", availability: "In Stock" },
          { offerId: "2", title: "Pixel 10", retailer: "Amazon", price: { amount: 749 }, url: "https://www.amazon.com/dp/2", inStock: false },
          { id: "3", name: "No URL offer" },
          { id: "4", name: "Bad protocol", url: "javascript:alert(1)" },
          { id: "1", name: "duplicate id", url: "https://x.example.com" },
        ],
      },
    });
    expect(offers.map((o) => o.offerId)).toEqual(["1", "2"]);
    expect(offers[0]).toMatchObject({ merchantName: "Best Buy", price: 799, currency: "USD", availability: "in_stock", providerAffiliateUrl: "https://sovrn.co/abc" });
    expect(offers[1]).toMatchObject({ merchantName: "Amazon", price: 749, availability: "out_of_stock", providerAffiliateUrl: undefined });
  });
});

describe("offer scoring", () => {
  const offers = normalizeOffers([
    { id: "phone", name: "Google Pixel 10 128GB Unlocked Smartphone", merchant: "Best Buy", salePrice: 799, url: "https://www.bestbuy.com/1", availability: "in stock" },
    { id: "case", name: "Pixel 10 Clear Phone Case", merchant: "Amazon", salePrice: 14.99, url: "https://www.amazon.com/2", availability: "in stock" },
    { id: "other", name: "Samsung Galaxy S26", brand: "Samsung", merchant: "Amazon", salePrice: 999, url: "https://www.amazon.com/3" },
    { id: "oos", name: "Google Pixel 10 128GB", merchant: "Unknown Shop", salePrice: 700, url: "https://shop.example.com/4", availability: "out of stock" },
  ]);

  it("rejects accessories and wrong brands, prefers in-stock trusted offers", () => {
    const ranked = rankOffers(query, offers, { minScore: 0.55, trustedMerchants: trusted });
    const viable = ranked.filter((r) => r.viable).map((r) => r.offer.offerId);
    expect(viable[0]).toBe("phone");
    expect(viable).not.toContain("case");
    expect(viable).not.toContain("other");
    expect(scoreOffer(query, offers[1], trusted).category).toBe(0);
    expect(scoreOffer(query, offers[2], trusted).brand).toBe(0);
    expect(scoreOffer(query, offers[3], trusted).availability).toBe(0);
  });

  it("persists a readable reason for the winner", () => {
    const ranked = rankOffers(query, offers, { minScore: 0.55, trustedMerchants: trusted }).filter((r) => r.viable);
    expect(selectionReason(ranked[0], ranked[1])).toMatch(/^Selected phone from Best Buy: score/);
  });

  it("breaks ties deterministically", () => {
    const twins = normalizeOffers([
      { id: "b", name: "Google Pixel 10", merchant: "Amazon", salePrice: 799, url: "https://a.example.com/1", availability: "in stock" },
      { id: "a", name: "Google Pixel 10", merchant: "Amazon", salePrice: 799, url: "https://a.example.com/2", availability: "in stock" },
    ]);
    const order = rankOffers(query, twins, { minScore: 0.5, trustedMerchants: trusted }).map((r) => r.offer.offerId);
    expect(order).toEqual(["a", "b"]);
  });

  it("measures product similarity by containment", () => {
    expect(productSimilarity("Pixel 10", "Google Pixel 10 128GB")).toBeGreaterThan(0.8);
    expect(productSimilarity("Pixel 10", "Galaxy S26")).toBe(0);
  });

  it("builds query strings and request URLs", () => {
    expect(buildQueryString({ productName: "Pixel 10", brand: "Google", modelNumber: "GA05" })).toBe("Google Pixel 10 GA05");
    expect(buildQueryString({ productName: "Google Pixel 10", brand: "Google" })).toBe("Google Pixel 10");
    expect(buildSovrnRequestUrl("https://api.example.com/compare?market=us", "Pixel 10", "search-keywords")).toBe("https://api.example.com/compare?market=us&search-keywords=Pixel+10");
    expect(buildSovrnRequestUrl("https://api.example.com/q/{query}", "Pixel 10", "x")).toBe("https://api.example.com/q/Pixel%2010");
  });
});

describe("affiliate URL generation", () => {
  it("uses the provider deeplink when present", () => {
    const g = generateAffiliateUrl({ offerUrl: "https://www.bestbuy.com/p/1", providerAffiliateUrl: "https://sovrn.co/abc" }, {});
    expect(g).toEqual({ ok: true, affiliateUrl: "https://sovrn.co/abc", destinationUrl: "https://www.bestbuy.com/p/1", method: "PROVIDER_DEEPLINK" });
  });

  it("wraps the merchant URL with the configured Sovrn wrapper and site key", () => {
    const g = generateAffiliateUrl({ offerUrl: "https://www.bestbuy.com/p/1?x=1" }, { wrapperUrl: "https://redirect.viglink.com", siteKey: "KEY123" });
    expect(g.ok).toBe(true);
    if (g.ok) {
      const u = new URL(g.affiliateUrl);
      expect(u.hostname).toBe("redirect.viglink.com");
      expect(u.searchParams.get("key")).toBe("KEY123");
      expect(u.searchParams.get("u")).toBe("https://www.bestbuy.com/p/1?x=1");
      expect(g.method).toBe("LINK_WRAPPER");
    }
  });

  it("never invents a link without a deeplink or site key", () => {
    expect(generateAffiliateUrl({ offerUrl: "https://www.bestbuy.com/p/1" }, { wrapperUrl: "https://redirect.viglink.com" }).ok).toBe(false);
    expect(generateAffiliateUrl({ offerUrl: "http://10.0.0.5/p" }, { siteKey: "k", wrapperUrl: "https://redirect.viglink.com" }).ok).toBe(false);
    expect(generateAffiliateUrl({ offerUrl: "https://shop.example.com/p" }, { siteKey: "k", wrapperUrl: "http://insecure.example.com" }).ok).toBe(false);
  });
});
