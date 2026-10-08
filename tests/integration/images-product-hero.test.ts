import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { runImageBackfillWithCorrection } from "@/lib/images/hero-correction";
import { runJob } from "@/lib/jobs/registry";
import { buildPageRenderModel } from "@/lib/pipeline/render-model";
import { runIngestion } from "@/lib/pipeline/ingest";
import { loadSourceContent, runImageStage } from "@/lib/pipeline/stages";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { startStubServer } from "../../scripts/support/stub-server";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

// SAMPLE data only: local stubs for the Content API, Pexels and image files; never real APIs.
// Commons file URLs point at the loopback stub (allowed in tests only).
let stub: Awaited<ReturnType<typeof startStubServer>>;
let restore: () => void;
beforeAll(async () => {
  await seedTaxonomy();
  stub = await startStubServer({});
  restore = withEnv({
    PEXELS_API_KEY: "test-pexels-key",
    PEXELS_API_BASE_URL: `${stub.base}/pexels/v1`,
    UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: "true",
    IMAGE_ENRICHMENT_URL: undefined,
    IMAGE_REQUIRE_LICENSE: "true",
    CONTENT_API_IMAGES_LICENSED: undefined,
    });
});
afterAll(async () => {
  restore();
  await stub.close();
});
beforeEach(async () => {
  await resetDb();
  const restoreContent = withEnv({ CONTENT_API_URL: `${stub.base}/content`, CONTENT_API_SOURCE_NAME: "sample-fixture" });
  await runIngestion({ trigger: "test" });
  restoreContent();
});

const FILE_PAGE = "https://commons.wikimedia.org/wiki/File:Sony_WH-1000XM6.jpg";

/** The Sony review and its PRIMARY product (SAMPLE fixture). */
async function sonyReview() {
  const review = await db.normalizedReview.findFirstOrThrow({ where: { productName: { contains: "WH-1000XM6" } } });
  const link = await db.contentEntity.findFirstOrThrow({ where: { normalizedReviewId: review.id, role: "PRIMARY" } });
  return { review, productEntityId: link.productEntityId };
}

async function addImageFact(productEntityId: string, over: { value?: string; unit?: string | null; matchBasis?: string; source?: string } = {}) {
  const value = over.value ?? `${stub.base}/image/sony-wh-1000xm6.png`;
  await db.productFact.create({
    data: { productEntityId, field: "image", value, unit: over.unit === undefined ? "CC BY-SA 4.0" : over.unit, source: over.source ?? "WIKIDATA", sourceName: "Jane Doe", sourceKey: value, sourceUrl: FILE_PAGE, observedAt: new Date(), matchBasis: over.matchBasis ?? "gtin" },
  });
}

async function primaryImage(reviewId: string) {
  return db.imageAsset.findFirstOrThrow({ where: { normalizedReviewId: reviewId, isPrimary: true } });
}

/** A legacy keyword stock photo stored as the hero (what production has today). */
async function plantPexelsHero(reviewId: string, photoId: number, subject: "PRODUCT" | "ILLUSTRATIVE") {
  await db.imageAsset.updateMany({ where: { normalizedReviewId: reviewId, isPrimary: true }, data: { isPrimary: false } });
  return db.imageAsset.create({
    data: {
      normalizedReviewId: reviewId,
      sourceType: "ENRICHMENT_SERVICE",
      sourceUrl: `${stub.base}/pexels-img/${photoId}.jpeg`,
      licenseState: "VERIFIED",
      license: "Pexels License (https://www.pexels.com/license/)",
      attribution: "Photo by Someone on Pexels",
      attributionUrl: `https://www.pexels.com/photo/stub-${photoId}/`,
      enrichmentStatus: "ENRICHED",
      isFallback: false,
      isPrimary: true,
      subject,
      providerPhotoId: `pexels:${photoId}`,
      altText: subject === "PRODUCT" ? "Sony WH-1000XM6 headphones on a wooden table" : "Street market with luggage",
    },
  });
}

