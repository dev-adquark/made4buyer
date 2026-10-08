import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import SafeImg from "@/components/safe-img";
import { firstShowable, imageCandidates, nextImageStep, type ImageStep } from "@/lib/images/delivery";
import { urlNamesProduct } from "@/lib/images/official-product-urls";
import { productTypeTopic } from "@/lib/images/product-type";
import { exactImagesFromProducts, type ExactImageProduct } from "@/lib/images/review-exact-image";
import { photoMatchesTopic, type ImageTopic } from "@/lib/pipeline/image-topics";
import { categoryImageTopic, enrichImage, relevantImage, type ExactProductImage } from "@/lib/pipeline/images";
import { findPexelsImage, MIN_PHOTO_WIDTH, pexelsSearch } from "@/lib/pipeline/pexels";
import type { CommonsImage } from "@/lib/products/commons-image";
import { startStubServer } from "../../scripts/support/stub-server";
import { withEnv } from "../support/env";

// SAMPLE data only: a local stub serves the Pexels API and image files; never the real APIs.
let stub: Awaited<ReturnType<typeof startStubServer>>;
let restore: () => void;
let local: (() => void) | undefined;
beforeAll(async () => {
  stub = await startStubServer({});
  restore = withEnv({ PEXELS_API_KEY: "test-pexels-key", PEXELS_API_BASE_URL: `${stub.base}/pexels/v1`, UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: "true", IMAGE_ENRICHMENT_URL: undefined, IMAGE_REQUIRE_LICENSE: "true" });
});
afterAll(async () => {
  restore();
  await stub.close();
});
afterEach(() => {
  local?.();
  local = undefined;
});

const SLING = { productName: "City Crescent 6L", brand: "Peak Design", title: "Peak Design City Crescent 6L review", categorySlug: "luggage-travel", kind: "REVIEW" } as const;
const official = (url: string): ExactProductImage => ({ url, kind: "official", pageUrl: "https://www.peakdesign.com/products/city-crescent-6l", basis: "commerce-product:shopify-variant", confidence: 1, alt: "City Crescent 6L in Black", publisher: "Peak Design" });
const retailer = (url: string): ExactProductImage => ({ url, kind: "retailer", pageUrl: "https://www.rei.com/product/city-crescent-6l", basis: "retailer-product:json-ld", confidence: 0.855, alt: "City Crescent 6L", publisher: "rei.com" });
const commons = (url: string): CommonsImage => ({ url, license: "CC BY 4.0", attribution: "Jane Doe / Wikimedia Commons, CC BY 4.0", filePageUrl: "https://commons.wikimedia.org/wiki/File:Crescent.jpg", matchBasis: "mpn", matchConfidence: 1, productEntityId: "p1", productName: "City Crescent 6L", observedAt: new Date() });
const ok = (name: string) => `${stub.base}/image/${name}.png`;
const broken = () => `${stub.base}/pexels-img/broken.jpeg`;

/** Every photo id the stub returns for a topic's queries (the "used up" pool), and the on-topic ones in search order. */
async function poolOf(topic: ImageTopic): Promise<{ all: Set<string>; onTopic: string[] }> {
  const all = new Set<string>();
  const onTopic: string[] = [];
  for (const q of topic.queries)
    for (const p of (await pexelsSearch(q, { perPage: 30 })).photos) {
      all.add(`pexels:${p.id}`);
      if (p.width >= MIN_PHOTO_WIDTH && photoMatchesTopic(p.alt, topic) && !onTopic.includes(`pexels:${p.id}`)) onTopic.push(`pexels:${p.id}`);
    }
  return { all, onTopic };
}

