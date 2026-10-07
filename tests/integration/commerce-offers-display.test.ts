import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as goRedirect } from "@/app/go/[id]/route";
import { db } from "@/lib/db";
import { runIngestion } from "@/lib/pipeline/ingest";
import { buildPageRenderModel } from "@/lib/pipeline/render-model";
import { runOfferStage } from "@/lib/pipeline/stages";
import { freshOffersForReview, publishedFreshOffers } from "@/lib/public/offers";
import { freshDealRows } from "@/lib/public/queries";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

/**
 * Public display reads only the commerce engine: fresh CommerceOffers of the review's PRIMARY
 * product. Stale prices are never shown, /go redirects only to stored offers, and links stay
 * plain while no affiliate provider is configured.
 */

let restore: () => void;
const HOUR = 3_600_000;
const body = "The Framework Laptop 13 is a repairable ultraportable with swappable ports, a bright 2.8K display and solid battery life. We tested it for two weeks of daily work and travel.";

beforeAll(async () => {
  await seedTaxonomy();
  restore = withEnv({ CONTENT_API_URL: undefined, AUTO_PUBLISH_ENABLED: undefined, AFFILIATE_PROVIDER: undefined, PRODUCT_PRICE_MAX_AGE_HOURS: undefined });
});
afterAll(() => restore());
beforeEach(() => resetDb());

async function publishedReviewWithProduct() {
  await runIngestion({ trigger: "test", source: "apify:example", items: [{ id: "fw13", title: "Framework Laptop 13 review", body, summary: "A repairable laptop that is easy to upgrade.", url: "https://reviews.example.test/reviews/fw13", productName: "Framework Laptop 13", brand: "Framework", category: "laptops", publishedAt: new Date(Date.now() - 86_400_000).toISOString() }] });
  const review = await db.normalizedReview.findFirstOrThrow({ where: { sourceId: "fw13" } });
  expect(review.status).toBe("PUBLISHED");
  const primary = await db.contentEntity.findFirstOrThrow({ where: { normalizedReviewId: review.id, role: "PRIMARY" } });
  const product = await db.commerceProduct.create({ data: { canonicalUrl: "https://frame.work/products/laptop13", name: "Framework Laptop 13", productEntityId: primary.productEntityId, identityStatus: "MATCHED", observedAt: new Date() } });
  return { review, product };
}

const offer = (productId: string, over: Record<string, unknown>) =>
  db.commerceOffer.create({ data: { productId, seller: "Framework", sellerType: "MANUFACTURER", destinationUrl: "https://frame.work/products/laptop13", price: 999, currency: "USD", availability: "InStock", observedAt: new Date(Date.now() - HOUR), ...over } });

