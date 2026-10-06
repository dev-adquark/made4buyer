import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { runJob } from "@/lib/jobs/registry";
import { CHECKS, DATA_AUDIT_SETTING, lastDataAudit, listFlagged, runDataAudit } from "@/lib/ops/data-audit";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BODY = "The Alpha Phone has a bright display and a long-lasting battery. We tested it for a month.";

beforeAll(async () => {
  await seedTaxonomy();
});
beforeEach(() => resetDb());

let n = 0;
async function review(title: string, body: string, image?: Record<string, unknown> | null) {
  n++;
  const r = await db.normalizedReview.create({
    data: { source: "test", sourceId: `r${n}`, dedupeKey: `test:r${n}`, canonicalTitle: title, slug: `review-${n}`, productName: title, summary: "Summary.", body, status: "PUBLISHED", publishedAt: new Date(Date.now() - n * HOUR) },
  });
  if (image !== null) {
    await db.imageAsset.create({
      data: { normalizedReviewId: r.id, sourceType: "ENRICHMENT_SERVICE", sourceUrl: `https://images.example.test/${n}.jpg`, licenseState: "PROVIDER_ASSERTED", license: "Pexels License", attributionUrl: `https://www.pexels.com/photo/${n}/`, enrichmentStatus: "ENRICHED", isPrimary: true, ...image },
    });
  }
  return r;
}

async function product(slug: string, data: Record<string, unknown> = {}) {
  return db.productEntity.create({ data: { slug, name: slug, matchKey: slug, ...data } });
}

const fact = (productEntityId: string, field: string, source: string, sourceUrl: string | null) =>
  db.productFact.create({ data: { productEntityId, field, value: "https://brand.example.test/p", source, sourceName: source.toLowerCase(), sourceKey: sourceUrl ?? source.toLowerCase(), sourceUrl, observedAt: new Date(), matchBasis: "model" } });

async function seed() {
  const r1 = await review("Alpha Phone Review", BODY, {});
  // Same title after normalization, same body after whitespace/case normalization, no hero image.
  const r2 = await review("alpha phone review!", `  ${BODY.toUpperCase().replace(/ /g, "   ")} `, null);
  // Hero image without licence text or source page.
  const r3 = await review("Beta Laptop Review", "A different body about a laptop.", { licenseState: "UNVERIFIED", license: null, attributionUrl: null, sourcePageUrl: null });

  const p1 = await product("alpha-phone", { factSummary: { conflicting: ["price"], missing: [], stale: [], fields: {} } });
  await db.contentEntity.create({ data: { normalizedReviewId: r1.id, productEntityId: p1.id, role: "PRIMARY", confidence: 1, source: "AUTO" } });
  await fact(p1.id, "officialUrl", "MANUFACTURER", null); // public, no source URL, official signal without VERIFIED status
  await fact(p1.id, "brand", "RETAILER", "https://shop.example.test/alpha"); // fine

  const p2 = await product("unpublished-thing");
  await fact(p2.id, "model", "SECONDARY", null); // not public: missing source only

  const p3 = await product("beta-laptop", { officialStatus: "VERIFIED", officialUrl: "https://brand.example.test/beta" });
  await db.contentEntity.create({ data: { normalizedReviewId: r3.id, productEntityId: p3.id, role: "PRIMARY", confidence: 1, source: "AUTO" } });
  await fact(p3.id, "officialUrl", "MANUFACTURER", "https://brand.example.test/beta"); // verified: not flagged

  const cp1 = await db.commerceProduct.create({ data: { canonicalUrl: "https://shop.example.test/p/1", name: "Alpha Phone", productEntityId: p1.id, observedAt: new Date() } });
  await db.commerceProduct.create({ data: { canonicalUrl: "https://shop.example.test/p/1?utm_source=newsletter", name: "Alpha Phone (tracking)", observedAt: new Date() } });
  const offer = (over: Record<string, unknown>) => db.commerceOffer.create({ data: { productId: cp1.id, seller: "Shop", sellerType: "RETAILER", destinationUrl: "https://shop.example.test/p/1", price: 499, currency: "USD", observedAt: new Date(), ...over } });
  const stale = await offer({ observedAt: new Date(Date.now() - 72 * HOUR) });
  await offer({ destinationUrl: "https://shop.example.test/p/1?gclid=abc" }); // duplicate of `stale`
  await offer({ seller: "Other", destinationUrl: "https://other.example.test/x", price: 450, linkStatus: "BROKEN" });

  const coupon = (over: Record<string, unknown>) => db.commerceCoupon.create({ data: { merchant: "Alpha", code: "X", sourceUrl: "https://alpha.example.test/promo", observedAt: new Date(), ...over } });
  const expired = await coupon({ code: "OLD10", status: "VERIFIED", expiresAt: new Date(Date.now() - DAY), lastVerifiedAt: new Date() });
  await coupon({ code: "UNSEEN", status: "VERIFIED", lastVerifiedAt: new Date(Date.now() - 30 * DAY) });
  await coupon({ code: "MAYBE", status: "CONFLICTING" });
  await coupon({ code: "DUP5", status: "UNVERIFIED", sourceUrl: "https://alpha.example.test/a" });
  await coupon({ merchant: "alpha ", code: "dup5", status: "UNVERIFIED", sourceUrl: "https://alpha.example.test/b" });
  return { r1, r2, stale, expired };
}