describe("single-product review hero", () => {
  it("uses the licensed exact-product photo from a Wikidata image fact, with provenance", async () => {
    const { review, productEntityId } = await sonyReview();
    await addImageFact(productEntityId);
    const asset = await runImageStage(review, await loadSourceContent(review));
    expect(asset).toMatchObject({
      sourceType: "WIKIMEDIA_COMMONS",
      licenseState: "VERIFIED",
      license: "CC BY-SA 4.0",
      attribution: "Jane Doe / Wikimedia Commons, CC BY-SA 4.0",
      attributionUrl: FILE_PAGE,
      sourcePageUrl: FILE_PAGE,
      imageType: "commons-product",
      matchConfidence: 1,
      subject: "PRODUCT",
      isFallback: false,
      isPrimary: true,
    });
    expect(asset?.verifiedAt).toBeInstanceOf(Date);
    const m = await buildPageRenderModel(review.id);
    expect(m.image).toMatchObject({ isFallback: false, subject: "PRODUCT", attribution: "Jane Doe / Wikimedia Commons, CC BY-SA 4.0", attributionUrl: FILE_PAGE });
  });

  it("single-product reviews get a labelled photo of their product type, never a product-matched stock photo", async () => {
    const reviews = await db.normalizedReview.findMany({ where: { kind: "REVIEW" } });
    expect(reviews.length).toBeGreaterThan(0);
    for (const r of reviews) await runImageStage(r, await loadSourceContent(r));
    const heroes = await db.imageAsset.findMany({ where: { isPrimary: true, review: { kind: "REVIEW" } } });
    for (const h of heroes.filter((x) => x.sourceType === "ENRICHMENT_SERVICE")) expect(h).toMatchObject({ subject: "ILLUSTRATIVE", imageType: "illustrative-product-type" });
    const { review } = await sonyReview();
    const hero = await primaryImage(review.id);
    // The stub's "Sony WH-1000XM6 headphones" photo matches the product by name: never used as the product.
    expect(hero.subject).not.toBe("PRODUCT");
    expect(hero).toMatchObject({ sourceType: "ENRICHMENT_SERVICE", imageType: "illustrative-product-type", licenseState: "VERIFIED" });
    expect(hero.altText ?? "").toMatch(/headphone/i);
    expect((await buildPageRenderModel(review.id)).image).toMatchObject({ isFallback: false, subject: "ILLUSTRATIVE" });
  });

  it("rejects image facts without a licence, with a non-free licence, off Commons or loosely matched", async () => {
    const { review, productEntityId } = await sonyReview();
    await addImageFact(productEntityId, { unit: null, value: `${stub.base}/image/a.png` });
    await addImageFact(productEntityId, { unit: "CC BY-NC 4.0", value: `${stub.base}/image/b.png` });
    await addImageFact(productEntityId, { value: "https://www.sony.com/image/wh1000xm6.jpg" });
    await addImageFact(productEntityId, { matchBasis: "name", value: `${stub.base}/image/c.png` });
    await addImageFact(productEntityId, { source: "RETAILER", value: `${stub.base}/image/d.png` });
    const asset = await runImageStage(review, await loadSourceContent(review));
    expect(asset?.sourceType).not.toBe("WIKIMEDIA_COMMONS");
    expect(asset?.imageType).not.toBe("commons-product");
  });

  it("is idempotent: re-running keeps the same row", async () => {
    const { review, productEntityId } = await sonyReview();
    await addImageFact(productEntityId);
    const first = await runImageStage(review, await loadSourceContent(review));
    const second = await runImageStage(review, await loadSourceContent(review));
    expect(second?.id).toBe(first?.id);
    const before = await db.imageAsset.count({ where: { normalizedReviewId: review.id } });
    await runImageStage(review, await loadSourceContent(review));
    expect(await db.imageAsset.count({ where: { normalizedReviewId: review.id } })).toBe(before);
  });
});

