import { describe, expect, it } from "vitest";
import { evaluatePriceBlocks, moneyTokens, parseFullDate, statedEndDate } from "@/lib/commerce/html-price";
import { HTML_PRICE_METHOD, normalizeCommerceRecord } from "@/lib/commerce/normalize";

// SAMPLE price blocks shaped like what PRODUCT_PAGE_FUNCTION collects.
const USD = { price: 799, currency: "USD" };
const block = (text: string, comparisons: Array<Record<string, string | boolean>> = []) => [{ text, comparisons }];

describe("money tokens", () => {
  it("parses amounts with a currency marker only", () => {
    expect(moneyTokens("Now $1,299.00 was US$1,499").map((t) => [t.amount, t.currency])).toEqual([
      [1299, "$"],
      [1499, "USD"],
    ]);
    expect(moneyTokens("1.299,00 € statt 1.499,00 €").map((t) => [t.amount, t.currency])).toEqual([
      [1299, "EUR"],
      [1499, "EUR"],
    ]);
    expect(moneyTokens("CA$999 / £899").map((t) => t.currency)).toEqual(["CAD", "GBP"]);
    expect(moneyTokens("Save 20% on 2 items")).toEqual([]);
  });
});

describe("HTML price block", () => {
  it("accepts a struck-through previous price next to the structured current price", () => {
    const r = evaluatePriceBlocks(block("Sale price $799.00 Regular price $999.00", [{ tag: "s", text: "$999.00", cls: "price-item price-item--regular", label: "Regular price" }]), USD);
    expect(r).toMatchObject({ matched: true, listPrice: 999, listPriceType: "StrikethroughPrice", confidence: 0.8 });
  });

  it("a style-struck amount (text-decoration: line-through) is a strikethrough price; the current price must not be shown only as the previous one", () => {
    expect(evaluatePriceBlocks(block("$4,229.00 $5,159.00 $930 OFF", [{ tag: "span", struck: true, text: "$5,159.00", cls: "price--compare" }]), { price: 4229, currency: "USD" })).toMatchObject({ listPrice: 5159, listPriceType: "StrikethroughPrice", promotionText: "$4,229.00 $5,159.00 $930 OFF" });
    // Live shape: the sale price is $899 while the structured price is the $1,149 "Regular price".
    const r = evaluatePriceBlocks(block("Sale price $899 SAVE 20% Comp. Value: Regular price $1,149", [{ tag: "compare-at-price", struck: true, text: "Regular price $1,149", cls: "line-through" }]), { price: 1149, currency: "USD" });
    expect(r.matched).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/only as a previous price/);
  });

  it("accepts a 'Was' and a 'Reg.' label, typed by the label", () => {
    expect(evaluatePriceBlocks(block("$799.00 Was $899.00", [{ tag: "span", text: "Was $899.00", cls: "price-was" }]), USD)).toMatchObject({ listPrice: 899, listPriceType: "WasPrice", listPriceLabel: "Was" });
    expect(evaluatePriceBlocks(block("$799.00 Reg. $949.99", [{ tag: "span", text: "Reg. $949.99", cls: "" }]), USD)).toMatchObject({ listPrice: 949.99, listPriceType: "RegularPrice" });
    expect(evaluatePriceBlocks(block("$799.00 Original price: $999.00", [{ tag: "span", text: "$999.00", cls: "original-price" }]), USD)).toMatchObject({ listPrice: 999, listPriceType: "RegularPrice" });
  });

  it("never treats MSRP / suggested retail as a previous price", () => {
    const msrp = evaluatePriceBlocks(block("$799.00 MSRP $999.00", [{ tag: "span", text: "MSRP $999.00", cls: "msrp" }]), USD);
    expect(msrp.listPrice).toBeUndefined();
    expect(msrp.reasons.join(" ")).toMatch(/MSRP/);
    // Even struck through: the label says MSRP.
    expect(evaluatePriceBlocks(block("$799.00 MSRP $999.00", [{ tag: "s", text: "$999.00", label: "MSRP $999.00" }]), USD).listPrice).toBeUndefined();
    expect(evaluatePriceBlocks(block("$799.00 Suggested retail price $999.00", [{ tag: "span", text: "Suggested retail price $999.00", aria: "list price" }]), USD).listPrice).toBeUndefined();
  });

  it("rejects a block whose current price does not equal the structured price", () => {
    const r = evaluatePriceBlocks(block("$749.00 Was $999.00", [{ tag: "s", text: "Was $999.00" }]), USD);
    expect(r.matched).toBe(false);
    expect(r.listPrice).toBeUndefined();
  });

  it("rejects another currency, an amount without a currency, and an amount not above the current price", () => {
    expect(evaluatePriceBlocks(block("$799.00 Was CA$999.00", [{ tag: "s", text: "CA$999.00" }]), USD).listPrice).toBeUndefined();
    expect(evaluatePriceBlocks(block("$799.00 Was €999,00", [{ tag: "s", text: "€999,00" }]), USD).listPrice).toBeUndefined();
    expect(evaluatePriceBlocks(block("$799.00 Was 999.00", [{ tag: "s", text: "999.00" }]), USD).listPrice).toBeUndefined();
    expect(evaluatePriceBlocks(block("$799.00 Was $799.00", [{ tag: "s", text: "$799.00" }]), USD).listPrice).toBeUndefined();
    expect(evaluatePriceBlocks(block("$799.00 Was $699.00", [{ tag: "s", text: "$699.00" }]), USD).listPrice).toBeUndefined();
    // Absurd ratio (a bundle value, not a previous price).
    expect(evaluatePriceBlocks(block("$799.00 Was $9,999.00", [{ tag: "s", text: "$9,999.00" }]), USD).listPrice).toBeUndefined();
  });

  it("rejects comparison text that is not inside the block, and ambiguous different amounts", () => {
    const outside = evaluatePriceBlocks(block("$799.00", [{ tag: "s", text: "$999.00" }]), USD);
    expect(outside.listPrice).toBeUndefined();
    expect(outside.reasons.join(" ")).toMatch(/not inside the price block/);
    const two = evaluatePriceBlocks(block("$799.00 $899.00 $999.00", [{ tag: "s", text: "$899.00" }, { tag: "del", text: "$999.00" }]), USD);
    expect(two.listPrice).toBeUndefined();
    expect(two.reasons.join(" ")).toMatch(/ambiguous/);
    // An unmarked higher amount (no strike, no label) is not a previous price.
    expect(evaluatePriceBlocks(block("$799.00 or $999.00 with case", [{ tag: "span", text: "$999.00 with case", cls: "price" }]), USD).listPrice).toBeUndefined();
  });

  it("reads an explicit end date with a year from the block only, and the promotion text", () => {
    const r = evaluatePriceBlocks([{ text: "$799.00\nWas $999.00\nSave $200 – sale ends 10/31/2026", comparisons: [{ tag: "s", text: "$999.00" }] }], USD);
    expect(r).toMatchObject({ listPrice: 999, priceValidUntil: "2026-10-31", promotionText: "Save $200 – sale ends 10/31/2026" });
    expect(statedEndDate("Offer valid through Oct 31, 2026.")).toBe("2026-10-31");
    expect(statedEndDate("Deal ends Sunday, November 2nd 2026")).toBe("2026-11-02");
    expect(statedEndDate("offer valid until 31 December 2026")).toBe("2026-12-31");
    // Missing year, impossible date, or two different dates: none.
    expect(statedEndDate("Sale ends 10/31")).toBeNull();
    expect(statedEndDate("ends Oct 31")).toBeNull();
    expect(statedEndDate("ends 02/30/2026")).toBeNull();
    expect(statedEndDate("ends 10/31/2026, members through 11/05/2026")).toBeNull();
    expect(parseFullDate("2026-10-31")).toBe("2026-10-31");
    expect(parseFullDate("Octember 3, 2026")).toBeNull();
  });
});