const EXPECTED: Record<string, number> = {
  "unverified-public-facts": 1,
  "unverified-official": 1,
  "stale-fresh-offers": 1,
  "expired-verified-coupons": 1,
  "unseen-verified-coupons": 1,
  "conflicting-fact-fields": 1,
  "conflicting-coupons": 1,
  "duplicate-offers": 1,
  "duplicate-review-titles": 1,
  "duplicate-review-content": 1,
  "duplicate-commerce-products": 1,
  "duplicate-coupons": 1,
  "broken-offer-links": 1,
  "missing-hero-image": 1,
  "image-missing-source": 1,
  "fact-missing-source": 2,
};

async function tableCounts() {
  const [reviews, images, facts, products, offers, coupons, cproducts] = await Promise.all([db.normalizedReview.count(), db.imageAsset.count(), db.productFact.count(), db.productEntity.count(), db.commerceOffer.count(), db.commerceCoupon.count(), db.commerceProduct.count()]);
  return { reviews, images, facts, products, offers, coupons, cproducts };
}

describe("data-integrity audit", () => {
  it("covers every check in the expectations", () => {
    expect(CHECKS.map((c) => c.key).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it("detects each flag type on seeded data", async () => {
    const restore = withEnv({ PRODUCT_PRICE_MAX_AGE_HOURS: undefined, COMMERCE_COUPON_MAX_AGE_DAYS: undefined });
    try {
      const { r1, r2 } = await seed();
      const result = await runDataAudit("test", { fix: false });
      expect(result.counts).toEqual(EXPECTED);
      expect(result.fixed).toEqual({ offersMarkedStale: 0, couponsMarkedExpired: 0 });

      const titles = await listFlagged("duplicate-review-titles", 1);
      expect(titles?.rows[0].detail).toContain(r1.slug);
      expect(titles?.rows[0].detail).toContain(r2.slug);
      expect((await listFlagged("missing-hero-image", 1))?.rows.map((r) => r.id)).toEqual([r2.id]);
      expect((await listFlagged("unverified-official", 1))?.rows[0]).toMatchObject({ title: "alpha-phone" });
      expect((await listFlagged("conflicting-fact-fields", 1))?.rows[0].detail).toContain("price");

      // Paged drill-down.
      const p1 = await listFlagged("fact-missing-source", 1, 1);
      const p2 = await listFlagged("fact-missing-source", 2, 1);
      expect(p1?.total).toBe(2);
      expect(p1?.rows).toHaveLength(1);
      expect(p2?.rows).toHaveLength(1);
      expect(p1?.rows[0].id).not.toBe(p2?.rows[0].id);
      expect(await listFlagged("no-such-check", 1)).toBeNull();
    } finally {
      restore();
    }
  });

  it("applies only the safe fixes, audits them and deletes nothing", async () => {
    const { r2, stale, expired } = await seed();
    const before = await tableCounts();
    const bodyBefore = (await db.normalizedReview.findUniqueOrThrow({ where: { id: r2.id } })).body;

    const result = await runDataAudit("test");
    expect(result.counts["stale-fresh-offers"]).toBe(1);
    expect(result.fixed).toEqual({ offersMarkedStale: 1, couponsMarkedExpired: 1 });
    expect((await db.commerceOffer.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe("STALE");
    expect((await db.commerceCoupon.findUniqueOrThrow({ where: { id: expired.id } })).status).toBe("EXPIRED");
    // Other rows untouched.
    expect(await db.commerceOffer.count({ where: { status: "FRESH" } })).toBe(2);
    expect(await db.commerceCoupon.count({ where: { status: "VERIFIED" } })).toBe(1);

    const audits = await db.auditLog.findMany({ where: { action: { startsWith: "data_audit.fix." } }, orderBy: { action: "asc" } });
    expect(audits.map((a) => a.action)).toEqual(["data_audit.fix.coupons_expired", "data_audit.fix.offers_stale"]);
    expect(audits[1].metadata).toMatchObject({ count: 1, ids: [stale.id] });
    expect(audits[0].metadata).toMatchObject({ count: 1, ids: [expired.id] });

    expect(await tableCounts()).toEqual(before);
    expect((await db.normalizedReview.findUniqueOrThrow({ where: { id: r2.id } })).body).toBe(bodyBefore);

    // Stored result, and a second run is idempotent.
    const stored = await lastDataAudit();
    expect(stored).toMatchObject({ trigger: "test", counts: result.counts, fixed: result.fixed });
    expect(await db.automationSetting.findUnique({ where: { key: DATA_AUDIT_SETTING } })).not.toBeNull();
    const again = await runDataAudit("test");
    expect(again.counts["stale-fresh-offers"]).toBe(0);
    expect(again.counts["expired-verified-coupons"]).toBe(0);
    expect(again.fixed).toEqual({ offersMarkedStale: 0, couponsMarkedExpired: 0 });
    expect(await db.auditLog.count({ where: { action: { startsWith: "data_audit.fix." } } })).toBe(2);
  });

  it("runs as the data-audit job under its lock and records the run", async () => {
    await seed();
    const result = (await runJob("data-audit", "admin:owner@example.test")) as { status: string; totalFlagged: number };
    expect(result.status).toBe("OK");
    expect(result.totalFlagged).toBeGreaterThan(0);
    expect(await db.jobRun.findFirstOrThrow({ where: { job: "data-audit" } })).toMatchObject({ status: "SUCCEEDED", outcome: "OK", trigger: "admin:owner@example.test" });
    expect(await db.auditLog.count({ where: { actor: "owner@example.test", action: { startsWith: "data_audit.fix." } } })).toBe(2);
    expect(await db.jobLock.count()).toBe(0);
  });

  it("reports zero on a clean database", async () => {
    const result = await runDataAudit("test");
    expect(Object.values(result.counts).every((v) => v === 0)).toBe(true);
    expect(result.totalFlagged).toBe(0);
  });
});
