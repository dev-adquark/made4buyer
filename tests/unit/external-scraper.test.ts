import { describe, expect, it } from "vitest";
import { buildExternalScraperInput, rowToRawPayload } from "@/lib/commerce/external-scraper";
import { normalizeCommerceRecord } from "@/lib/commerce/normalize";
import { extractOfficialProductImages } from "@/lib/images/deal-image";

/**
 * The digital_influx/product-data actor's own documented output (lib/commerce/external-scraper.ts
 * header) round-tripped through rowToRawPayload → normalizeCommerceRecord — the same parser every
 * other source (Apify's generic actor, direct-crawl) already goes through. Confirms the mapping is
 * correct before it is ever used against a real, paid run.
 */
const SAMPLE = {
  type: "product" as const,
  store: "thesill.com",
  url: "https://www.thesill.com/products/plant-mom-tote-bag",
  status: "ok" as const,
  name: "Plant Mom Tote Bag",
  brand: "The Sill",
  sku: "AC-TBG-PM-NT",
  gtin: null,
  price: 15,
  currency: "USD",
  listPrice: 19,
  availability: "out_of_stock",
  image: "https://www.thesill.com/cdn/shop/products/the-sill_plant-mom-tote_variant_01.jpg",
};

describe("rowToRawPayload", () => {
  it("builds a page normalizeCommerceRecord reads exactly like any other JSON-LD source", () => {
    const payload = rowToRawPayload(SAMPLE);
    expect(payload).toBeTruthy();
    const n = normalizeCommerceRecord(payload, { market: "US" });
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect(n.product).toMatchObject({ name: "Plant Mom Tote Bag", sku: "AC-TBG-PM-NT", brand: "The Sill", price: 15, currency: "USD", listPrice: 19, availability: "OutOfStock" });
    expect(n.canonicalUrl).toBe(SAMPLE.url);
  });

  it("skips a row that was not successfully read, or has no price", () => {
    expect(rowToRawPayload({ ...SAMPLE, status: "blocked_by_site" })).toBeNull();
    expect(rowToRawPayload({ ...SAMPLE, status: "no_product_data", price: null })).toBeNull();
    expect(rowToRawPayload({ ...SAMPLE, price: null })).toBeNull();
    expect(rowToRawPayload({ ...SAMPLE, price: 0 })).toBeNull();
    expect(rowToRawPayload({ type: "store", status: "ok" })).toBeNull(); // a store summary row, not a product
  });

  it("omits listPrice when it is not actually higher than price (never invents a discount)", () => {
    const payload = rowToRawPayload({ ...SAMPLE, listPrice: 15 })!;
    const n = normalizeCommerceRecord(payload, { market: "US" });
    expect(n.ok && n.product.listPrice).toBeUndefined();
  });

  it("maps every documented availability value to a schema.org URL normalizeCommerceRecord strips back to the bare word", () => {
    for (const [raw, expected] of [
      ["in_stock", "InStock"],
      ["limited_stock", "LimitedAvailability"],
      ["out_of_stock", "OutOfStock"],
      ["pre_order", "PreOrder"],
      ["back_order", "BackOrder"],
      ["discontinued", "Discontinued"],
    ] as const) {
      const n = normalizeCommerceRecord(rowToRawPayload({ ...SAMPLE, availability: raw }), { market: "US" });
      expect(n.ok && n.product.availability, raw).toBe(expected);
    }
  });
});

describe("official product photo from an external-scraper row", () => {
  it("puts the row's image into the JSON-LD Product, so the deal card shows the store's own photo", () => {
    const payload = rowToRawPayload(SAMPLE)!;
    expect((payload.jsonLd as Array<{ image?: string }>)[0].image).toBe(SAMPLE.image);
    expect(extractOfficialProductImages(payload, SAMPLE.url).map((i) => i.src)).toEqual([SAMPLE.image]);
  });
});

describe("buildExternalScraperInput", () => {
  it("one bare store domain per brand, deduped, www stripped", () => {
    const body = buildExternalScraperInput(
      [{ officialDomain: "www.acme.example" }, { officialDomain: "acme.example" }, { officialDomain: "other.example" }],
      20,
    );
    expect(body.storeUrls).toEqual(["acme.example", "other.example"]);
    expect(body.maxProductsPerStore).toBe(20);
    expect(body.compareWithPreviousRun).toBe(false);
  });
});
