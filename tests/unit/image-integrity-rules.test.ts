import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import SafeImg from "@/components/safe-img";
import { classifyImage, countImages, showsCategoryFallback, type ImageRow } from "@/lib/images/admin-stats";
import { commonsFileTitle, fileTitleMatches, namesSeveralProducts } from "@/lib/images/commons-search";
import { dealImage, extractOfficialProductImages, storedDealImages } from "@/lib/images/deal-image";
import { OFFICIAL_IMAGE_DOMAINS } from "@/lib/images/remote-patterns";
import { registrableDomain } from "@/lib/products/page-extract";

const FOLD_FILE = "File:SAMSUNG_Galaxy_Z_Fold_8_Ultra,_SAMSUNG_Galaxy_Z_Fold_8_&_SAMSUNG_Galaxy_Z_Flip_8.jpg";
const FOLD_URL = "https://upload.wikimedia.org/wikipedia/commons/e/e5/SAMSUNG_Galaxy_Z_Fold_8_Ultra%2C_SAMSUNG_Galaxy_Z_Fold_8_%26_SAMSUNG_Galaxy_Z_Flip_8.jpg";

describe("Commons exact-product rule: a group shot is never one product's photo", () => {
  it("rejects the homepage Galaxy Z Fold 8 Ultra / Fold 8 / Flip 8 file for each of the three products", () => {
    expect(fileTitleMatches(FOLD_FILE, "Galaxy Z Fold 8 Ultra", "Samsung")).toBe(false);
    expect(fileTitleMatches(FOLD_FILE, "Samsung Galaxy Z Fold 8 Ultra", "Samsung")).toBe(false);
    expect(fileTitleMatches(FOLD_FILE, "Galaxy Z Fold 8", "Samsung")).toBe(false);
    expect(fileTitleMatches(FOLD_FILE, "Galaxy Z Flip 8", "Samsung")).toBe(false);
    expect(namesSeveralProducts(FOLD_FILE, "Galaxy Z Fold 8 Ultra", "Samsung")).toBe(true);
  });

  it("reads the file title from the upload URL (original and thumbnail) and the file page", () => {
    expect(commonsFileTitle(FOLD_URL)).toBe("SAMSUNG_Galaxy_Z_Fold_8_Ultra,_SAMSUNG_Galaxy_Z_Fold_8_&_SAMSUNG_Galaxy_Z_Flip_8.jpg");
    expect(commonsFileTitle(FOLD_URL.replace("/commons/e/e5/", "/commons/thumb/e/e5/") + "/960px-x.jpg")).toContain("Z_Flip_8");
    expect(commonsFileTitle("https://commons.wikimedia.org/wiki/File:Sony_WH-1000XM6.jpg")).toBe("File:Sony_WH-1000XM6.jpg");
    expect(commonsFileTitle("https://example.com/a.jpg")).toBeNull();
    expect(namesSeveralProducts(commonsFileTitle(FOLD_URL)!, "Galaxy Z Fold 8 Ultra", "Samsung")).toBe(true);
  });

  it("rejects other list forms naming more than one model", () => {
    expect(fileTitleMatches("File:Samsung Galaxy Z Fold 8 and Z Flip 8.jpg", "Galaxy Z Fold 8", "Samsung")).toBe(false);
    expect(fileTitleMatches("File:Sony WH-1000XM6 vs WH-1000XM5.jpg", "WH-1000XM6", "Sony")).toBe(false);
    expect(fileTitleMatches("File:Apple iPhone 17 Pro and iPhone 17 Pro Max.jpg", "iPhone 17 Pro", "Apple")).toBe(false);
    expect(fileTitleMatches("File:Google Pixel 10 + Pixel Watch 4.jpg", "Pixel 10", "Google")).toBe(false);
  });

  it("rejects a title that has the product's words and number only scattered (live audit: Pixel Fold photo on the Pixel 11 review)", () => {
    expect(fileTitleMatches("File:Google_Pixel_Fold,_shown_in_Shibuya_Stream_11.jpg", "Pixel 11", "Google")).toBe(false);
    expect(fileTitleMatches("File:Google_Pixel_Fold,_shown_in_Shibuya_Stream_11.jpg", "Google Pixel 11", "Google")).toBe(false);
    expect(fileTitleMatches("File:SAMSUNG_Galaxy_Watch_(9).jpg", "Galaxy Watch 9", "Samsung")).toBe(true);
  });

  it("still accepts single-product titles (with views, years and camera file numbers)", () => {
    expect(fileTitleMatches("File:Google Pixel 9 Pro Fold - front.jpg", "Pixel 9 Pro Fold", "Google")).toBe(true);
    expect(fileTitleMatches("File:2025 Sony WH-1000XM6, black.jpg", "WH-1000XM6", "Sony")).toBe(true);
    expect(fileTitleMatches("File:Samsung Galaxy Z Fold 8 Ultra (IMG 1234).jpg", "Galaxy Z Fold 8 Ultra", "Samsung")).toBe(true);
    expect(fileTitleMatches("File:Breville Barista Express with milk jug.jpg", "Barista Express", "Breville")).toBe(true);
  });
});