describe("enrich-images corrects existing wrong heroes", () => {
  it("replaces Pexels heroes on single-product reviews (Commons when licensed, else neutral), idempotently", async () => {
    const { review: sony, productEntityId } = await sonyReview();
    await addImageFact(productEntityId);
    const other = await db.normalizedReview.findFirstOrThrow({ where: { kind: "REVIEW", id: { not: sony.id }, productName: { contains: "MX Master" } } });
    await plantPexelsHero(sony.id, 900001, "PRODUCT");
    await plantPexelsHero(other.id, 900002, "ILLUSTRATIVE");

    const first = await runImageBackfillWithCorrection("test", { limit: 100 });
    expect(first.heroCorrection.checked).toBe(2);
    expect(await primaryImage(sony.id)).toMatchObject({ sourceType: "WIKIMEDIA_COMMONS", imageType: "commons-product" });
    const otherHero = await primaryImage(other.id);
    expect(otherHero.providerPhotoId).not.toBe("pexels:900002");
    expect(["illustrative-product-type", "neutral-category"]).toContain(otherHero.imageType);
    expect(await db.imageAsset.count({ where: { isPrimary: true, review: { kind: "REVIEW" }, sourceType: "ENRICHMENT_SERVICE", NOT: { imageType: "illustrative-product-type" } } })).toBe(0);
    // One primary image per review, the unique primary-photo index intact.
    const primaries = await db.imageAsset.groupBy({ by: ["normalizedReviewId"], where: { isPrimary: true }, _count: { _all: true } });
    expect(primaries.every((p) => p._count._all === 1)).toBe(true);

    const rows = await db.imageAsset.count();
    const second = await runImageBackfillWithCorrection("test", { limit: 100 });
    expect(second.heroCorrection.checked).toBe(0);
    expect(await db.imageAsset.count()).toBe(rows);
    expect((await primaryImage(sony.id)).sourceType).toBe("WIKIMEDIA_COMMONS");
  });

  it("runs from the scheduled enrich-images job, even without a Pexels key", async () => {
    const { review } = await sonyReview();
    await plantPexelsHero(review.id, 900003, "ILLUSTRATIVE");
    const off = withEnv({ PEXELS_API_KEY: undefined });
    try {
      const r = (await runJob("enrich-images", "admin:test")) as { status: string; heroCorrection: { checked: number } };
      expect(r.status).toBe("OK");
      expect(r.heroCorrection.checked).toBe(1);
    } finally {
      off();
    }
    expect(await primaryImage(review.id)).toMatchObject({ sourceType: "PLACEHOLDER", imageType: "neutral-category" });
  });

  it("picks up a Commons photo that arrives later for a page showing the neutral image", async () => {
    const { review, productEntityId } = await sonyReview();
    await runImageStage(review, await loadSourceContent(review));
    expect((await primaryImage(review.id)).imageType).toBe("illustrative-product-type");
    await addImageFact(productEntityId, { matchBasis: "brand+name" });
    const r = await runImageBackfillWithCorrection("test", { limit: 100 });
    expect(r.heroCorrection.commons).toBe(1);
    expect(await primaryImage(review.id)).toMatchObject({ sourceType: "WIKIMEDIA_COMMONS", matchConfidence: 0.9 });
  });
});

describe("category-level content keeps illustrative photos", () => {
  it("a buying guide gets a labelled, on-topic Pexels photo; a legacy one is stamped, not replaced", async () => {
    const guide = await db.normalizedReview.findFirstOrThrow({ where: { productName: { contains: "WH-1000XM6" } } });
    await db.contentEntity.deleteMany({ where: { normalizedReviewId: guide.id, role: "PRIMARY" } });
    await db.normalizedReview.update({ where: { id: guide.id }, data: { kind: "BUYING_GUIDE" } });
    const asset = await runImageStage(guide, await loadSourceContent(guide));
    expect(asset).toMatchObject({ sourceType: "ENRICHMENT_SERVICE", subject: "ILLUSTRATIVE", imageType: "illustrative-category", licenseState: "VERIFIED" });
    const m = await buildPageRenderModel(guide.id);
    expect(m.image.subject).toBe("ILLUSTRATIVE");
    expect(m.image.alt).toBe(asset!.altText);

    // A legacy illustrative photo (no provenance) on category content is kept and stamped.
    await db.imageAsset.update({ where: { id: asset!.id }, data: { imageType: null } });
    await runImageBackfillWithCorrection("test", { limit: 100 });
    const now = await primaryImage(guide.id);
    expect(now).toMatchObject({ sourceType: "ENRICHMENT_SERVICE", imageType: "illustrative-category", providerPhotoId: asset!.providerPhotoId });
  });
});
