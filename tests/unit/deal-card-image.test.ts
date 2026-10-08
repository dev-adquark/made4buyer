import { readFileSync } from "node:fs";
import { createElement } from "react";
import { prerender } from "react-dom/static";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import HomeDealCard from "@/components/home-deal-card";
import { CurrentPriceCard, PriceDropCard } from "@/components/official-deals";
import ReviewCard from "@/components/review-card";
import { categoryCardImage, dealCardImage, storedCardImage, type DealCardImage, type DealCardImageInput, type StoredCardImage } from "@/lib/images/deal-card-image";
import { commerceProductTopic, productTypeTopic, productTypeTopicForQuery, productTypeTopicFromContent } from "@/lib/images/product-type";
import { REPRESENTATIVE_CAPTION } from "@/lib/images/provenance";
import { dealBucket, reviewBucket } from "@/lib/images/slot-counts";
import { enrichImage, relevantImage } from "@/lib/pipeline/images";
import { photoMatchesTopic } from "@/lib/pipeline/image-topics";
import type { CurrentPrice, PriceDrop } from "@/lib/public/deals";
import { startStubServer } from "../../scripts/support/stub-server";
import { withEnv } from "../support/env";

const SAMSUNG = "https://www.samsung.com/us/smartphones/galaxy-s26-ultra/buy/";
const SAMSUNG_IMG = "https://images.samsung.com/us/galaxy-s26-ultra.jpg";
const BESTBUY = "https://www.bestbuy.com/site/galaxy-s26-ultra/6600001.p";
const BESTBUY_IMG = "https://www.bestbuy.com/images/s26-ultra-front.jpg";
const PEXELS = "https://images.pexels.com/photos/123/pexels-photo-123.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=627&w=1200";

const stored = (over: Partial<StoredCardImage> = {}): StoredCardImage => ({
  v: 1,
  kind: "illustrative",
  src: PEXELS,
  alt: "Person holding a smartphone in hand",
  source: "pexels",
  sourceType: "ENRICHMENT_SERVICE",
  sourceUrl: "https://www.pexels.com/photo/123/",
  photoId: "pexels:123",
  query: "smartphone in hand",
  topicKey: "product-type:smartphone",
  topicLabel: "a smartphone",
  imageType: "illustrative-product-type",
  basis: "name",
  productId: "p1",
  productName: "Galaxy S26 Ultra",
  confidence: 0.6,
  observedAt: "2026-10-07T00:00:00.000Z",
  attribution: "Photo by Jane on Pexels",
  attributionUrl: "https://www.pexels.com/photo/123/",
  license: "Pexels License (https://www.pexels.com/license/)",
  ...over,
});