describe("priority: exact official > retailer > Commons > Pexels unused > Pexels reused on-topic > category photo", () => {
  it("the brand's own photo of the exact product comes first, with provenance", async () => {
    const d = await enrichImage({ ...SLING, exactImages: [official(ok("official")), retailer(ok("retailer"))], productImages: [commons(ok("commons"))] });
    expect(d).toMatchObject({
      sourceType: "OFFICIAL_SITE",
      imageType: "official-product",
      subject: "PRODUCT",
      sourceUrl: ok("official"),
      sourcePageUrl: "https://www.peakdesign.com/products/city-crescent-6l",
      attributionUrl: "https://www.peakdesign.com/products/city-crescent-6l",
      attribution: "Image: Peak Design",
      altText: "City Crescent 6L in Black",
      matchBasis: "commerce-product:shopify-variant",
      matchConfidence: 1,
      licenseState: "PROVIDER_ASSERTED",
      isFallback: false,
    });
  });

  it("an identity-matched retailer's photo when the official one does not load; then Commons", async () => {
    expect(await enrichImage({ ...SLING, exactImages: [official(broken()), retailer(ok("retailer"))], productImages: [commons(ok("commons"))] })).toMatchObject({ sourceType: "RETAILER_SITE", imageType: "retailer-product", sourceUrl: ok("retailer") });
    expect(await enrichImage({ ...SLING, exactImages: [official(broken())], productImages: [commons(ok("commons"))] })).toMatchObject({ sourceType: "WIKIMEDIA_COMMONS", imageType: "commons-product" });
  });

  it("no exact photo: an unused Pexels photo of the product's type", async () => {
    const d = await enrichImage({ ...SLING });
    expect(d).toMatchObject({ sourceType: "ENRICHMENT_SERVICE", subject: "ILLUSTRATIVE", imageType: "illustrative-product-type", matchBasis: "pexels:product-type" });
    expect(photoMatchesTopic(d.altText ?? "", productTypeTopic(SLING)!)).toBe(true);
  });

  it("the type's pool used up: the least-used on-topic photo is reused, never an off-topic one", async () => {
    const topic = productTypeTopic(SLING)!;
    const { all, onTopic } = await poolOf(topic);
    expect(onTopic.length).toBeGreaterThan(1);
    const least = onTopic[onTopic.length - 1];
    const usage = new Map([...all].map((id) => [id, id === least ? 1 : 4]));
    const d = await enrichImage({ ...SLING, excludePhotoIds: all, photoUsage: usage });
    expect(d).toMatchObject({ sourceType: "ENRICHMENT_SERVICE", imageType: "illustrative-product-type", matchBasis: "pexels:product-type:reused-on-topic", providerPhotoId: least });
    expect(photoMatchesTopic(d.altText ?? "", topic)).toBe(true);
    // Without usage counts: the most relevant (first) on-topic photo.
    expect((await enrichImage({ ...SLING, excludePhotoIds: all })).providerPhotoId).toBe(onTopic[0]);
  });

  it("never reuses another product's own photo: with the type's whole pool barred, the category's photo", async () => {
    const { all } = await poolOf(productTypeTopic(SLING)!);
    const d = await enrichImage({ ...SLING, excludePhotoIds: all, neverReusePhotoIds: all });
    expect(d).toMatchObject({ sourceType: "ENRICHMENT_SERVICE", subject: "ILLUSTRATIVE", imageType: "illustrative-category", matchBasis: "pexels:category" });
    expect(all.has(d.providerPhotoId!)).toBe(false);
    expect(photoMatchesTopic(d.altText ?? "", categoryImageTopic("luggage-travel")!)).toBe(true);
  });

  it("the placeholder graphic only when no photo provider can answer at all", async () => {
    local = withEnv({ PEXELS_API_KEY: undefined });
    expect(await enrichImage({ ...SLING })).toMatchObject({ sourceType: "PLACEHOLDER", imageType: "neutral-category", isFallback: true });
  });

  it("a rate limit is reported to the caller (which keeps the stored image), never papered over", async () => {
    stub.pexels.rateLimited = true;
    try {
      expect(await enrichImage({ ...SLING })).toMatchObject({ sourceType: "PLACEHOLDER", providerStatus: "RATE_LIMITED" });
    } finally {
      stub.pexels.rateLimited = false;
    }
  });
});

