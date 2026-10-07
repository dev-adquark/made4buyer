import type { ReactElement } from "react";
import { prerender } from "react-dom/static";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn, revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
  usePathname: () => "/search",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
}));

import { db } from "@/lib/db";
import { runIngestion } from "@/lib/pipeline/ingest";
import { searchGroups, searchProducts } from "@/lib/public/queries";
import { couponMatches, dropMatches, searchCommerce, searchTerms } from "@/lib/public/search";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

/**
 * Search over seeded data (lib/public/search.ts + the product group of lib/public/queries.ts): price
 * drops, coupons and commerce brands come from exactly what /deals shows (an 8-day-old code, a stale
 * offer and a brand with nothing verified never appear); products come from published content.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const body = "The Framework Laptop 13 is a repairable ultraportable with swappable ports, a bright 2.8K display and solid battery life. We tested it for two weeks of daily work and travel.";
let restore: () => void;

beforeAll(async () => {
  await seedTaxonomy();
  restore = withEnv({ CONTENT_API_URL: undefined, AUTO_PUBLISH_ENABLED: undefined, AFFILIATE_PROVIDER: undefined, PRODUCT_PRICE_MAX_AGE_HOURS: undefined, COMMERCE_COUPON_MAX_AGE_DAYS: undefined });
});
afterAll(() => restore());
beforeEach(() => resetDb());

async function html(el: ReactElement | Promise<ReactElement>): Promise<string> {
  const { prelude } = await prerender(await el);
  return (await new Response(prelude).text()).replace(/<!-- -->/g, "");
}
const visibleText = (markup: string) =>
  markup
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

async function seed() {
  // A published review gives a product entity with published content (the "products" group).
  await runIngestion({ trigger: "test", source: "apify:example", items: [{ id: "fw13", title: "Framework Laptop 13 review", body, summary: "A repairable laptop that is easy to upgrade.", url: "https://reviews.example.test/reviews/fw13", productName: "Framework Laptop 13", brand: "Framework", category: "laptops", publishedAt: new Date(Date.now() - DAY).toISOString() }] });
  const review = await db.normalizedReview.findFirstOrThrow({ where: { sourceId: "fw13" } });
  expect(review.status).toBe("PUBLISHED");
  const primary = await db.contentEntity.findFirstOrThrow({ where: { normalizedReviewId: review.id, role: "PRIMARY" } });

  const framework = await db.commerceBrand.create({ data: { name: "Framework", slug: "framework", officialDomain: "frame.work", categories: ["laptops"], priority: 1 } });
  const product = (slug: string, name: string, sku: string, listPrice: number | null, entityId: string | null = null) =>
    db.commerceProduct.create({ data: { canonicalUrl: `https://frame.work/products/${slug}`, name, sku, model: sku, brandId: framework.id, productEntityId: entityId, identityStatus: entityId ? "MATCHED" : "UNMATCHED", observedAt: new Date(), data: { offers: [{ type: "Offer", price: 799, ...(listPrice ? { listPrice, listPriceType: "ListPrice" } : {}), priceCurrency: "USD", url: `https://frame.work/products/${slug}` }] } } });
  const offer = (productId: string, url: string, over: Record<string, unknown>) =>
    db.commerceOffer.create({ data: { productId, seller: "Framework", sellerType: "MANUFACTURER", destinationUrl: url, price: 799, currency: "USD", availability: "InStock", observedAt: new Date(Date.now() - HOUR), linkStatus: "OK", ...over } });

  const fw13 = await product("laptop13", "Framework Laptop 13", "FRA-L13", 999, primary.productEntityId);
  await offer(fw13.id, fw13.canonicalUrl, { price: 799, listPrice: 999 });
  const desk = await product("desktop", "Framework Desktop", "FRA-DT", 1299);
  await offer(desk.id, desk.canonicalUrl, { price: 1099, listPrice: 1299, observedAt: new Date(Date.now() - 72 * HOUR) });
  const l16 = await product("laptop16", "Framework Laptop 16", "FRA-L16", null);
  await offer(l16.id, l16.canonicalUrl, { price: 1399, listPrice: null });

  await db.commerceCoupon.create({ data: { brandId: framework.id, merchant: "Framework", code: "SAVE10", discount: "10% off laptops", sourceUrl: "https://frame.work/promotions", status: "VERIFIED", observedAt: new Date(), lastVerifiedAt: new Date(Date.now() - 2 * DAY) } });
  await db.commerceCoupon.create({ data: { brandId: framework.id, merchant: "Framework", code: "OLDWEEK8", discount: "30% off everything", sourceUrl: "https://frame.work/old-offers", status: "VERIFIED", observedAt: new Date(Date.now() - 8 * DAY), lastVerifiedAt: new Date(Date.now() - 8 * DAY) } });
  await db.commerceCoupon.create({ data: { brandId: framework.id, merchant: "Framework", code: "THIRDPARTY", discount: "50% off", sourceUrl: "https://www.retailmenot.com/view/frame.work", status: "VERIFIED", observedAt: new Date(), lastVerifiedAt: new Date(Date.now() - HOUR) } });

  // A brand that matches by name but has nothing verified: never listed.
  const empty = await db.commerceBrand.create({ data: { name: "Framework Audio", slug: "framework-audio", officialDomain: "frameworkaudio.com", categories: ["audio"], priority: 2 } });
  await db.commerceCoupon.create({ data: { brandId: empty.id, merchant: "Framework Audio", code: "AUDIOOLD", sourceUrl: "https://frameworkaudio.com/offers", status: "UNVERIFIED", observedAt: new Date() } });
  return { review, entityId: primary.productEntityId };
}

describe("searchCommerce: deals, coupons and brands from seeded data", () => {
  it("a brand query returns its price drop, its public code and the brand (with counts), nothing hidden", async () => {
    await seed();
    const r = await searchCommerce("framework");
    expect(r.drops.map((d) => d.productName)).toEqual(["Framework Laptop 13"]);
    expect(r.dropCount).toBe(1);
    expect(r.drops[0]).toMatchObject({ price: 799, listPrice: 999, saving: 200, savingPercent: 20, official: true });
    expect(r.coupons.map((c) => c.code)).toEqual(["SAVE10"]);
    expect(r.couponCount).toBe(1);
    expect(r.brands).toEqual([{ name: "Framework", slug: "framework", href: "/deals?brand=framework", drops: 1, coupons: 1, prices: 1 }]);
    const json = JSON.stringify(r);
    for (const hidden of ["OLDWEEK8", "THIRDPARTY", "AUDIOOLD", "Framework Desktop", "Framework Audio"]) expect(json).not.toContain(hidden);
  });

  it("a product query finds the drop (all terms must match) but not the brand's coupons", async () => {
    await seed();
    const r = await searchCommerce("laptop 13");
    expect(r.drops.map((d) => d.productName)).toEqual(["Framework Laptop 13"]);
    expect(r.coupons).toEqual([]);
    expect(r.brands).toEqual([]);
    expect((await searchCommerce("laptop 99")).drops).toEqual([]);
    // The stale offer is not a deal, so it cannot be found as one.
    expect((await searchCommerce("framework desktop")).drops).toEqual([]);
  });

  it("no match, a one-letter query or an empty database returns empty lists", async () => {
    await seed();
    expect(await searchCommerce("dyson")).toEqual({ drops: [], dropCount: 0, coupons: [], couponCount: 0, brands: [] });
    expect(await searchCommerce("f")).toEqual({ drops: [], dropCount: 0, coupons: [], couponCount: 0, brands: [] });
    await resetDb();
    expect(await searchCommerce("framework")).toEqual({ drops: [], dropCount: 0, coupons: [], couponCount: 0, brands: [] });
  });

  it("matching helpers: terms, drop and coupon matching", () => {
    expect(searchTerms("  Framework   Laptop-13!! a ")).toEqual(["framework", "laptop-13"]);
    expect(dropMatches({ productName: "Framework Laptop 13", brandName: "Framework", seller: "Framework" }, ["laptop", "13"])).toBe(true);
    expect(dropMatches({ productName: "Framework Laptop 13", brandName: "Framework", seller: "Framework" }, ["laptop", "16"])).toBe(false);
    expect(dropMatches({ productName: "x", brandName: null, seller: "y" }, [])).toBe(false);
    expect(couponMatches({ brandName: "Breville", brandSlug: "breville" }, "breville espresso", ["breville", "espresso"])).toBe(true);
    expect(couponMatches({ brandName: "Breville", brandSlug: "breville" }, "espresso", ["espresso"])).toBe(false);
    // Short terms do not match brand words by themselves.
    expect(couponMatches({ brandName: "LG Electronics", brandSlug: "lg" }, "lg tv", ["lg", "tv"])).toBe(false);
    expect(couponMatches({ brandName: "LG Electronics", brandSlug: "lg" }, "lg", ["lg"])).toBe(true);
  });
});

describe("search products and the search page", () => {
  it("products with published content are found by name and brand", async () => {
    const { entityId } = await seed();
    const byName = await searchProducts("laptop 13");
    expect(byName.map((p) => p.name)).toContain("Framework Laptop 13");
    const groups = await searchGroups("Framework");
    expect(groups.products.length).toBeGreaterThan(0);
    const entity = await db.productEntity.findUniqueOrThrow({ where: { id: entityId } });
    expect(groups.products).toContainEqual({ name: entity.name, href: `/product/${entity.slug}`, count: 1 });
    expect(groups.reviews.map((r) => r.productName)).toContain("Framework Laptop 13");
    expect(await searchProducts("dyson")).toEqual([]);
  });

  it("the rendered /search page lists the drop, the public code, the brand's deals and the product", async () => {
    await seed();
    const { default: SearchPage } = await import("@/app/search/page");
    const markup = await html(SearchPage({ searchParams: Promise.resolve({ q: "framework" }) }));
    const text = visibleText(markup);
    expect(text).toContain("Framework Laptop 13");
    expect(text).toContain("SAVE10");
    expect(text).toContain("Framework deals");
    expect(markup).toContain('href="/deals?brand=framework"');
    for (const hidden of ["OLDWEEK8", "THIRDPARTY", "AUDIOOLD", "Framework Desktop"]) expect(text).not.toContain(hidden);
  });
});
