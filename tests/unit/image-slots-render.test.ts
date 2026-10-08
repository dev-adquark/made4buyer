import { createElement } from "react";
import { prerender } from "react-dom/static";
import { describe, expect, it, vi } from "vitest";
import type { CategoryPhoto } from "@/lib/public/category-images";

// The category's licensed Pexels photo (normally from the daily data cache): SAMPLE data.
const PHOTOS: Record<string, CategoryPhoto> = {
  phones: { url: "https://images.pexels.com/photos/11/p.jpeg?fit=crop&h=1200&w=800", landscape: "https://images.pexels.com/photos/11/p.jpeg?fit=crop&h=627&w=1200", alt: "Person holding a smartphone", photographer: "Jane", photographerUrl: "https://www.pexels.com/@jane", pexelsUrl: "https://www.pexels.com/photo/11/" },
  "luggage-travel": { url: "https://images.pexels.com/photos/12/s.jpeg?fit=crop&h=1200&w=800", landscape: "https://images.pexels.com/photos/12/s.jpeg?fit=crop&h=627&w=1200", alt: "Suitcase at an airport", photographer: "Sam", photographerUrl: "https://www.pexels.com/@sam", pexelsUrl: "https://www.pexels.com/photo/12/" },
};
vi.mock("@/lib/public/category-images", async (orig) => {
  const real = await orig<typeof import("@/lib/public/category-images")>();
  return { ...real, allCategoryPhotos: async () => PHOTOS, categoryFallbackPhoto: async (slug: string | null | undefined) => (slug ? (PHOTOS[slug] ?? null) : null) };
});

const { default: ReviewCard, FeatureStory, ReviewGrid } = await import("@/components/review-card");
const { DealCard } = await import("@/components/deal-ledger");
const { heroImage } = await import("@/lib/images/hero-image");
const { categoryCardImage, dealCardImage } = await import("@/lib/images/deal-card-image");
const { withCategoryPhotos } = await import("@/lib/public/deals");
const { resolveCardImage } = await import("@/lib/public/queries");

async function html(el: React.ReactElement): Promise<string> {
  const { prelude } = await prerender(el);
  return (await new Response(prelude).text()).replace(/<!-- -->/g, "");
}
const imgSrcs = (markup: string) => [...markup.matchAll(/<img[^>]*\ssrc="([^"]*)"/g)].map((m) => decodeURIComponent(m[1].replace(/&amp;/g, "&")));
const noSvg = (markup: string) => {
  const srcs = imgSrcs(markup);
  expect(srcs.length).toBeGreaterThan(0);
  for (const s of srcs) expect(s).not.toMatch(/\/placeholders\/.+\.svg/);
};

const placeholderAsset = { sourceType: "PLACEHOLDER", sourceUrl: "/placeholders/phones.svg", cdnUrl: null, licenseState: "OWNED_PLACEHOLDER", width: 1200, height: 675, altText: null, enrichmentStatus: "FALLBACK", subject: null, searchQuery: null, imageType: "neutral-category", attribution: null, attributionUrl: null };
const card = (over: Record<string, unknown> = {}) =>
  ({
    id: "r1",
    slug: "google-pixel-11-review",
    kind: "REVIEW",
    canonicalTitle: "Google Pixel 11 review",
    productName: "Google Pixel 11",
    brand: "Google",
    brandSlug: "google",
    categorySlug: "phones",
    subcategorySlug: null,
    summary: "",
    generationMeta: null,
    entities: null,
    author: null,
    sourcePublishedAt: null,
    publishedAt: new Date("2026-10-01T00:00:00Z"),
    images: [placeholderAsset],
    ...over,
  }) as never;

