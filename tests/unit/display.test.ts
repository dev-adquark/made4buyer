import { describe, expect, it } from "vitest";
import { canonicalDestination, displayAmount, displayCurrency, displayDate, displayNumber, displayPrice, displayText, displayUrl, FORBIDDEN_PUBLIC_TOKENS, nonEmpty, pruneJsonLd, relativeTime } from "@/lib/public/display";
import { computeSaving } from "@/lib/public/deals";
import { availabilityLabel, dateline, money, shortDate } from "@/lib/util/format";

describe("displayText", () => {
  it.each([null, undefined, NaN, Infinity, "", "   ", "null", "NULL", "nil", "undefined", "NaN", "N/A", "n/a", "unknown", "Unknown", "-", "—", "--", "$", "***", {}, [], true])("hides %s", (v) => {
    expect(displayText(v)).toBeNull();
  });
  it("keeps real text, trimmed and with collapsed whitespace", () => {
    expect(displayText("  Sony  WH-1000XM6 ")).toBe("Sony WH-1000XM6");
    expect(displayText(42)).toBe("42");
    expect(displayText("None")).toBe("None");
    expect(displayText("Nullarbor")).toBe("Nullarbor");
  });
});

describe("displayPrice", () => {
  it("formats a positive amount with a valid ISO currency", () => {
    expect(displayPrice(999, "USD")).toBe("$999.00");
    expect(displayPrice("19.99", "usd")).toBe("$19.99");
    expect(displayPrice(1499, "INR", "en-IN")).toBe("₹1,499.00");
    expect(displayPrice(1, "EUR")).toBe("€1.00");
  });
  it.each([
    [0, "USD"],
    [-5, "USD"],
    [NaN, "USD"],
    [Infinity, "USD"],
    [null, "USD"],
    [undefined, "USD"],
    ["abc", "USD"],
    [10, null],
    [10, ""],
    [10, "$"],
    [10, "US"],
    [10, "XYZ"],
    [10, "dollars"],
  ])("returns null for %s %s (never $0, never a guessed currency)", (a, c) => {
    expect(displayPrice(a, c)).toBeNull();
  });
  it("money() follows the same rules", () => {
    expect(money(0, "USD")).toBeNull();
    expect(money(10, null)).toBeNull();
    expect(money(10.5, "USD")).toBe("$10.50");
  });
  it("amount and currency helpers", () => {
    expect(displayAmount("0")).toBeNull();
    expect(displayAmount("12.5")).toBe(12.5);
    expect(displayCurrency(" gbp ")).toBe("GBP");
    expect(displayCurrency("EURO")).toBeNull();
  });
});

describe("displayUrl", () => {
  it("keeps absolute public http(s) URLs", () => {
    expect(displayUrl("https://www.bestbuy.com/site/p/123")).toBe("https://www.bestbuy.com/site/p/123");
    expect(displayUrl("http://frame.work/products/laptop13")).toBe("http://frame.work/products/laptop13");
  });
  it.each([null, undefined, "", "#", "#deal", "/review/x", "javascript:alert(1)", "mailto:a@b.co", "ftp://files.acme.com/x", "https://example.com/p", "https://www.example.org", "https://shop.example", "http://localhost:3000/x", "https://127.0.0.1/p", "https://[::1]/p", "https://intranet/p", "https://user:pw@acme.com/", "https://store.test/x", "not a url"])("rejects %s", (v) => {
    expect(displayUrl(v)).toBeNull();
  });
});