/** Every layer present: each test removes the better ones to reach the next. */
function input(layers: { own?: boolean; official?: boolean; retailer?: boolean; internal?: boolean; pexels?: boolean; onRetailer?: boolean }): DealCardImageInput {
  const onRetailer = layers.onRetailer ?? !layers.own;
  const productImages = [
    ...(layers.own ? [{ src: SAMSUNG_IMG, alt: "Galaxy S26 Ultra", source: "json-ld" }] : []),
    ...(layers.retailer ? [{ src: BESTBUY_IMG, alt: "Galaxy S26 Ultra", source: "json-ld" }] : []),
  ];
  return {
    product: { id: "p1", name: "Galaxy S26 Ultra", canonicalUrl: onRetailer ? BESTBUY : SAMSUNG, identityStatus: "MATCHED", brand: { officialDomain: "samsung.com" }, data: { productImages, ...(layers.pexels ? { cardImage: stored() } : {}) } },
    official: layers.official ? { canonicalUrl: SAMSUNG, brand: { officialDomain: "samsung.com" }, data: { productImages: [{ src: SAMSUNG_IMG, alt: "Galaxy S26 Ultra", source: "json-ld" }] } } : null,
    internal: layers.internal ? { url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Galaxy_S26_Ultra.jpg", imageType: "commons-product", matchConfidence: 0.95, licenseState: "VERIFIED", enrichmentStatus: "ENRICHED", sourceType: "WIKIMEDIA_COMMONS" } : null,
    categories: ["phones"],
  };
}

describe("priority chain: exact official > retailer > internal verified > Pexels illustrative > category", () => {
  it("takes the best layer available, and only the category image when 1–4 found nothing", () => {
    expect(dealCardImage(input({ own: true, onRetailer: false, internal: true, pexels: true }))).toMatchObject({ kind: "official", exact: true, src: SAMSUNG_IMG, caption: null });
    // A retailer page of an identity-matched product: the official page's photo of the same product first.
    expect(dealCardImage(input({ official: true, retailer: true, internal: true, pexels: true }))).toMatchObject({ kind: "official", exact: true, src: SAMSUNG_IMG, sourceUrl: SAMSUNG });
    expect(dealCardImage(input({ retailer: true, internal: true, pexels: true }))).toMatchObject({ kind: "retailer", exact: true, src: BESTBUY_IMG });
    expect(dealCardImage(input({ internal: true, pexels: true }))).toMatchObject({ kind: "internal", exact: true });
    expect(dealCardImage(input({ pexels: true }))).toMatchObject({ kind: "illustrative", exact: false, src: PEXELS, caption: REPRESENTATIVE_CAPTION, alt: "Person holding a smartphone in hand", query: "smartphone in hand", attribution: "Photo by Jane on Pexels" });
    expect(dealCardImage(input({}))).toMatchObject({ kind: "category", exact: false, src: "/placeholders/phones.svg", caption: null });
  });

  it("an internal image counts only when it is a verified, confident photo of the exact product", () => {
    const base = input({ internal: true });
    for (const bad of [{ imageType: "illustrative-product-type" }, { matchConfidence: 0.5 }, { licenseState: "UNVERIFIED" }, { enrichmentStatus: "FAILED" }]) {
      expect(dealCardImage({ ...base, internal: { ...base.internal!, ...bad } }).kind).toBe("category");
    }
  });
});

describe("wrong-image prevention: never another product's photo", () => {
  it("refuses a stored photo chosen for another product or for a type the page no longer states", () => {
    const own = { id: "p1", name: "Galaxy S26 Ultra", data: { cardImage: stored() } };
    expect(storedCardImage(own, ["phones"])).not.toBeNull();
    expect(storedCardImage({ ...own, id: "p2" }, ["phones"])).toBeNull();
    expect(storedCardImage({ ...own, name: "Galaxy Buds 4 Pro earbuds" }, ["phones"])).toBeNull();
    expect(storedCardImage({ ...own, data: { cardImage: stored({ src: "https://evil.example/x.jpg" }) } }, ["phones"])).toBeNull();
    expect(storedCardImage({ ...own, data: { cardImage: stored(), brokenImages: { [PEXELS]: "2026-10-07T00:00:00Z" } } }, ["phones"])).toBeNull();
  });

  it("a retailer page's photo needs an identity match and the retailer's own domain; the official counterpart needs a match too", () => {
    const i = input({ official: true, retailer: true });
    expect(dealCardImage({ ...i, product: { ...i.product, identityStatus: "MATCH_REJECTED" } }).kind).toBe("category");
    const offDomain = input({});
    offDomain.product.data = { productImages: [{ src: "https://cdn.othershop.com/s26.jpg", source: "json-ld" }] };
    expect(dealCardImage(offDomain).kind).toBe("category");
  });

  it("an official photo recorded broken by the integrity job is skipped", () => {
    const i = input({ own: true, onRetailer: false });
    i.product.data = { ...(i.product.data as object), brokenImages: { [SAMSUNG_IMG]: "2026-10-07T00:00:00Z" } };
    expect(dealCardImage(i).kind).toBe("category");
  });
});

describe("Pexels query relevance by product type (never random)", () => {
  it("builds the query from the product's own type: name, page category / breadcrumbs, description, single brand category", () => {
    const t = (x: Parameters<typeof commerceProductTopic>[0]) => commerceProductTopic(x);
    expect(t({ name: "Samsung Galaxy smartphone" })?.topic.queries[0]).toBe("smartphone in hand");
    expect(t({ name: "Galaxy S26 Ultra" })).toMatchObject({ basis: "name", topic: { key: "product-type:smartphone" } });
    expect(t({ name: "EcoTank ET-15000 All-in-One Cartridge-Free Supertank Printer" })?.topic.key).toBe("product-type:printer");
    expect(t({ name: "WorkForce ES-60W Wireless Portable Document Scanner" })?.topic.key).toBe("product-type:scanner");
    expect(t({ name: "Home Cinema 2350 4K PRO-UHD 3-Chip 3LCD Smart Streaming Projector" })?.topic.key).toBe("product-type:projector");
    expect(t({ name: "Backrest Pillow" })?.topic.key).toBe("product-type:pillow");
    expect(t({ name: "Arctis Nova 7 Wireless Gen 2", breadcrumbs: ["Home", "Gaming", "Headsets"] })).toMatchObject({ basis: "page-category", topic: { key: "product-type:headphones" } });
    expect(t({ name: "HD 560S", description: "Open-back audiophile headphones for reference listening at home." })).toMatchObject({ basis: "description", topic: { key: "product-type:headphones" } });
    // Ambiguous prose words never decide ("watch your favourite shows on your phone").
    expect(t({ name: "Zx-9", description: "Watch your shows and take calls on your phone." })).toBeNull();
    expect(t({ name: "Ascent X5", brandCategories: ["kitchen-appliances"] })).toMatchObject({ basis: "category", imageType: "illustrative-category" });
    expect(t({ name: "Arctis Nova Pro", brandCategories: ["accessories", "gaming", "audio"] })).toBeNull();
  });

  it("a photo qualifies only when its own description names the type", () => {
    const phone = productTypeTopic({ productName: "Galaxy S26 Ultra" })!;
    expect(photoMatchesTopic("Person holding a smartphone in hand", phone)).toBe(true);
    expect(photoMatchesTopic("Laptop on a wooden desk", phone)).toBe(false);
    const printer = commerceProductTopic({ name: "Expression Premium XP-6100 Small-in-One Printer" })!.topic;
    expect(photoMatchesTopic("Office printer printing documents", printer)).toBe(true);
    expect(photoMatchesTopic("Coffee cup on a desk", printer)).toBe(false);
  });

  it("a review whose name states no type reads it from its subcategory or its own text; the display guard recovers it from the stored query", () => {
    expect(productTypeTopicFromContent({ subcategorySlug: "flashlights" })?.key).toBe("product-type:flashlight");
    expect(productTypeTopicFromContent({ prose: "The Warrior 3S is a tactical flashlight with a 2300-lumen beam." })?.key).toBe("product-type:flashlight");
    expect(productTypeTopicFromContent({ prose: "Great for watching videos on your phone." })).toBeNull();
    expect(productTypeTopicForQuery("small flashlight")?.key).toBe("product-type:flashlight");
    const asset = { sourceType: "ENRICHMENT_SERVICE", altText: "Small LED flashlight held in hand", searchQuery: "small flashlight" };
    const ctx = { productName: "Warrior 3S", title: "Olight Warrior 3S Review", categorySlug: "tools-diy", singleProduct: true };
    expect(relevantImage(asset, ctx)).not.toBeNull();
    expect(relevantImage({ ...asset, altText: "Power drill on a workbench" }, ctx)).toBeNull();
    expect(relevantImage({ ...asset, searchQuery: null }, ctx)).toBeNull();
  });
});

describe("single-product review heroes: a labelled type photo instead of the placeholder", () => {
  let stub: Awaited<ReturnType<typeof startStubServer>>;
  let restore: () => void;
  beforeAll(async () => {
    stub = await startStubServer({});
    restore = withEnv({ PEXELS_API_KEY: "test-pexels-key", PEXELS_API_BASE_URL: `${stub.base}/pexels/v1`, UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: "true", IMAGE_ENRICHMENT_URL: undefined, IMAGE_REQUIRE_LICENSE: "true" });
  });
  afterAll(async () => {
    restore();
    await stub.close();
  });

  it("the audit's placeholder reviews now get a photo of their type (pouch; type from the review text)", async () => {
    const pouch = await enrichImage({ productName: "Laneway Daily Pouch", brand: "Bellroy", title: "Bellroy Laneway Daily Pouch Review", categorySlug: "luggage-travel", kind: "REVIEW" });
    expect(pouch).toMatchObject({ sourceType: "ENRICHMENT_SERVICE", subject: "ILLUSTRATIVE", imageType: "illustrative-product-type", isFallback: false });
    expect(pouch.searchQuery).toMatch(/pouch|wallet/);
    const olight = await enrichImage({ productName: "Warrior 3S", brand: "Olight", title: "Olight Warrior 3S Review", categorySlug: "tools-diy", kind: "REVIEW", prose: "A tactical flashlight with a 2300-lumen beam." });
    expect(olight).toMatchObject({ subject: "ILLUSTRATIVE", imageType: "illustrative-product-type" });
    expect(olight.searchQuery).toMatch(/flashlight/);
  });
});

// ── Render tests ──────────────────────────────────────────────────────────

const drop = (image: DealCardImage): PriceDrop => ({
  id: "o1",
  productName: "Galaxy S26 Ultra",
  brandName: "Samsung",
  brandSlug: "samsung",
  categories: ["phones"],
  seller: "Samsung",
  official: true,
  label: "Official Samsung store price",
  price: 999,
  listPrice: 1299,
  listPriceLabel: "Regular price",
  currency: "USD",
  priceText: "$999.00",
  listPriceText: "$1,299.00",
  saving: 300,
  savingText: "$300.00",
  savingPercent: 23,
  observedAt: new Date().toISOString(),
  linkCheckedAt: null,
  verified: "Official site (samsung.com)",
  verifiedKind: "official",
  sellerDomain: "samsung.com",
  availability: "In stock",
  validUntil: null,
  url: SAMSUNG,
  affiliated: false,
  source: "samsung.com (official site)",
  review: null,
  image,
});

/** Async render (the brand logo is an async server component). */
async function html(el: React.ReactElement): Promise<string> {
  const { prelude } = await prerender(el);
  return (await new Response(prelude).text()).replace(/<!-- -->/g, "");
}

const illustrative = dealCardImage(input({ pexels: true }));
const exact = dealCardImage(input({ own: true, onRetailer: false }));
const category = categoryCardImage("phones");

describe("render: illustrative label shown, no empty slot on deal and review cards", () => {
  for (const [name, img] of [["illustrative", illustrative], ["exact", exact], ["category", category]] as const) {
    it(`price-drop, current-price and home cards always render an image (${name})`, async () => {
      const d = drop(img);
      const p: CurrentPrice = { id: d.id, productName: d.productName, brandName: d.brandName, brandSlug: d.brandSlug, categories: d.categories, seller: d.seller, official: d.official, label: d.label, price: d.price, currency: d.currency, priceText: d.priceText, observedAt: d.observedAt, linkCheckedAt: d.linkCheckedAt, verified: d.verified, verifiedKind: d.verifiedKind, sellerDomain: d.sellerDomain, availability: d.availability, url: d.url, affiliated: d.affiliated, source: d.source, review: d.review, image: d.image };
      for (const markup of await Promise.all([html(createElement(PriceDropCard, { d })), html(createElement(CurrentPriceCard, { p })), html(createElement(HomeDealCard, { d }))])) {
        expect(markup).toMatch(new RegExp(`<img[^>]+data-image-kind="${img.kind}"`));
        expect(markup).not.toMatch(/no-media|hd-mono/);
        if (name === "illustrative") expect(markup).toContain(REPRESENTATIVE_CAPTION);
        else expect(markup).not.toContain(REPRESENTATIVE_CAPTION);
        expect(markup).not.toMatch(/Illustrative image/);
      }
    });
  }

  it("a review card with a representative photo carries the small note (with its credit), never the old wording", async () => {
    const card = {
      id: "r1",
      slug: "galaxy-s26-ultra-review",
      kind: "REVIEW",
      canonicalTitle: "Galaxy S26 Ultra review",
      productName: "Galaxy S26 Ultra",
      categorySlug: "phones",
      subcategorySlug: null,
      summary: "",
      generationMeta: null,
      entities: null,
      author: null,
      sourcePublishedAt: null,
      publishedAt: new Date(),
      images: [{ sourceType: "ENRICHMENT_SERVICE", sourceUrl: PEXELS, cdnUrl: null, licenseState: "VERIFIED", width: 1200, height: 627, altText: "Person holding a smartphone in hand", enrichmentStatus: "ENRICHED", subject: "ILLUSTRATIVE", searchQuery: "smartphone in hand", imageType: "illustrative-product-type", attribution: "Photo by Jane on Pexels", attributionUrl: "https://www.pexels.com/photo/123/" }],
    };
    const markup = await html(createElement(ReviewCard, { review: card as never }));
    expect(markup).toMatch(/<img[^>]+src="[^"]*pexels/);
    expect(markup).toContain(">Representative photo<");
    expect(markup).toContain('title="Representative photo · Photo by Jane on Pexels"');
    expect(markup).not.toMatch(/Illustrative/);
    // An exact product photo carries no note.
    const exactCard = { ...card, images: [{ ...card.images[0], sourceType: "WIKIMEDIA_COMMONS", sourceUrl: "https://upload.wikimedia.org/wikipedia/commons/a/ab/S26.jpg", subject: "PRODUCT", imageType: "commons-product" }] };
    expect(await html(createElement(ReviewCard, { review: exactCard as never }))).not.toContain("Representative photo");
  });

  it("the review hero's caption, the card chip and the deal note use the one shared wording", () => {
    expect(REPRESENTATIVE_CAPTION).toBe("Representative photo");
    expect(readFileSync("components/review-chrome.tsx", "utf8")).toContain(`REPRESENTATIVE_CAPTION = "${REPRESENTATIVE_CAPTION}"`);
    for (const f of ["components/review-chrome.tsx", "components/review-card.tsx", "components/official-deals.tsx", "components/home-deal-card.tsx", "lib/images/deal-card-image.ts", "lib/public/deals.ts", "lib/images/provenance.ts"]) expect(readFileSync(f, "utf8")).not.toMatch(/Illustrative image — not the/);
  });
});

