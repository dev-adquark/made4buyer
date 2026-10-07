import { describe, expect, it } from "vitest";
import { normalizeCommerceRecord, SHOPIFY_METHOD } from "@/lib/commerce/normalize";
import { centsToAmount, chooseVariant, gtinFromBarcode, isValidGtin, readShopifyProduct, readVariants } from "@/lib/commerce/shopify";

// SAMPLE data shaped like a Shopify `/products/<handle>.js` response (prices in cents).
const URL_BASE = "https://shop.example.com/products/cloud-pillow";
const variant = (id: number, over: Record<string, unknown> = {}) => ({ id, title: `Size ${id}`, sku: `CP-${id}`, barcode: null, available: true, price: 9900, compare_at_price: null, ...over });
const product = (variants: unknown[], over: Record<string, unknown> = {}) => ({ id: 1, title: "Cloud Pillow", handle: "cloud-pillow", variants, ...over });

describe("Shopify product JSON", () => {
  it("reads cents as dollars and ignores non-positive or fractional cents", () => {
    expect(centsToAmount(12999)).toBe(129.99);
    expect(centsToAmount("4500")).toBe(45);
    expect(centsToAmount(0)).toBeNull();
    expect(centsToAmount(12.5)).toBeNull();
    expect(centsToAmount("12.99")).toBeNull();
    expect(centsToAmount(null)).toBeNull();
  });

  it("validates GTIN check digits (8/12/13/14) and rejects anything else", () => {
    expect(isValidGtin("012345678905")).toBe(true); // UPC-A
    expect(isValidGtin("4006381333931")).toBe(true); // EAN-13
    expect(isValidGtin("96385074")).toBe(true); // EAN-8
    expect(isValidGtin("00012345678905")).toBe(true); // GTIN-14
    expect(isValidGtin("012345678906")).toBe(false); // wrong check digit
    expect(isValidGtin("4006381333932")).toBe(false);
    expect(isValidGtin("0000000000000")).toBe(false);
    expect(isValidGtin("12345")).toBe(false);
    expect(isValidGtin("CP-123")).toBe(false);
    expect(gtinFromBarcode("0123-4567-8905")).toBe("012345678905"); // hyphens/spaces tolerated
    expect(gtinFromBarcode("UPC 012345678905")).toBeNull(); // anything else is not
    expect(gtinFromBarcode("012345678905")).toBe("012345678905");
    expect(gtinFromBarcode("4006381333932")).toBeNull();
    expect(gtinFromBarcode("")).toBeNull();
  });

  it("chooses the URL's ?variant=, else the first AVAILABLE variant, else none", () => {
    const vs = readVariants(product([variant(11, { available: false }), variant(22), variant(33)]));
    expect(chooseVariant(vs, `${URL_BASE}?variant=33`)).toMatchObject({ variant: { id: "33" }, chosenBy: "url" });
    expect(chooseVariant(vs, URL_BASE)).toMatchObject({ variant: { id: "22" }, chosenBy: "first-available" });
    // A ?variant= that is not this product's: none (never another variant instead).
    expect(chooseVariant(vs, `${URL_BASE}?variant=99`)).toBeNull();
    // Nothing available and no ?variant=: none.
    expect(chooseVariant(readVariants(product([variant(11, { available: false })])), URL_BASE)).toBeNull();
    // An out-of-stock variant named in the URL is still that variant.
    expect(chooseVariant(vs, `${URL_BASE}?variant=11`)).toMatchObject({ variant: { id: "11", available: false } });
  });

  it("compare_at_price above price is a CompareAtPrice list price; equal, lower or absent is none", () => {
    const above = readShopifyProduct(product([variant(1, { price: 7900, compare_at_price: 9900 })]), URL_BASE);
    expect(above).toMatchObject({ ok: true, offer: { price: 79, listPrice: 99, listPriceType: "CompareAtPrice", availability: "InStock" } });
    for (const cmp of [7900, 5000, null, 0]) {
      const r = readShopifyProduct(product([variant(1, { price: 7900, compare_at_price: cmp })]), URL_BASE);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.offer.listPrice).toBeUndefined();
        expect(r.offer.listPriceType).toBeUndefined();
      }
    }
  });

  it("names a multi-variant product by product + variant title, a single 'Default Title' variant by product only", () => {
    const multi = readShopifyProduct(product([variant(1, { title: "Queen" }), variant(2, { title: "King" })]), `${URL_BASE}?variant=2`);
    expect(multi).toMatchObject({ ok: true, offer: { name: "Cloud Pillow – King", variantCount: 2, variant: { sku: "CP-2" } } });
    const single = readShopifyProduct(product([variant(1, { title: "Default Title" })]), URL_BASE);
    expect(single).toMatchObject({ ok: true, offer: { name: "Cloud Pillow" } });
    const oos = readShopifyProduct(product([variant(1, { available: false })]), `${URL_BASE}?variant=1`);
    expect(oos).toMatchObject({ ok: true, offer: { availability: "OutOfStock" } });
    expect(readShopifyProduct(product([]), URL_BASE)).toMatchObject({ ok: false });
    expect(readShopifyProduct({ variants: [variant(1)] }, URL_BASE)).toMatchObject({ ok: false });
  });
});

