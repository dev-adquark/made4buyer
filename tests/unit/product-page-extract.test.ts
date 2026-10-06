import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  brandKey,
  classifySource,
  extractProductFromHtml,
  normalizeGtin,
  sameProduct,
  extractProductFromJsonLd,
} from "@/lib/products/page-extract";
import type { ExtractedProduct, ProductIdentity } from "@/lib/products/types";

const fixture = (name: string) => readFileSync(path.join(process.cwd(), "fixtures/product-pages", name), "utf8");

const EXPRESS_URL = "https://www.breville.com/us/en/products/espresso/bes870.html";
const PRO_URL = "https://www.breville.com/us/en/products/espresso/bes878.html";

describe("extractProductFromHtml", () => {
  it("maps a manufacturer page with Product + Offer + additionalProperty", () => {
    const p = extractProductFromHtml(fixture("manufacturer-breville-barista-express.html"), EXPRESS_URL)!;
    expect(p).not.toBeNull();
    expect(p).toMatchObject({
      url: EXPRESS_URL,
      name: "Breville Barista Express",
      brand: "Breville",
      manufacturer: "Breville Group Limited",
      model: "BES870XL",
      mpn: "BES870XL",
      sku: "BES870BSS1BUS1",
      gtin: "0021614062161",
      category: "Espresso Machines",
      color: "Brushed Stainless Steel",
      material: "Stainless steel",
      weight: { value: 10.4, unit: "kg" },
      dimensions: "33 x 40 x 31 cm",
      capacity: "2 L",
      warranty: "1 Year Limited Product Warranty",
      price: 599.95,
      listPrice: 749.95,
      currency: "USD",
      availability: "InStock",
      seller: "Breville USA",
      rating: 4.6,
      ratingScale: 5,
      reviewCount: 8412,
      extractedFrom: ["json-ld"],
    });
    expect(p.description).toBe(
      "Go from beans to espresso in under a minute. The Barista Express® lets you grind the beans right before extraction.",
    );
    expect(p.features).toEqual([
      "Integrated conical burr grinder",
      "Digital temperature control (PID)",
      "Manual microfoam milk texturing",
    ]);
    expect(p.specs).toContainEqual({ name: "Pump Pressure", value: "15 bar" });
    expect(p.specs).toHaveLength(4);
  });

  it("reads a retailer AggregateOffer: lowPrice is the price, highPrice is never a list price", () => {
    const url = "https://www.bestbuy.com/site/breville-the-barista-express-espresso-machine/6366540.p?skuId=6366540";
    const p = extractProductFromHtml(fixture("retailer-aggregate-offer.html"), url)!;
    expect(p.name).toBe("Breville the Barista Express Espresso Machine BES870XL, Brushed Stainless Steel");
    expect(p.price).toBe(549.99);
    expect(p.listPrice).toBeUndefined();
    expect(p.currency).toBe("USD");
    expect(p.availability).toBe("InStock");
    expect(p.gtin).toBe("0021614062161");
    expect(p.rating).toBe(4.7);
    expect(p.reviewCount).toBe(1834);
    expect(p.extractedFrom).toEqual(["json-ld"]); // meta price ignored: JSON-LD had one
  });

  it("walks @graph, decodes entities, skips zero prices and parses '$349.95'", () => {
    const url = "https://www.delonghi.com/en-us/dedica-arte-ec885m/p/EC885.M";
    const p = extractProductFromHtml(fixture("graph-delonghi.html"), url)!;
    expect(p.name).toBe("De'Longhi Dedica Arte EC885.M Manual Espresso Machine");
    expect(p.brand).toBe("De'Longhi");
    expect(p.mpn).toBe("EC885.M");
    expect(p.gtin).toBe("8004399021133");
    expect(p.weight).toBe("4.2 kg");
    expect(p.capacity).toBe("1.1 L");
    expect(p.compatibility).toEqual(["Ground coffee", "ESE pods"]);
    expect(p.price).toBe(349.95);
    expect(p.currency).toBe("USD");
    expect(p.availability).toBe("OutOfStock");
  });

  it("returns null for a listing of several unrelated products", () => {
    const html = fixture("listing-multiple-products.html");
    expect(extractProductFromHtml(html, "https://www.williams-sonoma.com/shop/electrics/espresso-machines/")).toBeNull();
  });

  it("picks the listed product whose url is the page", () => {
    const html = fixture("listing-multiple-products.html");
    const p = extractProductFromHtml(html, "https://williams-sonoma.com/products/breville-barista-pro?utm_source=x");
    expect(p?.name).toBe("Breville Barista Pro Espresso Machine");
    expect(p?.price).toBe(849.95);
  });

  it("with related products, picks the page's own product by url, else by og:title/h1", () => {
    const html = fixture("product-with-related.html");
    const byUrl = extractProductFromHtml(html, "https://www.crateandbarrel.com/breville-bambino-plus/s123456?a=1&utm_source=feed");
    expect(byUrl?.name).toBe("Breville Bambino Plus Espresso Machine");
    const byTitle = extractProductFromHtml(html, "https://www.crateandbarrel.com/some/other/path");
    expect(byTitle?.name).toBe("Breville Bambino Plus Espresso Machine");
    expect(byTitle?.price).toBe(499.95);
  });

  it("is ambiguous (null) when several products exist and the title names none of them", () => {
    const html = fixture("product-with-related.html").replace(/Bambino Plus Espresso Machine<\/h1>/, "Shop</h1>")
      .replace(/content="Breville Bambino Plus Espresso Machine"/, 'content="Shop Breville"')
      .replace(/<title>[^<]*<\/title>/, "<title>Shop</title>");
    expect(extractProductFromHtml(html, "https://www.crateandbarrel.com/x")).toBeNull();
  });

  it("tolerates an invalid JSON block, lowercase @type, empty brand {}, and fills brand/availability from meta", () => {
    const url = "https://www.crutchfield.com/p_158WH1KXM5/Sony-WH-1000XM5-Black.html";
    const p = extractProductFromHtml(fixture("lowercase-type-and-invalid-json.html"), url)!;
    expect(p.name).toBe("Sony WH-1000XM5 Wireless Noise Canceling Headphones");
    expect(p.manufacturer).toBe("Sony");
    expect(p.brand).toBe("Sony"); // from product:brand, since JSON-LD brand was {}
    expect(p.gtin).toBe("027242923782");
    expect(p.price).toBe(399.99);
    expect(p.seller).toBe("Crutchfield");
    expect(p.availability).toBe("InStock");
    expect(p.reviewCount).toBe(212);
    expect(p.rating).toBe(4.5);
    expect(p.ratingScale).toBeUndefined();
    expect(p.extractedFrom).toEqual(["json-ld", "meta"]);
  });

  it("repairs entity-encoded JSON with raw newlines and trailing commas", () => {
    const p = extractProductFromHtml(fixture("entity-encoded-json.html"), "https://www.target.com/p/ninja-af101/-/A-1")!;
    expect(p.name).toBe("Ninja AF101 Air Fryer, 4 Quart");
    expect(p.brand).toBe("Ninja");
    expect(p.description).toBe("Crisp food with up to 75% less fat. Dehydrates, roasts & reheats.");
  });

  it("builds a product from og:type=product meta tags only", () => {
    const p = extractProductFromHtml(fixture("meta-only-product.html"), "https://www.rei.com/product/1")!;
    expect(p).toEqual({
      url: "https://www.rei.com/product/1",
      name: "Yeti Rambler 20 oz Tumbler",
      price: 35,
      currency: "USD",
      availability: "InStock",
      brand: "YETI",
      extractedFrom: ["meta"],
    });
  });

  it("returns null when no product name can be established", () => {
    expect(extractProductFromHtml(fixture("no-product.html"), "https://example.com/a")).toBeNull();
    expect(extractProductFromHtml("", "https://example.com/a")).toBeNull();
    expect(
      extractProductFromHtml('<script type="application/ld+json">{"@type":"Product","offers":{"price":5}}</script>', "https://x.com"),
    ).toBeNull();
  });

  it("caps description at 1000 characters", () => {
    const long = "word ".repeat(400);
    const html = `<script type="application/ld+json">{"@type":"Product","name":"Thing","description":"${long}"}</script>`;
    expect(extractProductFromHtml(html, "https://x.com")!.description!.length).toBeLessThanOrEqual(1000);
  });
});