describe("Pexels reuse is strictly on-topic", () => {
  it("reuses only photos whose own description names the topic; with reuse off, reports exhaustion", async () => {
    const topic = productTypeTopic({ productName: "Galaxy Z Fold 8 Ultra" })!;
    const { all } = await poolOf(topic);
    const r = await findPexelsImage({ productName: "Galaxy Z Fold 8 Ultra", kind: "PRODUCT_TYPE" }, { topic, exclude: all });
    expect(r.image).toMatchObject({ subject: "ILLUSTRATIVE", reused: true });
    expect(photoMatchesTopic(r.image!.alt, topic)).toBe(true);
    expect(r.image!.alt).not.toMatch(/desk with a coffee|laptop keyboard/);
    expect((await findPexelsImage({ productName: "Galaxy Z Fold 8 Ultra", kind: "PRODUCT_TYPE" }, { topic, exclude: all, allowReuse: false })).image).toBeUndefined();
  });

  it("a category photo stays relevant on a single-product page only while it shows the category topic", () => {
    const ctx = { productName: "City Crescent 6L", title: "City Crescent 6L review", categorySlug: "luggage-travel", singleProduct: true };
    expect(relevantImage({ sourceType: "ENRICHMENT_SERVICE", altText: "Stock photo: suitcase travel", searchQuery: "suitcase travel", imageType: "illustrative-category" }, ctx)).not.toBeNull();
    expect(relevantImage({ sourceType: "ENRICHMENT_SERVICE", altText: "A person working at a desk", searchQuery: "suitcase travel", imageType: "illustrative-category" }, ctx)).toBeNull();
  });
});

describe("exact product photos from the commerce engine (reviews)", () => {
  const base = (over: Partial<ExactImageProduct>): ExactImageProduct => ({
    canonicalUrl: "https://www.peakdesign.com/products/city-crescent-6l",
    name: "City Crescent 6L",
    identityStatus: "MATCHED",
    brand: { officialDomain: "peakdesign.com", name: "Peak Design" },
    data: { productImages: [{ src: "https://www.peakdesign.com/cdn/shop/files/crescent.jpg", alt: "City Crescent 6L", source: "shopify-product" }] },
    ...over,
  });

  it("official on the brand's own domain (even off the deal-card host list), then retailer; never unmatched products", () => {
    const out = exactImagesFromProducts([
      base({ canonicalUrl: "https://www.rei.com/product/1/city-crescent-6l", data: { productImages: [{ src: "https://www.rei.com/media/crescent.jpg", alt: null, source: "json-ld" }] } }),
      base({}),
      base({ identityStatus: "UNMATCHED", canonicalUrl: "https://www.peakdesign.com/products/everyday-sling", data: { productImages: [{ src: "https://www.peakdesign.com/cdn/sling.jpg", source: "json-ld" }] } }),
    ]);
    expect(out.map((x) => [x.kind, x.url])).toEqual([
      ["official", "https://www.peakdesign.com/cdn/shop/files/crescent.jpg"],
      ["retailer", "https://www.rei.com/media/crescent.jpg"],
    ]);
    expect(out[0]).toMatchObject({ basis: "commerce-product:shopify-product", confidence: 1, publisher: "Peak Design", pageUrl: "https://www.peakdesign.com/products/city-crescent-6l" });
  });

  it("rejects off-domain photos, photos marked broken, and an official claim without a brand", () => {
    expect(exactImagesFromProducts([base({ data: { productImages: [{ src: "https://cdn.other.com/crescent.jpg", source: "json-ld" }] } })])).toEqual([]);
    expect(exactImagesFromProducts([base({ data: { productImages: [{ src: "https://www.peakdesign.com/cdn/shop/files/crescent.jpg", source: "json-ld" }], brokenImages: { "https://www.peakdesign.com/cdn/shop/files/crescent.jpg": "2026-10-01" } } })])).toEqual([]);
    // No brand: only the retailer rule applies (the page's own photo, never labelled official).
    expect(exactImagesFromProducts([base({ brand: null })]).map((x) => x.kind)).toEqual(["retailer"]);
  });
});