describe("Admin → Images slot buckets (same as the audit)", () => {
  it("maps deal images and review card images to the audit's classes", () => {
    expect(dealBucket(exact)).toBe("exactOfficial");
    expect(dealBucket(dealCardImage(input({ retailer: true })))).toBe("retailer");
    expect(dealBucket(dealCardImage(input({ internal: true })))).toBe("internal");
    expect(dealBucket(illustrative)).toBe("pexels");
    // The bare category graphic is a missing image; the category's photo standing in is a category fallback.
    expect(dealBucket(category)).toBe("missing");
    expect(dealBucket({ ...category, src: PEXELS, caption: REPRESENTATIVE_CAPTION })).toBe("categoryFallback");
    expect(dealBucket(null)).toBe("missing");
    expect(reviewBucket({ url: "/placeholders/phones.svg", isFallback: true }, null)).toBe("missing");
    expect(reviewBucket({ url: "/placeholders/phones.svg", isFallback: true }, null, true)).toBe("categoryFallback");
    expect(reviewBucket({ url: "https://www.samsung.com/x.jpg", isFallback: false }, { sourceType: "OFFICIAL_SITE", imageType: "official-product" })).toBe("exactOfficial");
    expect(reviewBucket({ url: PEXELS, isFallback: false }, { sourceType: "ENRICHMENT_SERVICE", imageType: "illustrative-product-type" })).toBe("pexels");
    expect(reviewBucket({ url: "https://upload.wikimedia.org/x.jpg", isFallback: false }, { sourceType: "WIKIMEDIA_COMMONS", imageType: "commons-product" })).toBe("internal");
  });
});
