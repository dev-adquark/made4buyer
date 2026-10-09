import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { runImageBackfill } from "@/lib/jobs/image-backfill";
import { enrichImage } from "@/lib/pipeline/images";
import { findPexelsImage, pexelsSearch, resetPexelsBlock } from "@/lib/pipeline/pexels";
import { buildPageRenderModel } from "@/lib/pipeline/render-model";
import { runIngestion } from "@/lib/pipeline/ingest";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { startStubServer } from "../../scripts/support/stub-server";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

// SAMPLE data only: a local Pexels stub, never the real API.
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
    });
});
afterAll(async () => {
  restore();
  await stub.close();
});
beforeEach(() => resetDb());

/** Stock photos are for category-level content only: turn the SAMPLE reviews into buying guides. */
async function asGuides() {
  await db.contentEntity.deleteMany({ where: { role: "PRIMARY" } });
  await db.normalizedReview.updateMany({ data: { kind: "BUYING_GUIDE" } });
}

describe("Pexels adapter", () => {
  it("parses a successful search, keeps only valid https Pexels photos and reports rate limits", async () => {
    const r = await pexelsSearch("cybersecurity network privacy");
    expect(r.status).toBe("OK");
    expect(r.rateLimit).toMatchObject({ limit: 200, remaining: 150 });
    // The off-host photo is dropped by validation.
    expect(r.photos.every((p) => !p.src.landscape.startsWith("http://evil"))).toBe(true);
  });

  it("reports auth failure, rate limiting, malformed bodies, empty results and a missing key", async () => {
    const off = withEnv({ PEXELS_API_KEY: "wrong" });
    expect((await pexelsSearch("data center servers")).status).toBe("AUTH_FAILED");
    off();
    expect(await pexelsSearch("ratelimit please")).toMatchObject({ status: "RATE_LIMITED", httpStatus: 429 });
    // After a 429 nothing is sent until Pexels' reset time.
    const sent = stub.requests.length;
    expect(await pexelsSearch("anything else")).toMatchObject({ status: "RATE_LIMITED", httpStatus: 0 });
    expect(stub.requests.length).toBe(sent);
    resetPexelsBlock();
    expect((await pexelsSearch("malformed")).status).toBe("INVALID_RESPONSE");
    expect((await pexelsSearch("nothing at all")).status).toBe("EMPTY");
    const none = withEnv({ PEXELS_API_KEY: undefined });
    expect((await pexelsSearch("anything")).status).toBe("NOT_CONFIGURED");
    none();
  });

  it("prefers a photo of the product, otherwise a labelled illustrative topic photo", async () => {
    const product = await findPexelsImage({ productName: "WH-1000XM6", brand: "Sony", categorySlug: "audio" });
    expect(product.image).toMatchObject({ subject: "PRODUCT", attribution: "Photo by Stub Photographer 1 on Pexels" });
    const vpn = await findPexelsImage({ productName: "NordVPN", title: "NordVPN Review 2026", categorySlug: "productivity-software", subcategorySlug: "vpns" });
    expect(vpn.image).toMatchObject({ subject: "ILLUSTRATIVE", topic: "online privacy and network security", width: 1200, height: 627 });
    expect(vpn.image?.attributionUrl).toMatch(/^https:\/\/www\.pexels\.com\/photo\//);
    // The undersized and off-host results were never chosen.
    expect(vpn.image?.url).not.toMatch(/evil/);
  });

  it("avoids a photo another review already uses when an alternative exists", async () => {
    const first = await findPexelsImage({ productName: "pCloud", title: "pCloud Review", categorySlug: "productivity-software", subcategorySlug: "cloud-storage" });
    const second = await findPexelsImage({ productName: "Icedrive", title: "Icedrive Review", categorySlug: "productivity-software", subcategorySlug: "cloud-storage" }, { exclude: new Set([first.image!.providerPhotoId]) });
    expect(second.image?.providerPhotoId).not.toBe(first.image?.providerPhotoId);
  });

  it("falls back to the category placeholder (never a broken image) when the chosen URL does not load", async () => {
    stub.pexels.broken = true;
    try {
      const d = await enrichImage({ productName: "NordVPN", title: "Best VPNs", categorySlug: "productivity-software", subcategorySlug: "vpns", kind: "BUYING_GUIDE" });
      expect(d).toMatchObject({ sourceType: "PLACEHOLDER", sourceUrl: "/placeholders/productivity-software.svg", isFallback: true, enrichmentStatus: "FAILED" });
      expect(d.issues[0].message).toMatch(/HTTP 404|content-type/);
    } finally {
      stub.pexels.broken = false;
    }
  });

  it("skips a publisher's unlicensed image and uses an illustrative Pexels photo for a guide", async () => {
    const d = await enrichImage({ productName: "NordVPN", title: "Best VPNs", categorySlug: "productivity-software", subcategorySlug: "vpns", kind: "BUYING_GUIDE", imageUrl: `${stub.base}/image/publisher.png` });
    expect(d).toMatchObject({ sourceType: "ENRICHMENT_SERVICE", subject: "ILLUSTRATIVE", imageType: "illustrative-category", licenseState: "VERIFIED", isFallback: false });
    // A single-product review gets a labelled photo of its product type, never a stock "product" photo.
    const review = await enrichImage({ productName: "NordVPN", title: "NordVPN Review", categorySlug: "productivity-software", subcategorySlug: "vpns", kind: "REVIEW", imageUrl: `${stub.base}/image/publisher.png` });
    expect(review).toMatchObject({ sourceType: "ENRICHMENT_SERVICE", subject: "ILLUSTRATIVE", imageType: "illustrative-product-type", isFallback: false });
  });
});

describe("image enrichment in the pipeline", () => {
  it("enriches new reviews automatically during ingestion, with attribution and provenance stored", async () => {
    const restoreContent = withEnv({ CONTENT_API_URL: `${stub.base}/content`, CONTENT_API_SOURCE_NAME: "sample-fixture" });
    await runIngestion({ trigger: "test" });
    restoreContent();
    const assets = await db.imageAsset.findMany({ where: { isPrimary: true }, include: { review: { select: { kind: true } } } });
    expect(assets.length).toBeGreaterThan(0);
    // The SAMPLE items are single-product reviews: never a stock photo; the source's licensed
    // image or the neutral category image, each with its provenance.
    for (const a of assets) {
      expect(a.review.kind).toBe("REVIEW");
      if (a.sourceType === "ENRICHMENT_SERVICE") expect(a.subject).toBe("ILLUSTRATIVE");
      expect(a.imageType).toBe(a.sourceType === "PLACEHOLDER" ? "neutral-category" : a.sourceType === "ENRICHMENT_SERVICE" ? "illustrative-product-type" : "source-product");
    }
    // As category guides they get labelled illustrative Pexels photos, with attribution.
    await asGuides();
    await runImageBackfill("test");
    const real = await db.imageAsset.findMany({ where: { isPrimary: true, sourceType: "ENRICHMENT_SERVICE" } });
    expect(real.length).toBeGreaterThan(0);
    for (const a of real) {
      expect(a.attribution).toMatch(/^Photo by .+ on Pexels$/);
      expect(a.attributionUrl).toMatch(/^https:\/\/www\.pexels\.com\//);
      expect(a.providerPhotoId).toMatch(/^pexels:\d+$/);
      expect(a.subject).toBe("ILLUSTRATIVE");
      expect(["illustrative-category", "illustrative-product-type"]).toContain(a.imageType);
      expect(a.licenseState).toBe("VERIFIED");
    }
  });

  it("backfills unlicensed/placeholder images, is idempotent, and labels illustrative photos on the page", async () => {
    const restoreContent = withEnv({ CONTENT_API_URL: `${stub.base}/content`, CONTENT_API_SOURCE_NAME: "sample-fixture", PEXELS_API_KEY: undefined });
    await runIngestion({ trigger: "test" }); // no key: every review gets the placeholder
    restoreContent();
    expect(await db.imageAsset.count({ where: { isPrimary: true, sourceType: "ENRICHMENT_SERVICE" } })).toBe(0);
    await asGuides();

    const first = await runImageBackfill("test");
    expect(first.status).toBe("OK");
    expect(first.enriched).toBeGreaterThan(0);
    expect(first.enriched + first.fallback + first.skippedGood).toBe(first.checked);

    const second = await runImageBackfill("test");
    expect(second.enriched).toBe(0);
    expect(second.skippedGood).toBe(first.enriched + first.skippedGood);

    const illustrative = await db.imageAsset.findFirst({ where: { isPrimary: true, subject: "ILLUSTRATIVE" } });
    if (illustrative) {
      const m = await buildPageRenderModel(illustrative.normalizedReviewId);
      expect(m.image.subject).toBe("ILLUSTRATIVE");
      // The alt text says what the photo shows (its own description), never the old "Illustrative" wording.
      expect(m.image.alt).toBe(illustrative.altText);
      expect(m.image.alt).not.toMatch(/Illustrative/);
      expect(m.image.attribution).toMatch(/on Pexels$/);
    }
  });

  it("replaces a broken stored image and stops cleanly on a rate limit", async () => {
    const restoreContent = withEnv({ CONTENT_API_URL: `${stub.base}/content`, CONTENT_API_SOURCE_NAME: "sample-fixture" });
    await runIngestion({ trigger: "test" });
    restoreContent();
    await asGuides();
    await runImageBackfill("test");
    const a = await db.imageAsset.findFirstOrThrow({ where: { isPrimary: true, isFallback: false } });
    await db.imageAsset.update({ where: { id: a.id }, data: { sourceUrl: `${stub.base}/pexels-img/broken.jpeg` } });
    const r = await runImageBackfill("test");
    expect(r.brokenFixed).toBe(1);
    const now = await db.imageAsset.findFirstOrThrow({ where: { normalizedReviewId: a.normalizedReviewId, isPrimary: true } });
    expect(now.sourceUrl).not.toContain("broken");

    // A rate-limited provider stops the batch at the first review instead of hammering it.
    await db.imageAsset.deleteMany({});
    stub.pexels.rateLimited = true;
    try {
      const limited = await runImageBackfill("test");
      expect(limited.status).toBe("RATE_LIMITED");
      expect(limited.checked).toBe(1);
      expect(limited.reason).toMatch(/rate limit/i);
    } finally {
      stub.pexels.rateLimited = false;
    }
  });
});

describe("image subject by content kind", () => {
  it("never labels a comparison's or guide's photo as the product", async () => {
    const r = await findPexelsImage({ productName: "WH-1000XM6", brand: "Sony", categorySlug: "audio", kind: "BUYING_GUIDE" });
    expect(r.image?.subject).toBe("ILLUSTRATIVE");
    const review = await findPexelsImage({ productName: "WH-1000XM6", brand: "Sony", categorySlug: "audio", kind: "REVIEW" });
    expect(review.image?.subject).toBe("PRODUCT");
  });
});