describe("Admin image buckets", () => {
  const row = (o: Partial<ImageRow>): ImageRow => ({ sourceType: "WIKIMEDIA_COMMONS", imageType: "commons-product", licenseState: "VERIFIED", enrichmentStatus: "ENRICHED", matchConfidence: 1, ...o });

  it("puts each image in exactly one bucket", () => {
    expect(classifyImage(row({}))).toBe("verifiedExact");
    expect(classifyImage(row({ matchConfidence: 0.8 }))).toBe("lowConfidence");
    expect(classifyImage(row({ matchConfidence: null }))).toBe("lowConfidence");
    expect(classifyImage(row({ enrichmentStatus: "FAILED" }))).toBe("failed");
    expect(classifyImage(row({ sourceType: "ENRICHMENT_SERVICE", imageType: "illustrative-product-type", licenseState: "VERIFIED", matchConfidence: null }))).toBe("illustrative");
    expect(classifyImage(row({ sourceType: "PLACEHOLDER", imageType: "neutral-category", licenseState: "OWNED_PLACEHOLDER", enrichmentStatus: "FAILED" }))).toBe("placeholder");
  });

  it("counts missing pages and category fallbacks (failed, or unverified licence withheld)", () => {
    const rows = [row({}), row({ enrichmentStatus: "FAILED" }), row({ sourceType: "CONTENT_API", imageType: "source-product", licenseState: "UNVERIFIED", matchConfidence: null }), row({ sourceType: "PLACEHOLDER", imageType: "neutral-category", licenseState: "OWNED_PLACEHOLDER" })];
    const c = countImages(rows, 6, true);
    expect(c).toMatchObject({ published: 6, missing: 2, verifiedExact: 1, failed: 1, lowConfidence: 1, placeholder: 1, categoryFallback: 2 });
    expect(countImages(rows, 6, false).categoryFallback).toBe(1);
    expect(showsCategoryFallback(row({ sourceType: "PLACEHOLDER", enrichmentStatus: "FAILED" }), true)).toBe(false);
  });
});

describe("dealImage: the official page's own photo of that exact product, else nothing", () => {
  const page = "https://www.samsung.com/us/smartphones/galaxy-z-fold8/";
  const raw = {
    url: page,
    jsonLd: [{ "@type": "Product", name: "Galaxy Z Fold8", image: ["https://images.samsung.com/fold8.jpg", "https://cdn.example-retailer.com/fold8.jpg", "http://www.samsung.com/insecure.jpg", "https://www.samsung.com/logo.svg"] }],
    meta: { "og:image": "https://www.samsung.com/og.jpg" },
  };

  it("keeps only https, on-domain, non-SVG candidates", () => {
    const imgs = extractOfficialProductImages(raw, page);
    expect(imgs.map((i) => i.src)).toEqual(["https://images.samsung.com/fold8.jpg", "https://www.samsung.com/og.jpg"]);
    expect(imgs[0].source).toBe("json-ld");
  });

  it("returns the first stored on-domain image the optimizer may fetch; never a retailer's page or another brand's domain", () => {
    const data = { productImages: extractOfficialProductImages(raw, page) };
    expect(dealImage({ canonicalUrl: page, data, brand: { officialDomain: "www.samsung.com" } })?.src).toBe("https://images.samsung.com/fold8.jpg");
    expect(dealImage({ canonicalUrl: page, data, brand: { officialDomain: "www.apple.com" } })).toBeNull();
    expect(dealImage({ canonicalUrl: "https://www.bestbuy.com/fold8", data })).toBeNull();
    expect(dealImage({ canonicalUrl: page, data: { productImages: [{ src: "https://cdn.other.com/x.jpg", source: "json-ld" }] } })).toBeNull();
    expect(dealImage({ canonicalUrl: page, data: {} })).toBeNull();
    expect(dealImage(null)).toBeNull();
  });

  it("never uses a multi-variant product's main photo for one variant", () => {
    const v = "https://www.samsung.com/us/p/fold8?variant=2";
    const shop = { url: v, shopifyProduct: { featured_image: "https://www.samsung.com/main.jpg", variants: [{ id: 1, featured_image: { src: "https://www.samsung.com/v1.jpg" } }, { id: 2, featured_image: null }] }, meta: { "og:image": "https://www.samsung.com/og.jpg" } };
    expect(extractOfficialProductImages(shop, v)).toEqual([]);
    expect(storedDealImages({ productImages: [{ src: "x", source: "bogus" }, { src: "https://www.samsung.com/a.jpg", source: "og:image" }] })).toHaveLength(1);
  });

  it("every seed brand's official domain is optimizer-allowed (deal photos are never hotlinked)", () => {
    const seed = JSON.parse(readFileSync("data/commerce/brands.seed.json", "utf8")) as Array<{ officialDomain: string }>;
    const missing = seed.map((b) => registrableDomain(b.officialDomain.toLowerCase())).filter((d) => !OFFICIAL_IMAGE_DOMAINS.includes(d));
    expect(missing).toEqual([]);
  });
});

