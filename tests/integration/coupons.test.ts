import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { runCouponRefresh } from "@/lib/jobs/revalidation";
import { runIngestion } from "@/lib/pipeline/ingest";
import { buildPageRenderModel } from "@/lib/pipeline/render-model";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { startStubServer } from "../../scripts/support/stub-server";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

let stub: Awaited<ReturnType<typeof startStubServer>>;
let restore: () => void;
const recent = () => new Date(Date.now() - 86_400_000).toISOString();
const body = "The Framework Laptop 13 is a repairable ultraportable with swappable ports, a bright 2.8K display and solid battery life. We tested it for two weeks of daily work and travel.";

beforeAll(async () => {
  await seedTaxonomy();
  stub = await startStubServer({});
  restore = withEnv({ SOVRN_COUPONS_ENABLED: "true", SOVRN_COUPONS_URL: `${stub.base}/coupons/product`, SOVRN_API_KEY: "test-sovrn-key", SOVRN_SITE_KEY: "public-site-key", SOVRN_API_URL: undefined, CONTENT_API_URL: undefined, AUTO_PUBLISH_ENABLED: undefined });
});
afterAll(async () => {
  restore();
  await stub.close();
});
beforeEach(async () => {
  await resetDb();
  stub.coupons.status = 0;
  stub.coupons.coupons = [];
  stub.coupons.requests.length = 0;
});

async function publishedReview() {
  await runIngestion({ trigger: "test", source: "apify:example", items: [{ id: "fw13", title: "Framework Laptop 13 review", body, summary: "A repairable laptop that is easy to upgrade.", url: "https://reviews.example.test/reviews/fw13", productName: "Framework Laptop 13", brand: "Framework", category: "laptops", publishedAt: recent() }] });
  const r = await db.normalizedReview.findFirstOrThrow({ where: { sourceId: "fw13" } });
  expect(r.status).toBe("PUBLISHED");
  return db.normalizedReview.update({ where: { id: r.id }, data: { sourceProductUrl: "https://shop.example.test/p/fw13?utm_source=news&color=black" } });
}
const coupon = (over: Record<string, unknown> = {}) => ({ id: "c1", code: "SAVE20", affiliated_url: "https://sovrn.co/abc", currency: "USD", verified: true, original_price: 1099, price_with_code: 989, verified_at: recent(), code_description: "10% off laptops", ...over });

describe("Sovrn coupon enrichment", () => {
  it("is reported as blocked, not run, until the Promo Codes API is enabled", async () => {
    const r = withEnv({ SOVRN_COUPONS_ENABLED: undefined });
    try {
      expect(await runCouponRefresh({ trigger: "test" })).toMatchObject({ status: "BLOCKED_BY_ENVIRONMENT" });
    } finally {
      r();
    }
  });

  it("stores a verified code for the canonical retailer URL and shows it on the page", async () => {
    const review = await publishedReview();
    stub.coupons.coupons = [coupon()];
    const res = await runCouponRefresh({ trigger: "test" });
    expect(res).toMatchObject({ reasons: { COUPONS_FOUND: 1 } });
    expect(stub.coupons.requests).toEqual(["https://shop.example.test/p/fw13?color=black"]);
    const stored = await db.sovrnCoupon.findFirstOrThrow({ where: { normalizedReviewId: review.id } });
    expect(stored).toMatchObject({ code: "SAVE20", verified: true, isActive: true, priceWithCode: 989, originalPrice: 1099, merchantName: "Example Shop" });
    expect(stored.verifiedAt).not.toBeNull();
    const model = await buildPageRenderModel(review.id);
    expect(model.coupons?.map((c) => c.code)).toEqual(["SAVE20"]);
  });

  it("no coupon, expired verification or an unverified code: nothing is shown; a code Sovrn stops returning is retired", async () => {
    const review = await publishedReview();
    stub.coupons.coupons = [coupon(), coupon({ id: "old", code: "OLD10", verified_at: new Date(Date.now() - 20 * 86_400_000).toISOString() }), coupon({ id: "unv", code: "MAYBE", verified: false, verified_at: null })];
    await runCouponRefresh({ trigger: "test" });
    expect((await buildPageRenderModel(review.id)).coupons?.map((c) => c.code)).toEqual(["SAVE20"]);

    await db.sovrnOfferCache.deleteMany(); // Sovrn's check-back time has passed
    stub.coupons.coupons = [];
    expect(await runCouponRefresh({ trigger: "test" })).toMatchObject({ reasons: { NO_COUPON: 1 } });
    expect(await db.sovrnCoupon.count({ where: { normalizedReviewId: review.id, isActive: true } })).toBe(0);
    expect((await buildPageRenderModel(review.id)).coupons).toEqual([]);
  });

  it("401/403 never touch the content and invent nothing", async () => {
    const review = await publishedReview();
    for (const status of [401, 403]) {
      await db.sovrnOfferCache.deleteMany();
      stub.coupons.status = status;
      expect(await runCouponRefresh({ trigger: "test" })).toMatchObject({ reasons: { AUTH_FAILED: 1 } });
    }
    expect(await db.sovrnCoupon.count()).toBe(0);
    expect((await db.normalizedReview.findUniqueOrThrow({ where: { id: review.id } })).status).toBe("PUBLISHED");
  });
});
