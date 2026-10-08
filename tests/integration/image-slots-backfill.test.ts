import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { entitiesWithExactImages, runHeroCorrection } from "@/lib/images/hero-correction";
import { exactProductImagesFor } from "@/lib/images/review-exact-image";
import { productTypeTopic } from "@/lib/images/product-type";
import { loadImageSlotCounts } from "@/lib/images/slot-counts";
import { photoMatchesTopic } from "@/lib/pipeline/image-topics";
import { pexelsSearch } from "@/lib/pipeline/pexels";
import { buildPageRenderModel } from "@/lib/pipeline/render-model";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { startStubServer } from "../../scripts/support/stub-server";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

// SAMPLE data only: a local Pexels stub, never the real API. The four reviews production showed
// with the placeholder graphic (their type's photo pool used up by other articles).
let stub: Awaited<ReturnType<typeof startStubServer>>;
let restore: () => void;
beforeAll(async () => {
  await seedTaxonomy();
  stub = await startStubServer({});
  restore = withEnv({ PEXELS_API_KEY: "test-pexels-key", PEXELS_API_BASE_URL: `${stub.base}/pexels/v1`, UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: "true", IMAGE_ENRICHMENT_URL: undefined, IMAGE_REQUIRE_LICENSE: "true" });
});
afterAll(async () => {
  restore();
  await stub.close();
});
beforeEach(() => resetDb());

const TARGETS = [
  { productName: "Google Pixel 11", brand: "Google", categorySlug: "phones" },
  { productName: "Samsung Galaxy Z Fold 8 Ultra", brand: "Samsung", categorySlug: "phones" },
  { productName: "Peak Design City Crescent 6L", brand: "Peak Design", categorySlug: "luggage-travel" },
  { productName: "Coway Airmega ProX", brand: "Coway", categorySlug: "home-appliances" },
];

let n = 0;
async function review(productName: string, brand: string, categorySlug: string) {
  n++;
  const r = await db.normalizedReview.create({
    data: { source: "t", sourceId: `s${n}`, dedupeKey: `d${n}`, canonicalTitle: `${productName} review`, slug: `r-${n}`, productName, brand, categorySlug, summary: "s", body: "b", kind: "REVIEW", status: "PUBLISHED", publishedAt: new Date() },
  });
  const e = await db.productEntity.create({ data: { slug: `e-${n}`, name: productName, matchKey: `k-${n}`, brand } });
  await db.contentEntity.create({ data: { normalizedReviewId: r.id, productEntityId: e.id, role: "PRIMARY", confidence: 0.95, source: "AUTO" } });
  return r;
}

