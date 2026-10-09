import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { runHeroCorrection } from "@/lib/images/hero-correction";
import { productTypeTopic } from "@/lib/images/product-type";
import { photoMatchesTopic } from "@/lib/pipeline/image-topics";
import { stockPhotoStillRelevant } from "@/lib/pipeline/images";
import { buildPageRenderModel } from "@/lib/pipeline/render-model";
import { cardImage, publishedReviews } from "@/lib/public/queries";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { startStubServer } from "../../scripts/support/stub-server";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

/**
 * Production case (Peak Design City Crescent 6L): a "sling bag" stock photo chosen just before the
 * relevance rule was tightened now fails it. Pages hide it and showed the luggage category photo
 * (a pile of suitcases), and the daily hero correction never picked the page up again. SAMPLE data;
 * a local Pexels stub, never the real API.
 */
let stub: Awaited<ReturnType<typeof startStubServer>>;
let restore: () => void;
beforeAll(async () => {
  await seedTaxonomy();
  stub = await startStubServer({});
  restore = withEnv({ PEXELS_API_KEY: "test-pexels-key", PEXELS_API_BASE_URL: `${stub.base}/pexels/v1`, UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: "true", IMAGE_ENRICHMENT_URL: undefined, IMAGE_REQUIRE_LICENSE: "true", IMAGE_RULES_CHANGED_AT: "2026-10-06T09:45:00Z" });
});
afterAll(async () => {
  restore();
  await stub.close();
});
beforeEach(() => resetDb());

let n = 0;
async function review(productName: string, brand: string, categorySlug: string) {
  n++;
  const r = await db.normalizedReview.create({ data: { source: "t", sourceId: `s${n}`, dedupeKey: `d${n}`, canonicalTitle: `${productName} Review`, slug: `r-${n}`, productName, brand, categorySlug, summary: "s", body: "b", kind: "REVIEW", status: "PUBLISHED", publishedAt: new Date() } });
  const e = await db.productEntity.create({ data: { slug: `e-${n}`, name: productName, matchKey: `k-${n}`, brand } });
  await db.contentEntity.create({ data: { normalizedReviewId: r.id, productEntityId: e.id, role: "PRIMARY", confidence: 0.95, source: "AUTO" } });
  return r;
}
async function plantStock(reviewId: string, photoId: number, altText: string, verifiedAt: Date) {
  return db.imageAsset.create({
    data: { normalizedReviewId: reviewId, sourceType: "ENRICHMENT_SERVICE", sourceUrl: `${stub.base}/pexels-img/${photoId}.jpeg`, licenseState: "VERIFIED", license: "Pexels License (https://www.pexels.com/license/)", attribution: "Photo by Someone on Pexels", enrichmentStatus: "ENRICHED", isFallback: false, isPrimary: true, subject: "ILLUSTRATIVE", imageType: "illustrative-product-type", providerPhotoId: `pexels:${photoId}`, altText, searchQuery: "sling bag", verifiedAt },
  });
}

const SLING = productTypeTopic({ productName: "Peak Design City Crescent 6L" })!;
// Chosen 2026-10-06 09:56 UTC (after IMAGE_RULES_CHANGED_AT), names a backpack before the bag.
const HIDDEN_ALT = "Hiker with a backpack and a small sling bag on a mountain trail";
const CHOSEN_AT = new Date("2026-10-06T09:56:02Z");

describe("a stored stock photo that fails today's relevance rule is replaced (Peak Design City Crescent 6L)", () => {
  it("is hidden by the display guard, so the page falls back to the category photo", async () => {
    const r = await review("Peak Design City Crescent 6L", "Peak Design", "luggage-travel");
    expect(SLING.key).toBe("product-type:sling");
    expect(photoMatchesTopic(HIDDEN_ALT, SLING)).toBe(false);
    expect(stockPhotoStillRelevant(HIDDEN_ALT, { productName: r.productName, title: r.canonicalTitle, categorySlug: r.categorySlug, singleProduct: true, imageType: "illustrative-product-type", searchQuery: "sling bag" })).toBe(false);
    await plantStock(r.id, 39969329, HIDDEN_ALT, CHOSEN_AT);
    expect((await buildPageRenderModel(r.id)).image.isFallback).toBe(true);
  });

  it("hero correction re-selects it and stores an on-topic sling photo; the hero and every card use it", async () => {
    const r = await review("Peak Design City Crescent 6L", "Peak Design", "luggage-travel");
    const hidden = await plantStock(r.id, 39969329, HIDDEN_ALT, CHOSEN_AT);
    const out = await runHeroCorrection("test", { now: Date.parse("2026-10-09T09:55:00Z") });
    expect(out.items.map((i) => i.slug)).toContain(r.slug);
    const now = await db.imageAsset.findFirstOrThrow({ where: { normalizedReviewId: r.id, isPrimary: true } });
    expect(now.id).not.toBe(hidden.id);
    expect(now).toMatchObject({ sourceType: "ENRICHMENT_SERVICE", subject: "ILLUSTRATIVE", imageType: "illustrative-product-type", licenseState: "VERIFIED", isFallback: false });
    expect(photoMatchesTopic(now.altText ?? "", SLING)).toBe(true);
    expect(now.altText).not.toMatch(/suitcase/i);
    // Hero (render model) and the review card (category, brand, search and /reviews grids) show it.
    const m = await buildPageRenderModel(r.id);
    expect(m.image).toMatchObject({ isFallback: false, subject: "ILLUSTRATIVE", alt: now.altText });
    const card = (await publishedReviews(1)).rows.find((x) => x.id === r.id)!;
    expect(cardImage(card)).toMatchObject({ isFallback: false, alt: now.altText });
    // Idempotent: the corrected page is not picked up again.
    const again = await runHeroCorrection("test", { now: Date.parse("2026-10-09T10:30:00Z") });
    expect(again.items.map((i) => i.slug)).not.toContain(r.slug);
  });

  it("leaves a stock photo that still passes the rule untouched (only incorrect placements change)", async () => {
    const r = await review("Peak Design City Crescent 12L", "Peak Design", "luggage-travel");
    const ok = await plantStock(r.id, 10669656, "Fashion-forward outfit featuring a blue blazer and a striking yellow sling bag.", CHOSEN_AT);
    const out = await runHeroCorrection("test", { now: Date.parse("2026-10-09T09:55:00Z") });
    expect(out.items.map((i) => i.slug)).not.toContain(r.slug);
    expect((await db.imageAsset.findFirstOrThrow({ where: { normalizedReviewId: r.id, isPrimary: true } })).id).toBe(ok.id);
  });
});