describe("SafeImg markup", () => {
  const prev = process.env.IMAGE_OPTIMIZER;
  afterEach(() => {
    if (prev === undefined) delete process.env.IMAGE_OPTIMIZER;
    else process.env.IMAGE_OPTIMIZER = prev;
  });
  const html = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(SafeImg, { src: FOLD_URL, fallback: "/placeholders/phones.svg", alt: "Galaxy", width: 640, height: 360, ...props } as Parameters<typeof SafeImg>[0]));
  const attr = (h: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(h)?.[1];

  it("optimizer on: same-origin /_next/image srcset, sizes, intrinsic size, lazy by default", () => {
    process.env.IMAGE_OPTIMIZER = "on";
    const h = html({ sizes: "(max-width: 640px) 100vw, 640px" });
    expect(attr(h, "data-delivery")).toBe("optimizer");
    expect(attr(h, "src")).toMatch(/^\/_next\/image\?url=/);
    expect(attr(h, "srcSet") ?? attr(h, "srcset")).toMatch(/\/_next\/image\?url=.* \d+w/);
    expect(attr(h, "sizes")).toBe("(max-width: 640px) 100vw, 640px");
    expect(attr(h, "width")).toBe("640");
    expect(attr(h, "height")).toBe("360");
    expect(attr(h, "loading")).toBe("lazy");
    expect(attr(h, "fetchPriority") ?? attr(h, "fetchpriority")).toBeUndefined();
    expect(attr(h, "alt")).toBe("Galaxy");
  });

  it("priority: eager + fetchpriority=high", () => {
    process.env.IMAGE_OPTIMIZER = "on";
    const h = html({ priority: true });
    expect(attr(h, "loading")).toBe("eager");
    expect(attr(h, "fetchPriority") ?? attr(h, "fetchpriority")).toBe("high");
  });

  it("fetchPriority=high alone (the review hero) is never lazy-loaded", () => {
    const h = html({ fetchPriority: "high" });
    expect(attr(h, "loading")).toBe("eager");
    expect(attr(h, "fetchPriority") ?? attr(h, "fetchpriority")).toBe("high");
  });

  it("optimizer off: the source CDN's own srcset; a deal photo that may not be hotlinked shows the placeholder", () => {
    delete process.env.IMAGE_OPTIMIZER;
    expect(attr(html({}), "data-delivery")).toBe("source-cdn");
    const deal = html({ src: "https://images.samsung.com/fold8.jpg", allowDirect: false });
    expect(attr(deal, "data-delivery")).toBe("placeholder");
    expect(attr(deal, "src")).toBe("/placeholders/phones.svg");
  });

  it("local placeholders are served as is", () => {
    const h = html({ src: "/placeholders/phones.svg" });
    expect(attr(h, "data-delivery")).toBe("local");
    expect(attr(h, "srcSet") ?? attr(h, "srcset")).toBeUndefined();
  });
});