describe("the four placeholder reviews resolve even when their type's photo pool is used up", () => {
  it("hero correction retries placeholders on the next run and reuses an on-topic photo; no placeholder graphic is left", async () => {
    // Other articles already use every photo the stub returns for these types.
    const used = new Set<number>();
    for (const t of TARGETS) for (const q of productTypeTopic({ productName: t.productName })!.queries) for (const p of (await pexelsSearch(q, { perPage: 30 })).photos) used.add(p.id);
    let i = 0;
    for (const id of used) {
      const other = await review(`Filler phone ${i++}`, "Acme", "phones");
      await db.imageAsset.create({ data: { normalizedReviewId: other.id, sourceType: "ENRICHMENT_SERVICE", sourceUrl: `${stub.base}/pexels-img/${id}.jpeg`, licenseState: "VERIFIED", enrichmentStatus: "ENRICHED", subject: "ILLUSTRATIVE", imageType: "illustrative-product-type", providerPhotoId: `pexels:${id}`, altText: "Stock photo: smartphone in hand", searchQuery: "smartphone in hand", verifiedAt: new Date() } });
    }
    // The targets: placeholders checked 40 minutes ago (the old once-a-day gate would skip them).
    const targets: Array<(typeof TARGETS)[number] & { id: string; slug: string }> = [];
    for (const t of TARGETS) {
      const r = await review(t.productName, t.brand, t.categorySlug);
      await db.imageAsset.create({ data: { normalizedReviewId: r.id, sourceType: "PLACEHOLDER", sourceUrl: `/placeholders/${t.categorySlug}.svg`, licenseState: "OWNED_PLACEHOLDER", enrichmentStatus: "FALLBACK", isFallback: true, imageType: "neutral-category", failureReason: "no on-topic Pexels photo", verifiedAt: new Date(Date.now() - 40 * 60_000) } });
      targets.push({ ...t, id: r.id, slug: r.slug });
    }

    const out = await runHeroCorrection("test");
    expect(out.failed).toBe(0);
    for (const t of targets) {
      const a = await db.imageAsset.findFirstOrThrow({ where: { normalizedReviewId: t.id, isPrimary: true } });
      expect(a, t.productName).toMatchObject({ sourceType: "ENRICHMENT_SERVICE", subject: "ILLUSTRATIVE", imageType: "illustrative-product-type", isFallback: false });
      expect(a.matchBasis).toBe("pexels:product-type:reused-on-topic");
      expect(photoMatchesTopic(a.altText ?? "", productTypeTopic({ productName: t.productName })!)).toBe(true);
      expect(used.has(Number(a.providerPhotoId!.replace("pexels:", "")))).toBe(true);
      // The page: the photo, its credit, the small note; never the placeholder graphic.
      const m = await buildPageRenderModel(t.id);
      expect(m.image).toMatchObject({ isFallback: false, subject: "ILLUSTRATIVE" });
      expect(m.image.url).not.toMatch(/\/placeholders\//);
      expect(m.image.attribution).toMatch(/on Pexels$/);
    }
    // Admin count: placeholder graphic in public slots must be 0.
    const slots = await loadImageSlotCounts();
    expect(slots.reviews.missing).toBe(0);
    expect(slots.placeholderSvg).toBe(0);

    // Idempotent: a second run leaves them alone (no placeholder left to retry).
    const again = await runHeroCorrection("test");
    expect(again.items.filter((x) => targets.some((t) => t.slug === x.slug))).toHaveLength(0);
  });
});

describe("exact product photos for reviews come from identity-matched commerce products", () => {
  it("finds the brand's own photo of a reviewed product (and nothing for an unmatched one)", async () => {
    const r = await review("Peak Design City Crescent 6L", "Peak Design", "luggage-travel");
    const link = await db.contentEntity.findFirstOrThrow({ where: { normalizedReviewId: r.id, role: "PRIMARY" } });
    const brand = await db.commerceBrand.create({ data: { name: "Peak Design", slug: "peak-design", officialDomain: "www.peakdesign.com" } });
    const img = "https://www.peakdesign.com/cdn/shop/files/city-crescent-6l.jpg";
    await db.commerceProduct.create({ data: { brandId: brand.id, productEntityId: link.productEntityId, identityStatus: "MATCHED", canonicalUrl: "https://www.peakdesign.com/products/city-crescent-6l", name: "City Crescent 6L", observedAt: new Date(), data: { productImages: [{ src: img, alt: "City Crescent 6L", source: "shopify-product" }] } } });
    await db.commerceProduct.create({ data: { brandId: brand.id, productEntityId: null, identityStatus: "UNMATCHED", canonicalUrl: "https://www.peakdesign.com/products/everyday-sling", name: "Everyday Sling", observedAt: new Date(), data: { productImages: [{ src: "https://www.peakdesign.com/cdn/sling.jpg", source: "json-ld" }] } } });
    expect(await exactProductImagesFor(link.productEntityId)).toEqual([expect.objectContaining({ kind: "official", url: img, pageUrl: "https://www.peakdesign.com/products/city-crescent-6l", publisher: "Peak Design" })]);
    expect(await entitiesWithExactImages()).toEqual([link.productEntityId]);
  });
});

describe("migration 20261016000000_image_slots_never_empty", () => {
  it("is applied (enum values, column, non-unique index) and idempotent when re-run", async () => {
    const sql = readFileSync("prisma/migrations/20261016000000_image_slots_never_empty/migration.sql", "utf8");
    const statements = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean);
    for (const st of statements) await db.$executeRawUnsafe(st);
    const labels = await db.$queryRaw<Array<{ enumlabel: string }>>`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'image_source_type'`;
    expect(labels.map((l) => l.enumlabel)).toEqual(expect.arrayContaining(["OFFICIAL_SITE", "RETAILER_SITE"]));
    const cols = await db.$queryRaw<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name = 'image_assets' AND column_name = 'matchBasis'`;
    expect(cols).toHaveLength(1);
    const idx = await db.$queryRaw<Array<{ indexname: string; indexdef: string }>>`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'image_assets' AND indexname LIKE 'image_assets_primary_photo%'`;
    expect(idx.map((x) => x.indexname)).toEqual(["image_assets_primary_photo_idx"]);
    expect(idx[0].indexdef).not.toMatch(/UNIQUE/);
  });
});