describe("official product page search (the slug names exactly the product)", () => {
  it("accepts the exact product's page, rejects other models, sizes and accessories", () => {
    expect(urlNamesProduct("https://store.google.com/us/product/pixel_11", "Pixel 11", "Google")).toBe(true);
    expect(urlNamesProduct("https://store.google.com/us/product/pixel_11_pro", "Pixel 11", "Google")).toBe(false);
    expect(urlNamesProduct("https://store.google.com/us/product/pixel_11_case", "Pixel 11", "Google")).toBe(false);
    expect(urlNamesProduct("https://www.samsung.com/us/smartphones/galaxy-z-fold8-ultra/buy/", "Galaxy Z Fold 8 Ultra", "Samsung")).toBe(true);
    expect(urlNamesProduct("https://www.samsung.com/us/smartphones/galaxy-z-fold8/buy/", "Galaxy Z Fold 8 Ultra", "Samsung")).toBe(false);
    expect(urlNamesProduct("https://www.peakdesign.com/products/city-crescent-6l", "City Crescent 6L", "Peak Design")).toBe(true);
    expect(urlNamesProduct("https://www.peakdesign.com/products/city-crescent-10l", "City Crescent 6L", "Peak Design")).toBe(false);
    expect(urlNamesProduct("https://www.coway-usa.com/air-purifiers/airmega-prox", "Airmega ProX", "Coway")).toBe(true);
    expect(urlNamesProduct("https://www.coway-usa.com/air-purifiers/airmega-prox-filter", "Airmega ProX", "Coway")).toBe(false);
    // Too vague to find by slug.
    expect(urlNamesProduct("https://example.com/products/x1", "X1", "Example")).toBe(false);
  });
});

describe("SafeImg: on error, the next relevant candidate before the placeholder", () => {
  it("candidates are the image then each distinct alternate", () => {
    expect(imageCandidates("a", ["b", "a", "", "c"])).toEqual(["a", "b", "c"]);
    expect(imageCandidates("a", undefined)).toEqual(["a"]);
  });

  it("retries the original once (when it can), then moves on; past the last one the placeholder", () => {
    let s: ImageStep = { index: 0, retry: 0 };
    s = nextImageStep(s, 0, true);
    expect(s).toEqual({ index: 0, retry: 1 });
    s = nextImageStep(s, 0, true);
    expect(s).toEqual({ index: 1, retry: 0 });
    s = nextImageStep(s, 1, false);
    expect(s).toEqual({ index: 2, retry: 0 });
    expect(firstShowable(["a", "b"], 2, {})).toBe(-1);
  });

  it("server markup: the first showable candidate; a blocked one is skipped for the alternate; nothing left → placeholder", () => {
    const attr = (h: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(h)?.[1];
    const html = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(SafeImg, { src: "https://images.pexels.com/photos/1/a.jpeg", fallback: "/placeholders/phones.svg", alt: "", width: 640, height: 360, ...props } as Parameters<typeof SafeImg>[0]));
    const first = html({ alternates: ["https://images.pexels.com/photos/2/b.jpeg"] });
    expect(attr(first, "src")).toContain("photos/1/a.jpeg");
    expect(attr(first, "data-candidate")).toBeUndefined();
    // Optimizer on: the brand photo that may not be hotlinked is skipped for the (optimizable) Pexels alternate.
    local = withEnv({ IMAGE_OPTIMIZER: "on" });
    const skipped = html({ src: "https://images.samsung.com/fold8.jpg", allowDirect: false, alternates: ["https://images.pexels.com/photos/2/b.jpeg"] });
    expect(decodeURIComponent(attr(skipped, "src") ?? "")).toContain("photos/2/b.jpeg");
    expect(attr(skipped, "data-candidate")).toBe("alternate");
    const none = html({ src: "https://images.samsung.com/fold8.jpg", allowDirect: false });
    expect(attr(none, "src")).toBe("/placeholders/phones.svg");
    expect(attr(none, "data-delivery")).toBe("placeholder");
  });
});
