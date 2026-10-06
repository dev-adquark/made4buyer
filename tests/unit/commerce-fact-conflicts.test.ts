import { describe, expect, it } from "vitest";
import { summarize } from "@/lib/products/enrich";
import { resolveField } from "@/lib/products/facts";
import { extractOffersFromJsonLd } from "@/lib/products/page-extract";
import type { Fact, FactSource } from "@/lib/products/types";

// SAMPLE values only.
const NOW = new Date("2026-10-06T12:00:00Z");
const HOUR = 3_600_000;
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR);

const fact = (source: FactSource, value: Fact["value"], over: Partial<Fact> = {}): Fact => ({
  field: "warranty",
  value,
  unit: null,
  source,
  sourceName: source.toLowerCase(),
  sourceUrl: `https://${source.toLowerCase()}.example/p`,
  observedAt: at(1),
  matchBasis: "mpn",
  ...over,
});

describe("field conflicts between sources (resolver)", () => {
  it("is CONFLICTING with no value when two top-authority sources disagree for the same exact identity, even if one is newer", () => {
    const a = fact("MANUFACTURER", "1 Year Limited Warranty", { sourceUrl: "https://www.breville.com/us/en/products/bes870.html", observedAt: at(200) });
    const b = fact("MANUFACTURER", "2 Year Limited Warranty", { sourceUrl: "https://www.breville.com/us/en/support/warranty.html", observedAt: at(1) });
    const r = resolveField("warranty", [a, b], NOW);
    expect(r.status).toBe("CONFLICTING");
    expect(r.value).toBeNull();
    expect(r.note).toMatch(/sources disagree/);
  });

  it("the summary lists the field as conflicting and exposes no value for display", () => {
    const a = fact("MANUFACTURER", "1 Year Limited Warranty", { sourceUrl: "https://www.breville.com/a" });
    const b = fact("MANUFACTURER", "2 Year Limited Warranty", { sourceUrl: "https://www.breville.com/b" });
    const s = summarize([a, b], null, NOW);
    // (summary.conflicting lists only the category's applicable fields; the field state itself is per field.)
    expect(s.fields.warranty).toMatchObject({ status: "CONFLICTING", value: null });
  });

  it("a lower-authority source never overwrites a higher one, however recent", () => {
    const maker = fact("MANUFACTURER", 599.95, { field: "price", unit: "USD", observedAt: at(40) });
    for (const lower of ["STRUCTURED_FEED", "RETAILER", "WIKIDATA", "SECONDARY"] as const) {
      const other = fact(lower, 549.99, { field: "price", unit: "USD", observedAt: at(0) });
      const r = resolveField("price", [other, maker], NOW);
      expect(r.chosen).toBe(maker);
      expect(r.value).toBe(599.95);
      expect(r.status).toBe("VERIFIED");
    }
  });

  it("authority order is MANUFACTURER > official feed > authorized retailer > structured > secondary", () => {
    const order: FactSource[] = ["MANUFACTURER", "STRUCTURED_FEED", "RETAILER", "WIKIDATA", "SECONDARY"];
    for (let i = 0; i < order.length - 1; i++) {
      const hi = fact(order[i], "Black", { field: "color", matchBasis: "brand+name" });
      const lo = fact(order[i + 1], "Black", { field: "color", matchBasis: "brand+name", sourceUrl: "https://other.example/x" });
      expect(resolveField("color", [lo, hi], NOW).chosen).toBe(hi);
    }
  });

  it("two retailers that agree are not a conflict", () => {
    const r = resolveField("warranty", [fact("RETAILER", "1 Year", { sourceUrl: "https://a.example/p" }), fact("RETAILER", "1 year", { sourceUrl: "https://b.example/p" })], NOW);
    expect(r.status).toBe("VERIFIED");
  });
});

describe("list price (Deals) is stored only when the page states it", () => {
  const product = (offers: unknown) => [{ "@context": "https://schema.org", "@type": "Product", name: "Breville Barista Express", brand: { "@type": "Brand", name: "Breville" }, offers }];
  const url = "https://www.breville.com/us/en/products/espresso/bes870.html";

  it.each([["https://schema.org/ListPrice"], ["https://schema.org/StrikethroughPrice"], ["ListPrice"]])("reads a %s UnitPriceSpecification", (priceType) => {
    const [o] = extractOffersFromJsonLd(product({ "@type": "Offer", price: "599.95", priceCurrency: "USD", priceSpecification: [{ "@type": "UnitPriceSpecification", priceType, price: 749.95, priceCurrency: "USD" }] }), url);
    expect(o).toMatchObject({ price: 599.95, listPrice: 749.95, currency: "USD" });
  });

  it("never derives one from highPrice, MSRP, a sale-price spec or another currency", () => {
    const cases = [
      { "@type": "Offer", price: "599.95", highPrice: "749.95", priceCurrency: "USD" },
      { "@type": "Offer", price: "599.95", priceCurrency: "USD", priceSpecification: { "@type": "UnitPriceSpecification", priceType: "https://schema.org/MSRP", price: 799 } },
      { "@type": "Offer", priceCurrency: "USD", priceSpecification: { "@type": "UnitPriceSpecification", priceType: "https://schema.org/SalePrice", price: 599.95 } },
      { "@type": "Offer", price: "599.95", priceCurrency: "USD", priceSpecification: { "@type": "UnitPriceSpecification", priceType: "https://schema.org/ListPrice", price: 699, priceCurrency: "CAD" } },
      { "@type": "AggregateOffer", lowPrice: "549.99", highPrice: "749.95", priceCurrency: "USD" },
      { "@type": "Offer", price: "599.95", priceCurrency: "USD" },
    ];
    for (const c of cases) {
      const [o] = extractOffersFromJsonLd(product(c), url);
      expect(o).toBeDefined();
      expect(o.listPrice).toBeUndefined();
    }
  });
});