describe("displayDate / displayNumber / nonEmpty / relativeTime", () => {
  it("dates", () => {
    expect(displayDate("2026-10-01T00:00:00Z")?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(displayDate("not a date")).toBeNull();
    expect(displayDate(new Date(NaN))).toBeNull();
    expect(displayDate(0)).toBeNull();
    expect(displayDate(null)).toBeNull();
    expect(dateline("garbage")).toBeNull();
    expect(shortDate(undefined)).toBeNull();
    expect(dateline("2026-10-01T00:00:00Z")).toBe("01 OCT 2026");
  });
  it("numbers", () => {
    expect(displayNumber("4.5")).toBe(4.5);
    expect(displayNumber(NaN)).toBeNull();
    expect(displayNumber("")).toBeNull();
    expect(displayNumber(0, { positive: true })).toBeNull();
    expect(displayNumber(11, { max: 10 })).toBeNull();
  });
  it("lists", () => {
    expect(nonEmpty(["a", null, "N/A", undefined, "b", NaN as unknown as string])).toEqual(["a", "b"]);
    expect(nonEmpty([null, "", "unknown"])).toBeNull();
    expect(nonEmpty(null)).toBeNull();
  });
  it("relative time", () => {
    const now = Date.parse("2026-10-07T12:00:00Z");
    expect(relativeTime("2026-10-07T09:00:00Z", now)).toBe("3 hours ago");
    expect(relativeTime("2026-10-07T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-10-07T13:00:00Z", now)).toBeNull();
    expect(relativeTime("bad", now)).toBeNull();
  });
  it("availability labels never fall back to a placeholder", () => {
    expect(availabilityLabel("InStock")).toBe("In stock");
    expect(availabilityLabel("https://schema.org/OutOfStock")).toBe("Out of stock");
    expect(availabilityLabel("unknown")).toBeNull();
    expect(availabilityLabel(null)).toBeNull();
  });
});

describe("canonicalDestination", () => {
  it("strips fragments, tracking and repeated parameters", () => {
    expect(canonicalDestination("https://www.Shop.com/p/1/?utm_source=x&b=2&a=1&a=9&gclid=z&fbclid=y&mc_cid=q#reviews")).toBe("https://shop.com/p/1?a=1&b=2");
    expect(canonicalDestination("http://shop.com/p/1")).toBe(canonicalDestination("https://shop.com/p/1/"));
  });
  it("keeps affiliate parameters only when a real provider is configured", () => {
    expect(canonicalDestination("https://shop.com/p?tag=abc-20&id=1")).toBe("https://shop.com/p?id=1");
    expect(canonicalDestination("https://shop.com/p?tag=abc-20&id=1", { keepAffiliateParams: true })).toBe("https://shop.com/p?id=1&tag=abc-20");
  });
  it("rejects non-http links", () => {
    expect(canonicalDestination("javascript:alert(1)")).toBeNull();
    expect(canonicalDestination("")).toBeNull();
  });
});

describe("pruneJsonLd", () => {
  it("drops empty fields, an Offer without a real price and a rating without a count", () => {
    const out = pruneJsonLd({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Acme Kettle",
      description: null,
      sku: "N/A",
      brand: { "@type": "Brand", name: "" },
      image: [],
      offers: { "@type": "Offer", price: 0, priceCurrency: "USD" },
      aggregateRating: { "@type": "AggregateRating", ratingValue: 4.5 },
    });
    expect(out).toEqual({ "@context": "https://schema.org", "@type": "Product", name: "Acme Kettle" });
  });
  it("keeps a real Offer and a real AggregateRating", () => {
    const out = pruneJsonLd({ "@type": "Product", name: "Acme", offers: { "@type": "Offer", price: 19.99, priceCurrency: "USD", availability: "https://schema.org/InStock" }, aggregateRating: { "@type": "AggregateRating", ratingValue: 4.5, ratingCount: 12 } });
    expect(out).toMatchObject({ offers: { price: 19.99 }, aggregateRating: { ratingCount: 12 } });
  });
  it("drops an Offer without a currency and a Review without its item", () => {
    expect(pruneJsonLd({ "@type": "Product", name: "A", offers: { "@type": "Offer", price: 10 } })).toEqual({ "@type": "Product", name: "A" });
    expect(pruneJsonLd({ "@type": "Review", name: "x", itemReviewed: { "@type": "Product", name: "null" } })).toBeUndefined();
  });
});

describe("forbidden public tokens", () => {
  it.each(["Price: null", "undefined", "NaN", "N/A", "$0", "₹0", "$0.00", "from nil"])("matches %s", (t) => {
    expect(FORBIDDEN_PUBLIC_TOKENS.test(t)).toBe(true);
  });
  it.each(["$0.99", "$10", "$1,099.00", "Nullarbor", "nullable", "Not given by the source"])("does not match %s", (t) => {
    expect(FORBIDDEN_PUBLIC_TOKENS.test(t)).toBe(false);
  });
});

describe("deal saving", () => {
  it("is computed only from a stated higher list price, never rounded up", () => {
    expect(computeSaving(79.99, 99.99)).toEqual({ amount: 20, percent: 20 });
    expect(computeSaving(66.67, 100)).toEqual({ amount: 33.33, percent: 33 });
    expect(computeSaving(99.5, 100)).toEqual({ amount: 0.5, percent: 0 });
    expect(computeSaving(100, 100)).toBeNull();
    expect(computeSaving(100, 90)).toBeNull();
    expect(computeSaving(100, null)).toBeNull();
    expect(computeSaving(0, 100)).toBeNull();
  });
});