describe("commerce offers on public pages", () => {
  it("shows a fresh price with a plain link; a stale price is never shown", async () => {
    const { review, product } = await publishedReviewWithProduct();
    const fresh = await offer(product.id, {});
    // Status FRESH but observed 72 h ago (window 48 h): never shown.
    await offer(product.id, { seller: "Retailer", sellerType: "RETAILER", destinationUrl: "https://shop.retailer.test/p/fw13", price: 899, observedAt: new Date(Date.now() - 72 * HOUR) });
    // Marked STALE by the engine: never shown.
    await offer(product.id, { seller: "Other", sellerType: "RETAILER", destinationUrl: "https://other.test/p/fw13", price: 799, status: "STALE" });

    const offers = await freshOffersForReview(review.id);
    expect(offers).toEqual([expect.objectContaining({ id: fresh.id, seller: "Framework", price: 999, currency: "USD", url: "https://frame.work/products/laptop13", affiliated: false })]);

    const model = await buildPageRenderModel(review.id);
    expect(model.offers.map((o) => o.price)).toEqual([999]);
    const json = JSON.stringify(model);
    expect(json).not.toMatch(/"price":\s*899\b/);
    // Match the price as a value, not any "799" (timestamps such as ".799Z" contain it).
    expect(json).not.toMatch(/"price":\s*799\b|other\.test/);
    expect(json).not.toMatch(/sovrn|viglink|vglnk/i);

    expect(await runOfferStage(review.id)).toMatchObject({ status: "MATCHED", offers: 1 });
    const rows = await freshDealRows();
    expect(rows).toEqual([expect.objectContaining({ offerId: fresh.id, seller: "Framework", price: 999, affiliated: false })]);
  });

  it("drops the price once the observation ages out, and the deal status says so", async () => {
    const { review, product } = await publishedReviewWithProduct();
    await offer(product.id, { observedAt: new Date(Date.now() - 49 * HOUR) });
    expect(await freshOffersForReview(review.id)).toEqual([]);
    expect((await buildPageRenderModel(review.id)).offers).toEqual([]);
    expect(await publishedFreshOffers()).toEqual([]);
    expect(await runOfferStage(review.id)).toMatchObject({ status: "STALE" });
    const r = await db.normalizedReview.findUniqueOrThrow({ where: { id: review.id } });
    expect(r.dealStatusReason).toMatch(/commerce engine/);
  });

  it("without any commerce data the deal status is UNAVAILABLE (no provider call, no failure)", async () => {
    await runIngestion({ trigger: "test", source: "apify:example", items: [{ id: "fw13", title: "Framework Laptop 13 review", body, summary: "A repairable laptop that is easy to upgrade.", url: "https://reviews.example.test/reviews/fw13", productName: "Framework Laptop 13", brand: "Framework", category: "laptops", publishedAt: new Date(Date.now() - 86_400_000).toISOString() }] });
    const review = await db.normalizedReview.findFirstOrThrow({ where: { sourceId: "fw13" } });
    expect(review.dealStatus).toBe("UNAVAILABLE");
    expect(review.dealStatusReason).toMatch(/commerce engine/);
    expect(await db.pipelineFailure.count({ where: { stage: "OFFER_MATCHING", resolvedAt: null } })).toBe(0);
  });

  it("de-duplicates where-to-buy links against offers by domain", async () => {
    const { review, product } = await publishedReviewWithProduct();
    await db.normalizedReview.update({ where: { id: review.id }, data: { sourceProductUrl: "https://frame.work/products/laptop13?utm_source=x" } });
    expect((await buildPageRenderModel(review.id)).retailerLinks).toHaveLength(1);
    await offer(product.id, {});
    const model = await buildPageRenderModel(review.id);
    expect(model.offers).toHaveLength(1);
    expect(model.retailerLinks).toEqual([]);
  });
});

describe("/go/[id] redirects only to stored commerce offers", () => {
  const go = (id: string) => goRedirect(new Request(`http://localhost/go/${id}`), { params: Promise.resolve({ id }) });

  it("redirects a FRESH or STALE offer of a published review to its stored URL, nothing else", async () => {
    const { review, product } = await publishedReviewWithProduct();
    const fresh = await offer(product.id, {});
    const stale = await offer(product.id, { destinationUrl: "https://shop.retailer.test/p/fw13", status: "STALE", observedAt: new Date(Date.now() - 200 * HOUR) });
    const removed = await offer(product.id, { destinationUrl: "https://gone.test/p/fw13", status: "REMOVED" });

    const r1 = await go(fresh.id);
    expect(r1.status).toBe(302);
    expect(r1.headers.get("location")).toBe("https://frame.work/products/laptop13");
    expect((await go(stale.id)).headers.get("location")).toBe("https://shop.retailer.test/p/fw13");
    expect((await go(removed.id)).headers.get("location")).toBe("http://localhost/");
    expect((await go("notarealidentifier1")).headers.get("location")).toBe("http://localhost/");
    expect((await go("bad id!")).headers.get("location")).toBe("http://localhost/");

    // An offer of a product whose review is not published never leaves the site.
    await db.normalizedReview.update({ where: { id: review.id }, data: { status: "UNPUBLISHED" } });
    expect((await go(fresh.id)).headers.get("location")).toBe("http://localhost/");
  });

  it("never redirects to an unsafe stored URL", async () => {
    const { product } = await publishedReviewWithProduct();
    const bad = await offer(product.id, { destinationUrl: "javascript:alert(1)" });
    expect((await go(bad.id)).headers.get("location")).not.toMatch(/^javascript:/);
  });

  it("uses a provider affiliate URL only when one is stored", async () => {
    const { product } = await publishedReviewWithProduct();
    const a = await offer(product.id, { affiliateUrl: "https://aff.example.test/r?u=fw13", affiliateStatus: "AFFILIATED", affiliateProvider: "test" });
    expect((await go(a.id)).headers.get("location")).toBe("https://aff.example.test/r?u=fw13");
    const [pub] = (await publishedFreshOffers()).filter((o) => o.id === a.id);
    expect(pub).toMatchObject({ affiliated: true, url: "https://aff.example.test/r?u=fw13" });
  });
});