describe("no placeholder graphic in any rendered public card or hero when a category photo exists", () => {
  it("review card, feature story and the grids of product / brand hubs show the category photo, noted and credited", async () => {
    for (const el of [createElement(ReviewCard, { review: card() }), createElement(FeatureStory, { review: card() }), createElement(ReviewGrid, { reviews: [card(), card({ id: "r2", slug: "b" })] })]) {
      const markup = await html(el);
      noSvg(markup);
      expect(imgSrcs(markup)[0]).toContain("images.pexels.com/photos/11/");
      expect(markup).toContain(">Representative photo<");
      expect(markup).toContain("Photo by Jane on Pexels");
      expect(markup).not.toMatch(/Illustrative/);
    }
  });

  it("a card with no stored image row at all still shows the category photo", async () => {
    noSvg(await html(createElement(ReviewCard, { review: card({ images: [] }) })));
  });

  it("a stored exact photo stays first, with the category photo as the browser-side alternate; no note", async () => {
    const commons = { ...placeholderAsset, sourceType: "WIKIMEDIA_COMMONS", sourceUrl: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Pixel_11.jpg", licenseState: "VERIFIED", enrichmentStatus: "ENRICHED", subject: "PRODUCT", imageType: "commons-product" };
    const img = await resolveCardImage(card({ images: [commons] }));
    expect(img).toMatchObject({ url: commons.sourceUrl, representative: false, alternates: [PHOTOS.phones.landscape] });
    const markup = await html(createElement(ReviewCard, { review: card({ images: [commons] }) }));
    noSvg(markup);
    expect(markup).not.toContain("Representative photo");
  });

  it("deal ledger cards (category pages) never show the graphic", async () => {
    const row = { offerId: "o1", seller: "Google Store", sellerType: "OFFICIAL", price: 799, currency: "USD", availability: "InStock", observedAt: new Date(), affiliated: false, review: card() };
    noSvg(await html(createElement(DealCard, { d: row as never })));
  });

  it("review hero: the category photo with its credit and the small note when no product image is stored", () => {
    const stored = { url: "/placeholders/phones.svg", alt: "Phones illustration", width: 1200, height: 675, attribution: null, attributionUrl: null, isFallback: true, subject: null } as const;
    expect(heroImage(stored, PHOTOS.phones)).toMatchObject({ url: PHOTOS.phones.landscape, caption: "Photo by Jane on Pexels", captionUrl: PHOTOS.phones.pexelsUrl, representative: true, width: 1200, height: 627, alt: "Person holding a smartphone" });
    // An exact photo: no note, the category photo only as the alternate.
    const exact = { ...stored, url: "https://www.samsung.com/fold8.jpg", isFallback: false, subject: "PRODUCT" as const, attribution: "Image: Samsung" };
    expect(heroImage(exact, PHOTOS.phones)).toMatchObject({ url: exact.url, representative: false, alternates: [PHOTOS.phones.landscape] });
    // Nothing at all (no Pexels): the graphic is the only thing left.
    expect(heroImage(stored, null).url).toBe("/placeholders/phones.svg");
  });

  it("deal / price cards: the category kind gets the category photo (noted, credited); others get it as their alternate", async () => {
    const official = dealCardImage({ product: { id: "p1", name: "Galaxy S26", canonicalUrl: "https://www.samsung.com/us/s26/", identityStatus: "MATCHED", brand: { officialDomain: "samsung.com" }, data: { productImages: [{ src: "https://images.samsung.com/s26.jpg", source: "json-ld" }] } }, categories: ["phones"] });
    const [cat, exact, none] = await withCategoryPhotos([
      { image: categoryCardImage("phones"), categories: ["phones"] },
      { image: official, categories: ["phones"] },
      { image: categoryCardImage("gaming"), categories: ["gaming"] },
    ]);
    expect(cat.image).toMatchObject({ kind: "category", src: PHOTOS.phones.landscape, caption: "Representative photo", attribution: "Photo: Jane / Pexels" });
    expect(exact.image).toMatchObject({ kind: "official", caption: null, alternates: [PHOTOS.phones.landscape] });
    // No category photo exists for this category: the graphic stays (the only case it is allowed).
    expect(none.image.src).toBe("/placeholders/gaming.svg");
  });
});
