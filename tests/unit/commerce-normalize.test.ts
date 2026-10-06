import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeCommerceRecord } from "@/lib/commerce/normalize";
import { PRODUCT_PAGE_FUNCTION } from "@/lib/commerce/page-functions/product";
import { extractOffersFromJsonLd, extractProductFromHtml, extractProductFromJsonLd } from "@/lib/products/page-extract";

const DIR = path.join(process.cwd(), "fixtures/product-pages");
const fixture = (name: string) => readFileSync(path.join(DIR, name), "utf8");

/** What the browser page function would collect from a fixture: ld+json (parsed, or raw text), og:/product: meta, h1, title. */
function browserParts(html: string) {
  const jsonLd: unknown[] = [];
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try {
      jsonLd.push(JSON.parse(m[1]));
    } catch {
      jsonLd.push(m[1]);
    }
  }
  const meta: Record<string, string> = {};
  for (const m of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const key = /(?:property|name)\s*=\s*"([^"]*)"/i.exec(m[1])?.[1]?.toLowerCase();
    const content = /content\s*=\s*"([^"]*)"/i.exec(m[1])?.[1];
    if (key && content && !(key in meta) && (/^(og|product):/.test(key) || key === "twitter:title")) meta[key] = content;
  }
  const tag = (t: string) => {
    const m = new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)<\\/${t}\\s*>`, "i").exec(html);
    return m ? m[1].replace(/<[^>]*>/g, " ") : undefined;
  };
  return { jsonLd, meta, h1: tag("h1"), title: tag("title") };
}

const record = (url: string, over: Record<string, unknown> = {}) => ({ m4bCommerce: 1, url, canonicalUrl: null, title: null, jsonLd: [], meta: {}, h1: null, breadcrumbs: [], specTables: [], images: [], lang: "en-US", ...over });

const EXPRESS_URL = "https://www.breville.com/us/en/products/espresso/bes870.html";

describe("extractProductFromJsonLd", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".html"));
  it.each(files)("matches extractProductFromHtml on %s", (file) => {
    const html = fixture(file);
    const url = file.startsWith("retailer") ? "https://www.bestbuy.com/site/breville-the-barista-express-espresso-machine/6366540.p?skuId=6366540" : EXPRESS_URL;
    const p = browserParts(html);
    expect(extractProductFromJsonLd(p.jsonLd, url, p.meta, { h1: p.h1, title: p.title })).toEqual(extractProductFromHtml(html, url));
  });

  it("covers at least the main fixtures", () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it("returns every stated offer of the page's product, AggregateOffer sub-offers individually", () => {
    const p = browserParts(fixture("retailer-aggregate-offer.html"));
    const url = "https://www.bestbuy.com/site/x/6366540.p";
    expect(extractOffersFromJsonLd(p.jsonLd, url, p.meta, { h1: p.h1, title: p.title })).toEqual([{ type: "Offer", price: 549.99, currency: "USD", seller: "Best Buy" }]);
    const listing = browserParts(fixture("listing-multiple-products.html"));
    expect(extractOffersFromJsonLd(listing.jsonLd, url, listing.meta, { h1: listing.h1, title: listing.title })).toEqual([]);
  });
});

describe("normalizeCommerceRecord", () => {
  it("normalizes a manufacturer JSON-LD product with offer, list price, specs and images", () => {
    const p = browserParts(fixture("manufacturer-breville-barista-express.html"));
    const n = normalizeCommerceRecord(
      record(`${EXPRESS_URL}?utm_source=x`, {
        canonicalUrl: EXPRESS_URL,
        jsonLd: p.jsonLd,
        meta: p.meta,
        h1: "the Barista Express™",
        specTables: [
          { name: "Pump Pressure", value: "9 bar (duplicate name: JSON-LD wins)" },
          { name: "Bean Hopper Capacity", value: "250 g" },
          { name: "", value: "ignored" },
        ],
        images: [{ src: "https://www.breville.com/img/bes870.jpg", alt: "Barista Express" }, { src: "data:image/png;base64,AAA", alt: null }, { src: "https://www.breville.com/img/bes870.jpg", alt: "dupe" }],
      }),
    );
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect(n.canonicalUrl).toBe(EXPRESS_URL);
    expect(n.product).toMatchObject({ name: "Breville Barista Express", brand: "Breville", mpn: "BES870XL", gtin: "0021614062161", price: 599.95, listPrice: 749.95, currency: "USD", availability: "InStock" });
    expect(n.offers).toEqual([{ type: "Offer", price: 599.95, listPrice: 749.95, currency: "USD", availability: "InStock", seller: "Breville USA", url: EXPRESS_URL, source: "json-ld" }]);
    expect(n.specs.find((s) => s.name === "Pump Pressure")).toEqual({ name: "Pump Pressure", value: "15 bar", source: "json-ld" });
    expect(n.specs).toContainEqual({ name: "Bean Hopper Capacity", value: "250 g", source: "page-table" });
    expect(n.images).toEqual([{ src: "https://www.breville.com/img/bes870.jpg", alt: "Barista Express" }]);
    expect(n.extractionMethod).toBe("apify-web-scraper:json-ld");
  });

  it("keeps absent fields absent (never guessed)", () => {
    const n = normalizeCommerceRecord(record("https://www.example-brand.com/p/widget", { jsonLd: [{ "@context": "https://schema.org", "@type": "Product", name: "Example Widget", brand: "Example" }] }));
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect(n.product).toEqual({ url: "https://www.example-brand.com/p/widget", name: "Example Widget", brand: "Example", extractedFrom: ["json-ld"] });
    for (const k of ["price", "listPrice", "currency", "availability", "gtin", "mpn", "model", "sku"]) expect(k in n.product).toBe(false);
    expect(n.offers).toEqual([]);
    expect(n.specs).toEqual([]);
  });

  it("uses product: meta price as one offer when there is no JSON-LD offer", () => {
    const p = browserParts(fixture("meta-only-product.html"));
    const n = normalizeCommerceRecord(record("https://www.rei.com/product/123/yeti-rambler", { jsonLd: p.jsonLd, meta: p.meta, h1: p.h1, title: p.title }));
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect(n.offers).toEqual([{ type: "Offer", price: 35, currency: "USD", availability: "InStock", source: "meta" }]);
    expect(n.extractionMethod).toBe("apify-web-scraper:meta");
  });

  it("ignores a canonical URL on another site and rejects non-product and foreign records", () => {
    const n = normalizeCommerceRecord(record(EXPRESS_URL, { canonicalUrl: "https://evil.example/p", jsonLd: [{ "@type": "Product", name: "Breville Barista Express" }] }));
    expect(n.ok && n.canonicalUrl).toBe(EXPRESS_URL);
    expect(normalizeCommerceRecord(record(EXPRESS_URL))).toMatchObject({ ok: false, code: "NO_PRODUCT" });
    expect(normalizeCommerceRecord({ m4b: 1, url: EXPRESS_URL })).toMatchObject({ ok: false, code: "NOT_COMMERCE_RECORD" });
    expect(normalizeCommerceRecord(record("ftp://x/y"))).toMatchObject({ ok: false, code: "INVALID_URL" });
    const listing = browserParts(fixture("listing-multiple-products.html"));
    expect(normalizeCommerceRecord(record("https://www.example.com/c/espresso", { jsonLd: listing.jsonLd, meta: listing.meta, h1: listing.h1, title: listing.title }))).toMatchObject({ ok: false, code: "NO_PRODUCT" });
  });
});

describe("PRODUCT_PAGE_FUNCTION", () => {
  it("is a valid function that returns raw parts only", () => {
    const fn = new Function(`return (${PRODUCT_PAGE_FUNCTION})`)();
    expect(typeof fn).toBe("function");
    expect(PRODUCT_PAGE_FUNCTION).toContain("m4bCommerce: 1");
    expect(PRODUCT_PAGE_FUNCTION).toContain("productPatterns");
  });

  it("returns null for a URL outside the product patterns", async () => {
    const fn = new Function(`return (${PRODUCT_PAGE_FUNCTION})`)() as (ctx: unknown) => Promise<unknown>;
    expect(await fn({ request: { url: "https://www.breville.com/us/en/support" }, customData: { productPatterns: ["^https://www\\.breville\\.com/us/en/products/.*$"] } })).toBeNull();
  });
});
