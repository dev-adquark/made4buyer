import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { runIngestion } from "@/lib/pipeline/ingest";
import { buildPageRenderModel } from "@/lib/pipeline/render-model";
import { enrichProduct, type FactSummary } from "@/lib/products/enrich";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { startStubServer } from "../../scripts/support/stub-server";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

let stub: Awaited<ReturnType<typeof startStubServer>>;
let restore: () => void;
const body = "The Breville Barista Express is a semi-automatic espresso machine with a built-in conical burr grinder. We pulled shots daily for two weeks to test temperature stability and steam power.";
const productPage = (name: string, mpn: string, price: number) => `<!doctype html><html><head><title>${name}</title>
<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name, brand: { "@type": "Brand", name: "Breville" }, mpn, gtin13: mpn === "BES870XL" ? "0021614062130" : "0021614062888", weight: { "@type": "QuantitativeValue", value: 10.2, unitCode: "KGM" }, offers: { "@type": "Offer", price, priceCurrency: "USD", availability: "https://schema.org/InStock" } })}</script>
</head><body><h1>${name}</h1></body></html>`;

beforeAll(async () => {
  await seedTaxonomy();
  stub = await startStubServer({});
  restore = withEnv({ CONTENT_API_URL: undefined, SOVRN_API_URL: undefined, SOVRN_API_KEY: undefined, AUTO_PUBLISH_ENABLED: undefined });
});
afterAll(async () => {
  restore();
  await stub.close();
});
beforeEach(() => resetDb());

async function reviewedProduct(productUrl: string) {
  await runIngestion({
    trigger: "test",
    source: "apify:example",
    items: [{ id: "bes870", title: "Breville Barista Express review", body, summary: "A capable all-in-one espresso machine.", url: "https://reviews.example.test/reviews/barista-express", productName: "Breville Barista Express", brand: "Breville", category: "Coffee machines", productUrl, publishedAt: new Date(Date.now() - 86_400_000).toISOString(), sourceData: { pros: ["Built-in grinder"], cons: ["Steam wand is slow"] } }],
  });
  const review = await db.normalizedReview.findFirstOrThrow({ where: { sourceId: "bes870" }, include: { contentEntities: true } });
  expect(review.status).toBe("PUBLISHED");
  const primary = review.contentEntities.find((c) => c.role === "PRIMARY");
  expect(primary).toBeTruthy();
  return { review, entityId: primary!.productEntityId };
}

describe("product data enrichment", () => {
  it("enriches field by field from the exact product's page, with provenance, and shows only current values", async () => {
    stub.pages["express"] = productPage("Breville the Barista Express Espresso Machine", "BES870XL", 699.95);
    const { review, entityId } = await reviewedProduct(`${stub.base}/pages/express`);
    const r = await enrichProduct(entityId);
    expect(r.outcomes.some((o) => o.startsWith("MATCHED_"))).toBe(true);

    const facts = await db.productFact.findMany({ where: { productEntityId: entityId } });
    const price = facts.find((f) => f.field === "price" && f.sourceUrl?.includes("/pages/express"));
    expect(price).toMatchObject({ value: 699.95, unit: "USD" });
    expect(price?.matchBasis).toBeTruthy();
    expect(facts.find((f) => f.field === "pros")).toMatchObject({ source: "REVIEW_SOURCE", value: ["Built-in grinder"] });

    const entity = await db.productEntity.findUniqueOrThrow({ where: { id: entityId } });
    const s = entity.factSummary as unknown as FactSummary;
    expect(s.fields.mpn).toMatchObject({ value: "BES870XL" });
    expect(s.fields.price?.status).not.toBe("STALE");
    expect(s.platform).toBe("NOT_APPLICABLE"); // an espresso machine has no platform

    const model = await buildPageRenderModel(review.id);
    expect(model.productData?.fields.price?.value).toBe(699.95);
    expect(model.productData?.fields.mpn?.sourceName).toBeTruthy();
  });

  it("never copies data from a similar but different product", async () => {
    stub.pages["pro"] = productPage("Breville the Barista Pro Espresso Machine", "BES878BSS", 849.95);
    const { entityId } = await reviewedProduct(`${stub.base}/pages/pro`);
    const r = await enrichProduct(entityId);
    expect(r.outcomes.some((o) => o.startsWith("NOT_SAME_PRODUCT"))).toBe(true);
    expect(await db.productFact.count({ where: { productEntityId: entityId, sourceUrl: { contains: "/pages/pro" } } })).toBe(0);
  });

  it("an old price is never shown as current; a failing source does not stop the rest", async () => {
    stub.pages["express"] = productPage("Breville the Barista Express Espresso Machine", "BES870XL", 699.95);
    const { review, entityId } = await reviewedProduct(`${stub.base}/pages/express`);
    await enrichProduct(entityId);
    await db.productFact.updateMany({ where: { productEntityId: entityId, field: { in: ["price", "currency", "availability"] } }, data: { observedAt: new Date(Date.now() - 5 * 86_400_000) } });
    delete stub.pages["express"]; // the page is gone now: refresh fails, other fields stay
    const r = await enrichProduct(entityId);
    expect(r.outcomes.some((o) => o.startsWith("FETCH_404"))).toBe(true);
    const s = (await db.productEntity.findUniqueOrThrow({ where: { id: entityId } })).factSummary as unknown as FactSummary;
    expect(s.fields.price?.status).toBe("STALE");
    expect(s.priceTier).toBeNull();
    expect(s.fields.mpn?.value).toBe("BES870XL");
    expect((await buildPageRenderModel(review.id)).productData?.fields.price).toBeUndefined();
  });
});