describe("sameProduct", () => {
  const express = extractProductFromHtml(fixture("manufacturer-breville-barista-express.html"), EXPRESS_URL)!;
  const pro = extractProductFromHtml(fixture("manufacturer-breville-barista-pro.html"), PRO_URL)!;
  const cand = (over: Partial<ExtractedProduct>): ExtractedProduct => ({ url: "https://x.com", extractedFrom: ["json-ld"], ...over });

  it("matches on equal GTIN (padded to 14 digits)", () => {
    const r = sameProduct({ name: "Barista Express", brand: "Breville", gtin: "021614062161" }, express);
    expect(r).toMatchObject({ match: true, basis: "gtin" });
    expect(r.reason).toMatch(/GTIN/);
  });

  it("never matches Barista Express to Barista Pro (fixtures)", () => {
    const id: ProductIdentity = { name: "Breville Barista Express", brand: "Breville" };
    expect(sameProduct(id, express).match).toBe(true);
    expect(sameProduct(id, pro).match).toBe(false);
    // by GTIN
    expect(sameProduct({ ...id, gtin: "0021614062161" }, pro)).toMatchObject({ match: false, basis: "gtin" });
    // by MPN
    expect(sameProduct({ ...id, mpn: "BES870XL" }, cand({ name: "Barista Pro", brand: "Breville", mpn: "BES878BSS" }))).toMatchObject({
      match: false,
      basis: "mpn",
    });
  });

  it("GTIN mismatch is final even when names are identical", () => {
    const r = sameProduct({ name: "Breville Barista Express", brand: "Breville", gtin: "0021614062161" }, cand({ name: "Breville Barista Express", brand: "Breville", gtin: "9300711000000" }));
    expect(r.match).toBe(false);
  });

  it("matches MPN / model case-, space- and hyphen-insensitively", () => {
    expect(sameProduct({ name: "x", brand: "Sony", mpn: "WH-1000XM5/B" }, cand({ name: "y", brand: "SONY", mpn: "wh1000xm5 b" }))).toMatchObject({
      match: true,
      basis: "mpn",
    });
    expect(sameProduct({ name: "x", brand: "Breville", model: "BES870XL" }, cand({ name: "y", brand: "Breville", model: "bes-870-xl" }))).toMatchObject({
      match: true,
      basis: "model",
    });
    expect(sameProduct({ name: "x", brand: "Breville", model: "BES870XL" }, cand({ name: "y", brand: "Breville", model: "BES878" })).match).toBe(false);
  });

  it("refuses an MPN match when brands conflict", () => {
    expect(sameProduct({ name: "x", brand: "Sony", mpn: "ABC123" }, cand({ name: "x", brand: "Bose", mpn: "ABC123" })).match).toBe(false);
  });

  it("normalises brands: De'Longhi = DeLonghi = De Longhi", () => {
    expect(brandKey("De'Longhi")).toBe("delonghi");
    expect(brandKey("De Longhi")).toBe("delonghi");
    expect(brandKey("DeLonghi S.p.A.")).toBe("delonghi");
    expect(brandKey("Breville Group Limited")).toBe("brevillegroup");
    const r = sameProduct({ name: "Dedica Arte", brand: "DeLonghi" }, cand({ name: "De Longhi Dedica Arte", brand: "De'Longhi" }));
    expect(r).toMatchObject({ match: true, basis: "brand+name" });
  });

  it("rejects different brands with the same product name", () => {
    expect(sameProduct({ name: "Pro 500", brand: "Acme" }, cand({ name: "Pro 500", brand: "Other" })).match).toBe(false);
  });

  it.each([
    "Breville Barista Pro",
    "Breville Bambino Plus",
    "Breville Barista Express Impress",
    "Breville Barista Express 2",
    "Breville Barista Express Gen 2",
    "Breville Barista Express (2024)",
    "Breville Barista Express Refurbished",
    "Breville Barista Express Bundle",
    "Breville Barista Express Mini",
    "Breville Barista Express BES878BSS",
  ])("Barista Express never matches %s", (name) => {
    const r = sameProduct({ name: "Breville Barista Express", brand: "Breville", model: "BES870XL" }, cand({ name, brand: "Breville" }));
    expect(r.match).toBe(false);
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it.each([
    ["iPhone 15", "Apple iPhone 15 Pro"],
    ["iPhone 15 Pro", "Apple iPhone 15"],
    ["iPhone 15 Pro 128GB", "Apple iPhone 15 Pro 256 GB"],
    ["Instant Pot Duo 6 Quart", "Instant Pot Duo 8 Quart"],
    ["Echo Dot 5th Gen", "Echo Dot (4th Generation)"],
    ["Galaxy S24", "Samsung Galaxy S24 Ultra"],
    ["Kindle Paperwhite", "Kindle Paperwhite Signature Edition"],
    ["WH-1000XM5", "Sony WH-1000XM4"],
    ["Keurig K-Mini", "Keurig K-Mini Plus"],
    ["Ninja Creami", "Ninja Creami XL"],
  ])("%s never matches %s", (a, b) => {
    expect(sameProduct({ name: a }, cand({ name: b })).match).toBe(false);
  });

  it.each([
    ["Breville", "Breville Barista Express", "Breville the Barista Express Espresso Machine BES870XL, Brushed Stainless Steel"],
    ["Amazon", "Echo Dot 5th Gen", "Echo Dot (5th Generation) Smart Speaker"],
    ["Apple", "iPhone 15 Pro 256GB", "Apple iPhone 15 Pro 256 GB Black Titanium Unlocked"],
    ["Instant Pot", "Instant Pot Duo 6 Quart", "Instant Pot Duo 6-qt Electric Pressure Cooker"],
  ])("[%s] %s matches %s", (brand, a, b) => {
    const r = sameProduct({ name: a, brand, model: brand === "Breville" ? "BES870XL" : null }, cand({ name: b, brand }));
    expect(r).toMatchObject({ match: true, basis: "brand+name" });
  });

  it("rejects an unexplained extra word rather than guessing", () => {
    expect(sameProduct({ name: "iPhone 15", brand: null }, cand({ name: "Apple iPhone 15" })).match).toBe(false);
  });

  it("matches the Best Buy retailer page to the Barista Express identity", () => {
    const url = "https://www.bestbuy.com/site/breville-the-barista-express-espresso-machine/6366540.p?skuId=6366540";
    const bb = extractProductFromHtml(fixture("retailer-aggregate-offer.html"), url)!;
    const id: ProductIdentity = { name: "Barista Express", brand: "Breville" };
    expect(sameProduct(id, bb)).toMatchObject({ match: true, basis: "brand+name" });
    expect(sameProduct({ ...id, gtin: "0021614062161" }, bb)).toMatchObject({ match: true, basis: "gtin" });
    expect(sameProduct({ name: "Barista Pro", brand: "Breville" }, bb).match).toBe(false);
  });

  it("unknown candidate brand is only OK when the brand and every identity token are in its name", () => {
    expect(sameProduct({ name: "Barista Express", brand: "Breville" }, cand({ name: "Barista Express Espresso Machine" })).match).toBe(false);
    expect(sameProduct({ name: "Barista Express", brand: "Breville" }, cand({ name: "Breville Barista Express" })).match).toBe(true);
    expect(sameProduct({ name: "Dedica", brand: "De'Longhi" }, cand({ name: "De Longhi Dedica" })).match).toBe(true);
  });

  it("does not match a name that is only the brand", () => {
    expect(sameProduct({ name: "Breville", brand: "Breville" }, cand({ name: "Breville Barista Express", brand: "Breville" })).match).toBe(false);
  });

  it("normalizeGtin pads to 14 and rejects junk", () => {
    expect(normalizeGtin("021614062161")).toBe("00021614062161");
    expect(normalizeGtin("0021614062161")).toBe("00021614062161");
    expect(normalizeGtin("12345")).toBeNull();
    expect(normalizeGtin("00000000")).toBeNull();
  });
});

describe("classifySource", () => {
  it("MANUFACTURER only for the brand's own registrable domain", () => {
    expect(classifySource("https://www.breville.com/us/en/products/espresso/bes870.html", "Breville")).toBe("MANUFACTURER");
    expect(classifySource("https://shop.breville.com.au/x", "Breville")).toBe("MANUFACTURER");
    expect(classifySource("https://www.delonghi.com/en-us/p/EC885.M", "De'Longhi")).toBe("MANUFACTURER");
    expect(classifySource("https://www.de-longhi.com/x", "De Longhi")).toBe("MANUFACTURER");
    expect(classifySource("https://store.google.com/product/pixel_9", "Pixel")).toBe("SECONDARY");
    expect(classifySource("https://breville-deals.com/x", "Breville")).toBe("SECONDARY");
    expect(classifySource("https://breville.myshopify.com/x", "Breville")).toBe("SECONDARY");
    expect(classifySource("https://www.breville.com/x", null)).toBe("SECONDARY");
  });

  it("RETAILER for built-in and configured retailers", () => {
    expect(classifySource("https://www.amazon.com/dp/B00CH9QWOU", "Breville")).toBe("RETAILER");
    expect(classifySource("https://www.amazon.co.uk/dp/B00CH9QWOU", "Breville")).toBe("RETAILER");
    expect(classifySource("https://www.bestbuy.com/site/x", "Breville")).toBe("RETAILER");
    expect(classifySource("https://www.currys.co.uk/products/x", "Breville")).toBe("RETAILER");
    expect(classifySource("https://www.williams-sonoma.com/products/x", "Breville")).toBe("RETAILER");
    expect(classifySource("https://www.seattlecoffeegear.com/x", "Breville")).toBe("SECONDARY");
    expect(classifySource("https://www.seattlecoffeegear.com/x", "Breville", { retailers: ["seattlecoffeegear.com"] })).toBe("RETAILER");
  });

  it("REVIEW_SOURCE for configured review hosts, SECONDARY otherwise", () => {
    expect(classifySource("https://www.rtings.com/headphones/reviews/sony/wh-1000xm5", "Sony", { reviewHosts: ["rtings.com"] })).toBe("REVIEW_SOURCE");
    expect(classifySource("https://www.rtings.com/x", "Sony")).toBe("SECONDARY");
    expect(classifySource("not a url", "Sony")).toBe("SECONDARY");
    expect(classifySource("ftp://sony.com/x", "Sony")).toBe("SECONDARY");
  });
});

describe("schema.org ProductGroup (variants)", () => {
  const group = (variants: unknown[]) => ({ "@context": "https://schema.org", "@type": "ProductGroup", name: "Adjustable Bundle", brand: { "@type": "Brand", name: "Casper" }, url: "https://casper.com/products/adjustable-bundle", productGroupID: "123", hasVariant: variants });
  const variant = (size: string, price: number, sku: string) => ({ "@type": "Product", name: `Adjustable Bundle - ${size}`, sku, offers: { "@type": "Offer", price, priceCurrency: "USD", availability: "https://schema.org/InStock" } });
  it("uses the group identity and no price when variant prices differ", () => {
    const p = extractProductFromJsonLd([group([variant("Queen", 1999, "Q1"), variant("King", 2399, "K1")])], "https://casper.com/products/adjustable-bundle", {});
    expect(p).toMatchObject({ name: "Adjustable Bundle", brand: "Casper" });
    expect(p?.price).toBeUndefined();
    expect(p?.sku).toBeUndefined();
  });
  it("keeps a price every variant shares", () => {
    const p = extractProductFromJsonLd([group([variant("Queen", 99, "Q1"), variant("King", 99, "K1")])], "https://casper.com/products/adjustable-bundle", {});
    expect(p).toMatchObject({ name: "Adjustable Bundle", price: 99, currency: "USD" });
  });
  it("a single variant is the product, inheriting the group's brand", () => {
    const p = extractProductFromJsonLd([group([variant("Queen", 1999, "Q1")])], "https://casper.com/products/adjustable-bundle", {});
    expect(p).toMatchObject({ name: "Adjustable Bundle - Queen", brand: "Casper", sku: "Q1", price: 1999 });
  });
});