describe("normalizeCommerceRecord with Shopify product JSON", () => {
  const ld = (offers: unknown) => [{ "@context": "https://schema.org", "@type": "Product", name: "Cloud Pillow", sku: "GROUP-SKU", brand: { "@type": "Brand", name: "Example" }, offers }];
  const record = (over: Record<string, unknown> = {}) => ({
    m4bCommerce: 1,
    url: URL_BASE,
    requestUrl: URL_BASE,
    crawlLabel: "PRODUCT",
    canonicalUrl: URL_BASE,
    title: "Cloud Pillow",
    h1: "Cloud Pillow",
    jsonLd: ld({ "@type": "Offer", price: "99.00", priceCurrency: "USD" }),
    meta: {},
    shopifyCurrency: "USD",
    shopifyCountry: "US",
    shopifyProduct: product([variant(1, { title: "Queen", sku: "CP-Q", barcode: "012345678905", price: 7900, compare_at_price: 9900 }), variant(2, { title: "King", sku: "CP-K", barcode: "012345678906", price: 8900, compare_at_price: 8900 })]),
    ...over,
  });

  it("takes identity, price, compare-at and availability from ONE variant, with a variant canonical URL", () => {
    const n = normalizeCommerceRecord(record(), { market: "US" });
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect(n.extractionMethod).toBe(SHOPIFY_METHOD);
    expect(n.canonicalUrl).toBe(`${URL_BASE}?variant=1`);
    expect(n.product).toMatchObject({ name: "Cloud Pillow – Queen", sku: "CP-Q", gtin: "012345678905", price: 79, listPrice: 99, currency: "USD", availability: "InStock", brand: "Example" });
    expect(n.offers).toEqual([{ type: "Offer", price: 79, listPrice: 99, listPriceType: "CompareAtPrice", currency: "USD", availability: "InStock", url: `${URL_BASE}?variant=1`, source: "shopify", confidence: 1 }]);
  });

  it("an invalid barcode is not a GTIN, and an equal compare-at price is no list price", () => {
    const n = normalizeCommerceRecord(record({ url: `${URL_BASE}?variant=2`, requestUrl: `${URL_BASE}?variant=2` }), { market: "US" });
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect(n.product.name).toBe("Cloud Pillow – King");
    expect(n.product.sku).toBe("CP-K");
    expect(n.product.gtin).toBeUndefined();
    expect(n.offers[0]).toMatchObject({ price: 89 });
    expect(n.offers[0].listPrice).toBeUndefined();
  });

  it("falls back to JSON-LD when the Shopify session is not the US storefront or the currency is unknown", () => {
    const ca = normalizeCommerceRecord(record({ shopifyCountry: "CA", shopifyCurrency: "CAD" }), { market: "US" });
    expect(ca.ok && ca.extractionMethod).toBe("apify-web-scraper:json-ld");
    expect(ca.ok && ca.notes.some((x) => /not US/.test(x))).toBe(true);
    const noCurrency = normalizeCommerceRecord(record({ shopifyCurrency: null, jsonLd: ld({ "@type": "Offer", price: "99.00" }) }), { market: "US" });
    expect(noCurrency.ok && noCurrency.extractionMethod).toBe("apify-web-scraper:json-ld");
  });

  it("a ?variant= that is not the product's leaves the JSON-LD reading in place", () => {
    const n = normalizeCommerceRecord(record({ url: `${URL_BASE}?variant=77`, requestUrl: `${URL_BASE}?variant=77` }), { market: "US" });
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect(n.extractionMethod).toBe("apify-web-scraper:json-ld");
    expect(n.product.sku).toBe("GROUP-SKU");
    expect(n.notes.join(" ")).toMatch(/variant 77/);
  });

  it("a store-applied discount on the page wins over the product JSON price for the same variant (as seen live on an official store)", () => {
    // Product JSON: 1149 (no compare-at). The page's own JSON-LD offer for that variant: 899 with a StrikethroughPrice of 1149.
    const jsonLd = [
      { "@context": "https://schema.org", "@type": "Product", name: "Cloud Pillow - Queen", sku: "CP-Q", offers: { "@type": "Offer", price: "899.00", priceCurrency: "USD", url: `${URL_BASE}?variant=1`, priceSpecification: { "@type": "UnitPriceSpecification", priceType: "https://schema.org/StrikethroughPrice", price: "1149.00", priceCurrency: "USD" } } },
      { "@context": "https://schema.org", "@type": "Product", name: "Cloud Pillow - King", sku: "CP-K", offers: { "@type": "Offer", price: "1199.00", priceCurrency: "USD", url: `${URL_BASE}?variant=2` } },
    ];
    const shopifyProduct = product([variant(1, { title: "Queen", sku: "CP-Q", price: 114900 }), variant(2, { title: "King", sku: "CP-K", price: 164900 })]);
    const n = normalizeCommerceRecord(record({ url: `${URL_BASE}?variant=1`, requestUrl: `${URL_BASE}?variant=1`, jsonLd, shopifyProduct }), { market: "US" });
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect(n.product).toMatchObject({ name: "Cloud Pillow – Queen", sku: "CP-Q", price: 899, listPrice: 1149 });
    expect(n.offers).toEqual([expect.objectContaining({ price: 899, listPrice: 1149, listPriceType: "StrikethroughPrice", currency: "USD", url: `${URL_BASE}?variant=1`, source: "json-ld" })]);
    expect(n.notes.join(" ")).toMatch(/differs/);
    // Same price on both: the product JSON offer (with its compare-at) stands.
    const same = normalizeCommerceRecord(record({ url: `${URL_BASE}?variant=2`, requestUrl: `${URL_BASE}?variant=2`, jsonLd, shopifyProduct: product([variant(1, { sku: "CP-Q" }), variant(2, { title: "King", sku: "CP-K", price: 119900, compare_at_price: 149900 })]) }), { market: "US" });
    expect(same.ok && same.offers[0]).toMatchObject({ price: 1199, listPrice: 1499, listPriceType: "CompareAtPrice", source: "shopify" });
  });

  it("a Shopify page without JSON-LD is still read from its product JSON", () => {
    const n = normalizeCommerceRecord(record({ jsonLd: [] }), { market: "US" });
    expect(n.ok).toBe(true);
    if (n.ok) expect(n.product).toMatchObject({ name: "Cloud Pillow – Queen", sku: "CP-Q", price: 79, listPrice: 99, extractedFrom: ["shopify"] });
  });
});
