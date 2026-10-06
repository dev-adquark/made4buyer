import { afterEach, describe, expect, it } from "vitest";
import {
  completeness,
  maxAgeMs,
  normalizeValue,
  priceTier,
  refreshDue,
  resolveFacts,
  resolveField,
  valuesAgree,
  volatility,
} from "@/lib/products/facts";
import type { Fact, FactField } from "@/lib/products/types";

const NOW = new Date("2026-10-06T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

function fact(over: Partial<Fact> & Pick<Fact, "field" | "value">): Fact {
  return {
    unit: null,
    source: "RETAILER",
    sourceName: "Shop",
    sourceUrl: "https://shop.example/p/1",
    observedAt: ago(HOUR),
    matchBasis: "gtin",
    ...over,
  };
}

afterEach(() => {
  delete process.env.PRODUCT_PRICE_MAX_AGE_HOURS;
});

describe("volatility and max age", () => {
  it("classifies fields", () => {
    expect(volatility("price")).toBe("HIGH");
    expect(volatility("availability")).toBe("HIGH");
    expect(volatility("rating")).toBe("MEDIUM");
    expect(volatility("officialUrl")).toBe("MEDIUM");
    expect(volatility("gtin")).toBe("LOW");
    expect(volatility("weight")).toBe("LOW");
  });

  it("reads PRODUCT_PRICE_MAX_AGE_HOURS at call time and clamps it", () => {
    expect(maxAgeMs("HIGH")).toBe(48 * HOUR);
    process.env.PRODUCT_PRICE_MAX_AGE_HOURS = "12";
    expect(maxAgeMs("HIGH")).toBe(12 * HOUR);
    process.env.PRODUCT_PRICE_MAX_AGE_HOURS = "0";
    expect(maxAgeMs("HIGH")).toBe(1 * HOUR);
    process.env.PRODUCT_PRICE_MAX_AGE_HOURS = "99999";
    expect(maxAgeMs("HIGH")).toBe(720 * HOUR);
    process.env.PRODUCT_PRICE_MAX_AGE_HOURS = "abc";
    expect(maxAgeMs("HIGH")).toBe(48 * HOUR);
    expect(maxAgeMs("MEDIUM")).toBe(30 * DAY);
    expect(maxAgeMs("LOW")).toBe(365 * DAY);
  });
});

describe("refreshDue", () => {
  it("is due after half the max age", () => {
    expect(refreshDue({ field: "price", observedAt: ago(23 * HOUR) }, NOW)).toBe(false);
    expect(refreshDue({ field: "price", observedAt: ago(25 * HOUR) }, NOW)).toBe(true);
    expect(refreshDue({ field: "rating", observedAt: ago(14 * DAY) }, NOW)).toBe(false);
    expect(refreshDue({ field: "rating", observedAt: ago(16 * DAY) }, NOW)).toBe(true);
    expect(refreshDue({ field: "gtin", observedAt: ago(100 * DAY) }, NOW)).toBe(false);
    expect(refreshDue({ field: "gtin", observedAt: ago(200 * DAY) }, NOW)).toBe(true);
  });
});

describe("normalizeValue", () => {
  it("pads GTINs to 14 digits", () => {
    expect(normalizeValue("gtin", "0 12345-67890 5")).toBe("00012345678905");
    expect(normalizeValue("gtin", "9300000000001")).toBe("09300000000001");
  });

  it("cleans text, trademarks and legal suffixes", () => {
    expect(normalizeValue("productName", "  Barista   Express™ ")).toBe("barista express");
    expect(normalizeValue("brand", "Breville Pty Ltd.")).toBe("breville");
    expect(normalizeValue("manufacturer", "Sony Group Corporation")).toBe("sony group");
    expect(normalizeValue("brand", "Acme, Inc.")).toBe("acme");
    expect(normalizeValue("brand", "Bosch GmbH")).toBe("bosch");
  });

  it("maps availability to schema.org tokens", () => {
    expect(normalizeValue("availability", "https://schema.org/InStock")).toBe("InStock");
    expect(normalizeValue("availability", "In stock")).toBe("InStock");
    expect(normalizeValue("availability", "Out of Stock")).toBe("OutOfStock");
    expect(normalizeValue("availability", "Pre-order")).toBe("PreOrder");
  });

  it("turns arrays into sorted lowercase sets and rounds prices", () => {
    expect(normalizeValue("features", ["Wi-Fi", "bluetooth", "wi-fi"])).toEqual(["bluetooth", "wi-fi"]);
    expect(normalizeValue("price", 699.949)).toBe(699.95);
    expect(normalizeValue("weight", 2, "lb")).toBe(907.185);
  });
});

describe("valuesAgree", () => {
  it("does not treat Barista Express and Barista Pro as the same product", () => {
    const a = fact({ field: "productName", value: "Breville Barista Express" });
    const b = fact({ field: "productName", value: "Breville Barista Pro" });
    expect(valuesAgree("productName", a, b)).toBe(false);
  });

  it("allows non-variant extra words in names but not variant tokens", () => {
    const base = fact({ field: "productName", value: "Barista Express" });
    expect(valuesAgree("productName", base, fact({ field: "productName", value: "Breville Barista Express Espresso Machine" }))).toBe(true);
    expect(valuesAgree("productName", base, fact({ field: "productName", value: "Barista Express Impress" }))).toBe(true);
    const phone = fact({ field: "productName", value: "iPhone 15" });
    expect(valuesAgree("productName", phone, fact({ field: "productName", value: "iPhone 15 Pro" }))).toBe(false);
    expect(valuesAgree("productName", phone, fact({ field: "productName", value: "iPhone 15 128GB" }))).toBe(false);
    expect(valuesAgree("productName", phone, fact({ field: "productName", value: "iPhone" }))).toBe(false);
    expect(valuesAgree("model", fact({ field: "model", value: "WH-1000XM5" }), fact({ field: "model", value: "WH-1000XM4" }))).toBe(false);
  });

  it("requires the same currency and a 1% tolerance for prices", () => {
    const usd = fact({ field: "price", value: 699.95, unit: "USD" });
    expect(valuesAgree("price", usd, fact({ field: "price", value: 699.0, unit: "usd" }))).toBe(true);
    expect(valuesAgree("price", usd, fact({ field: "price", value: 649.95, unit: "USD" }))).toBe(false);
    expect(valuesAgree("price", usd, fact({ field: "price", value: 699.95, unit: "GBP" }))).toBe(false);
    expect(valuesAgree("price", usd, fact({ field: "price", value: 699.95, unit: null }))).toBe(false);
  });

  it("converts weight and capacity units with a 2% tolerance", () => {
    const kg = fact({ field: "weight", value: 1.2, unit: "kg" });
    expect(valuesAgree("weight", kg, fact({ field: "weight", value: "2.65 lbs" }))).toBe(true);
    expect(valuesAgree("weight", kg, fact({ field: "weight", value: 1200, unit: "g" }))).toBe(true);
    expect(valuesAgree("weight", kg, fact({ field: "weight", value: 1.3, unit: "kg" }))).toBe(false);
    const litres = fact({ field: "capacity", value: "2 L" });
    expect(valuesAgree("capacity", litres, fact({ field: "capacity", value: 2000, unit: "ml" }))).toBe(true);
    expect(valuesAgree("capacity", litres, fact({ field: "capacity", value: 2, unit: "kg" }))).toBe(false);
  });

  it("compares GTINs after padding", () => {
    expect(valuesAgree("gtin", fact({ field: "gtin", value: "012345678905" }), fact({ field: "gtin", value: "0012345678905" }))).toBe(true);
  });
});

describe("resolveField", () => {
  it("returns UNKNOWN with no facts", () => {
    const r = resolveField("price", [], NOW);
    expect(r.status).toBe("UNKNOWN");
    expect(r.value).toBeNull();
    expect(r.chosen).toBeNull();
  });

  it("lets an identifier-matched manufacturer beat a retailer and notes the disagreement", () => {
    const maker = fact({ field: "weight", value: 1.2, unit: "kg", source: "MANUFACTURER", sourceName: "Breville", sourceUrl: "https://breville.com/x", matchBasis: "mpn" });
    const shop = fact({ field: "weight", value: 1.5, unit: "kg", source: "RETAILER", sourceName: "BigShop", sourceUrl: "https://bigshop.example/x" });
    const r = resolveField("weight", [shop, maker], NOW);
    expect(r.status).toBe("VERIFIED");
    expect(r.value).toBe(1.2);
    expect(r.unit).toBe("kg");
    expect(r.chosen).toBe(maker);
    expect(r.alternatives).toEqual([shop]);
    expect(r.note).toMatch(/BigShop lists 1.5 kg/);
  });

  it("verifies when two independent secondary sources agree", () => {
    const a = fact({ field: "color", value: "Brushed Stainless Steel", source: "SECONDARY", sourceName: "A", sourceUrl: "https://a.example/1" });
    const b = fact({ field: "color", value: "brushed stainless steel", source: "SECONDARY", sourceName: "B", sourceUrl: "https://www.b.example/2" });
    const r = resolveField("color", [a, b], NOW);
    expect(r.status).toBe("VERIFIED");
    expect(r.value).toBe("Brushed Stainless Steel");
  });

  it("does not count two pages on the same host as independent", () => {
    const a = fact({ field: "color", value: "Black", source: "SECONDARY", sourceUrl: "https://a.example/1" });
    const b = fact({ field: "color", value: "black", source: "SECONDARY", sourceUrl: "https://a.example/2" });
    expect(resolveField("color", [a, b], NOW).status).toBe("SUPPORTED");
  });

  it("is SUPPORTED with a single non-authoritative source", () => {
    const r = resolveField("color", [fact({ field: "color", value: "Black" })], NOW);
    expect(r.status).toBe("SUPPORTED");
    expect(r.value).toBe("Black");
  });

  it("is CONFLICTING with no value when equal-authority sources disagree", () => {
    const a = fact({ field: "price", value: 699.95, unit: "USD", sourceName: "ShopA", sourceUrl: "https://a.example/p" });
    const b = fact({ field: "price", value: 599.95, unit: "USD", sourceName: "ShopB", sourceUrl: "https://b.example/p" });
    const r = resolveField("price", [a, b], NOW);
    expect(r.status).toBe("CONFLICTING");
    expect(r.value).toBeNull();
    expect(r.note).toMatch(/ShopA/);
    expect(r.note).toMatch(/ShopB/);
  });

  it("is CONFLICTING when a near-authority source disagrees with a non-manufacturer winner", () => {
    const feed = fact({ field: "warranty", value: "2 years", source: "STRUCTURED_FEED", matchBasis: "brand+name" });
    const shop = fact({ field: "warranty", value: "1 year", source: "RETAILER", sourceUrl: "https://b.example/p" });
    expect(resolveField("warranty", [feed, shop], NOW).status).toBe("CONFLICTING");
  });

  it("keeps a retailer value over a far weaker disagreeing source", () => {
    const shop = fact({ field: "color", value: "Black" });
    const blog = fact({ field: "color", value: "Silver", source: "SECONDARY", sourceName: "Blog", sourceUrl: "https://blog.example/x" });
    const r = resolveField("color", [shop, blog], NOW);
    expect(r.status).toBe("SUPPORTED");
    expect(r.value).toBe("Black");
    expect(r.note).toMatch(/Blog lists Silver/);
  });

  it("treats Barista Express vs Barista Pro from retailers as a conflict", () => {
    const a = fact({ field: "productName", value: "Barista Express", sourceUrl: "https://a.example/p" });
    const b = fact({ field: "productName", value: "Barista Pro", sourceUrl: "https://b.example/p" });
    const r = resolveField("productName", [a, b], NOW);
    expect(r.status).toBe("CONFLICTING");
    expect(r.value).toBeNull();
  });

  it("never shows a stale price as current", () => {
    const old = fact({ field: "price", value: 699.95, unit: "USD", observedAt: ago(3 * DAY) });
    const older = fact({ field: "price", value: 649.95, unit: "USD", observedAt: ago(10 * DAY) });
    const r = resolveField("price", [older, old], NOW);
    expect(r.status).toBe("STALE");
    expect(r.value).toBeNull();
    expect(r.chosen).toBe(old);
    expect(r.note).toMatch(/3 days old/);
  });

  it("drops stale facts but resolves from the fresh ones", () => {
    const old = fact({ field: "price", value: 599.95, unit: "USD", observedAt: ago(3 * DAY), sourceUrl: "https://b.example/p" });
    const fresh = fact({ field: "price", value: 699.95, unit: "USD", observedAt: ago(2 * HOUR) });
    const r = resolveField("price", [old, fresh], NOW);
    expect(r.status).toBe("SUPPORTED");
    expect(r.value).toBe(699.95);
    expect(r.alternatives).toEqual([old]);
  });

  it("does not merge prices in different currencies", () => {
    const usd = fact({ field: "price", value: 699.95, unit: "USD" });
    const gbp = fact({ field: "price", value: 699.95, unit: "GBP", sourceUrl: "https://b.example/p" });
    const r = resolveField("price", [usd, gbp], NOW);
    expect(r.status).toBe("CONFLICTING");
    expect(r.value).toBeNull();
  });

  it("verifies agreeing weights in different units from two hosts", () => {
    const a = fact({ field: "weight", value: 1.2, unit: "kg" });
    const b = fact({ field: "weight", value: "2.65 lb", sourceUrl: "https://b.example/p" });
    const r = resolveField("weight", [a, b], NOW);
    expect(r.status).toBe("VERIFIED");
  });

  it("verifies from an identifier-matched structured feed", () => {
    const r = resolveField("price", [fact({ field: "price", value: 10, unit: "USD", source: "STRUCTURED_FEED", matchBasis: "gtin" })], NOW);
    expect(r.status).toBe("VERIFIED");
  });
});

describe("resolveFacts and completeness", () => {
  it("resolves per field and reports gaps", () => {
    const facts: Fact[] = [
      fact({ field: "brand", value: "Breville", source: "MANUFACTURER", sourceUrl: "https://breville.com" }),
      fact({ field: "price", value: 699.95, unit: "USD", observedAt: ago(5 * DAY) }),
      fact({ field: "color", value: "Black", sourceUrl: "https://a.example" }),
      fact({ field: "color", value: "Red", sourceUrl: "https://b.example" }),
    ];
    const resolved = resolveFacts(facts, NOW);
    expect(Object.keys(resolved).sort()).toEqual(["brand", "color", "price"]);
    const applicable: FactField[] = ["brand", "price", "color", "weight"];
    expect(completeness(resolved, applicable)).toEqual({
      status: "PARTIAL",
      missing: ["weight"],
      conflicting: ["color"],
      stale: ["price"],
    });
    expect(completeness(resolved, ["brand"]).status).toBe("COMPLETE");
    expect(completeness(resolved, ["price", "weight"]).status).toBe("MISSING");
  });
});

describe("priceTier", () => {
  const base = { price: 699.95, currency: "USD", categorySlug: "kitchen-appliances", observedAt: ago(HOUR) };

  it("tiers a current USD price against the category bands", () => {
    const t = priceTier(base, NOW);
    expect(t?.tier).toBe("premium");
    expect(t?.methodology).toBe(
      "USD 699.95 observed 2026-10-06 against Kitchen Appliances bands: budget ≤ $80, mid-range ≤ $300, premium > $300",
    );
  });

  it("uses the parent category bands for a subcategory slug", () => {
    const t = priceTier({ ...base, price: 60, categorySlug: "coffee-machines" }, NOW);
    expect(t?.tier).toBe("budget");
    expect(t?.methodology).toMatch(/Coffee & espresso machines bands/);
  });

  it("returns null for a stale price", () => {
    expect(priceTier({ ...base, observedAt: ago(3 * DAY) }, NOW)).toBeNull();
    expect(priceTier({ ...base, observedAt: null }, NOW)).toBeNull();
  });

  it("returns null without bands or in another currency", () => {
    expect(priceTier({ ...base, categorySlug: "ai-tools" }, NOW)).toBeNull();
    expect(priceTier({ ...base, categorySlug: "no-such-category" }, NOW)).toBeNull();
    expect(priceTier({ ...base, categorySlug: null }, NOW)).toBeNull();
    expect(priceTier({ ...base, currency: "GBP" }, NOW)).toBeNull();
    expect(priceTier({ ...base, price: null }, NOW)).toBeNull();
  });
});
