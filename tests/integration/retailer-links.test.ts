import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { runIngestion } from "@/lib/pipeline/ingest";
import { buildPageRenderModel, persistPageRenderModel, RENDER_MODEL_VERSION } from "@/lib/pipeline/render-model";
import { loadRetailerLinks } from "@/lib/public/retailer-links";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

let restore: () => void;
const recent = () => new Date(Date.now() - 86_400_000).toISOString();
const body = "The Framework Laptop 13 is a repairable ultraportable with swappable ports, a bright 2.8K display and solid battery life. We tested it for two weeks of daily work and travel.";

beforeAll(async () => {
  await seedTaxonomy();
  restore = withEnv({ CONTENT_API_URL: undefined, AUTO_PUBLISH_ENABLED: undefined });
});
afterAll(() => restore());
beforeEach(async () => {
  await resetDb();
});

async function publishedReview(sourceProductUrl: string | null) {
  await runIngestion({ trigger: "test", source: "apify:example", items: [{ id: "fw13", title: "Framework Laptop 13 review", body, summary: "A repairable laptop that is easy to upgrade.", url: "https://reviews.example.test/reviews/fw13", productName: "Framework Laptop 13", brand: "Framework", category: "laptops", publishedAt: recent() }] });
  const r = await db.normalizedReview.findFirstOrThrow({ where: { sourceId: "fw13" } });
  expect(r.status).toBe("PUBLISHED");
  return db.normalizedReview.update({ where: { id: r.id }, data: { sourceProductUrl } });
}

describe("Where-to-buy links in the page render model", () => {
  it("a published review with a source product URL gets a direct, cleaned retailer link; the stored model carries it", async () => {
    const review = await publishedReview("https://shop.retailer.test/p/fw13?utm_source=news&color=black");
    const model = await buildPageRenderModel(review.id);
    expect(model.retailerLinks).toEqual([{ url: "https://shop.retailer.test/p/fw13?color=black", label: "View at retailer.test", merchant: "retailer.test", kind: "retailer" }]);
    // No price: without commerce-engine data there are no offers.
    expect(model.offers).toEqual([]);

    await persistPageRenderModel(review.id);
    const stored = await db.pageRenderModel.findUniqueOrThrow({ where: { normalizedReviewId: review.id } });
    expect(stored.version).toBe(RENDER_MODEL_VERSION);
    expect((stored.model as { retailerLinks?: unknown[] }).retailerLinks).toHaveLength(1);
  });

  it("the publisher's own domain is never linked", async () => {
    const review = await publishedReview("https://reviews.example.test/go/fw13");
    expect((await buildPageRenderModel(review.id)).retailerLinks).toEqual([]);
  });

  it("an unpublished review gets no links", async () => {
    const review = await publishedReview("https://shop.retailer.test/p/fw13");
    await db.normalizedReview.update({ where: { id: review.id }, data: { status: "UNPUBLISHED" } });
    expect(await loadRetailerLinks(review.id)).toEqual([]);
    expect((await buildPageRenderModel(review.id)).retailerLinks).toEqual([]);
  });

  it("uses the primary product's official URL fact, first", async () => {
    const review = await publishedReview("https://shop.retailer.test/p/fw13");
    const primary = await db.contentEntity.findFirstOrThrow({ where: { normalizedReviewId: review.id, role: "PRIMARY" } });
    await db.productFact.create({ data: { productEntityId: primary.productEntityId, field: "officialUrl", value: "https://frame.work/products/laptop13", source: "MANUFACTURER", sourceName: "Framework", sourceKey: "https://frame.work/products/laptop13", sourceUrl: "https://frame.work/products/laptop13", observedAt: new Date(), matchBasis: "test" } });
    const links = (await buildPageRenderModel(review.id)).retailerLinks ?? [];
    expect(links.map((l) => [l.kind, l.label])).toEqual([
      ["official", "Official site"],
      ["retailer", "View at retailer.test"],
    ]);
  });
});