describe("normalizeCommerceRecord with a price block", () => {
  const URL = "https://www.example.com/products/xr-200";
  const record = (offer: Record<string, unknown>, priceBlocks: unknown, extra: Record<string, unknown> = {}) => ({
    m4bCommerce: 1,
    url: URL,
    canonicalUrl: URL,
    title: "XR-200",
    h1: "XR-200",
    jsonLd: [{ "@context": "https://schema.org", "@type": "Product", name: "XR-200", sku: "XR200", offers: { "@type": "Offer", priceCurrency: "USD", ...offer } }],
    meta: {},
    priceBlocks,
    ...extra,
  });

  it("uses the block only when JSON-LD states no previous price", () => {
    const n = normalizeCommerceRecord(record({ price: "799.00" }, block("$799.00 Was $999.00 Offer ends 10/31/2026", [{ tag: "del", text: "$999.00" }])));
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect(n.offers[0]).toMatchObject({ price: 799, listPrice: 999, listPriceType: "StrikethroughPrice", confidence: 0.8, extractionMethod: HTML_PRICE_METHOD, priceValidUntil: "2026-10-31" });
    // The record itself was read from JSON-LD.
    expect(n.extractionMethod).toBe("apify-web-scraper:json-ld");
  });

  it("never overrides a JSON-LD list price", () => {
    const n = normalizeCommerceRecord(record({ price: "799.00", priceSpecification: { "@type": "UnitPriceSpecification", priceType: "https://schema.org/ListPrice", price: 949, priceCurrency: "USD" } }, block("$799.00 Was $999.00", [{ tag: "del", text: "$999.00" }])));
    expect(n.ok && n.offers[0]).toMatchObject({ listPrice: 949, listPriceType: "ListPrice" });
    expect(n.ok && n.offers[0].extractionMethod).toBeUndefined();
  });

  it("a block showing another price leaves the offer unchanged", () => {
    const n = normalizeCommerceRecord(record({ price: "799.00" }, block("$749.00 Was $999.00", [{ tag: "del", text: "$999.00" }])));
    expect(n.ok && n.offers[0].listPrice).toBeUndefined();
  });
});
