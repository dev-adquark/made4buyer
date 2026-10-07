import { PrismaClient } from "@prisma/client";
import { expect, type APIRequestContext } from "@playwright/test";

/**
 * Commerce fixtures for the populated /deals E2E (tests/e2e/deals.spec.ts), written straight to the
 * E2E database with Prisma. Idempotent: every row is upserted on a natural key and its time-relative
 * fields are reset to "now" on each call. `cleanupDealFixtures` removes every row it created, so the
 * rest of the suite (pipeline.spec.ts) still sees a database without commerce data.
 *
 * The brand domain is a plausible public one (display helpers reject *.test / example.com at render).
 * Nothing here, nor any page it feeds, fetches it: the tests never follow external links.
 */

export const DB_URL = process.env.E2E_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:56432/made4buyers_e2e";
export const CRON = { authorization: "Bearer e2e-cron-secret" };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SITE = "https://www.slumberline.com";

export const FIX = {
  brand: { slug: "e2e-slumberline", name: "Slumberline", domain: "slumberline.com", category: "mattresses", categoryName: "Mattresses" },
  /** The only price drop that may appear: fresh, OK link, in stock, list > price. */
  valid: {
    product: "Slumberline Original Hybrid Mattress",
    url: `${SITE}/products/original-hybrid?size=queen`,
    price: 899,
    listPrice: 1199,
    priceText: "$899.00",
    listPriceText: "$1,199.00",
    savingText: "$300.00",
    savingPercent: "25%",
  },
  /** Same product and price, destination differs only by utm_* tracking parameters. */
  duplicateUrl: `${SITE}/products/original-hybrid?size=queen&utm_source=newsletter&utm_medium=email&utm_campaign=fall`,
  stale: { product: "Slumberline Cloud Pillow", url: `${SITE}/products/cloud-pillow` },
  outOfStock: { product: "Slumberline Weighted Blanket", url: `${SITE}/products/weighted-blanket` },
  broken: { product: "Slumberline Platform Bed Frame", url: `${SITE}/products/platform-bed-frame` },
  sentinel: { product: "Slumberline cache sentinel", url: `${SITE}/products/e2e-cache-sentinel` },
  promoUrl: `${SITE}/pages/offers`,
  codes: { verified: "SLEEP20", verifiedDiscount: "20% off sitewide", expired: "SPRING15", unverified: "MAYBE10" },
} as const;

/** Text of rows that must never reach a public page. */
export const HIDDEN_TEXT = [FIX.stale.product, FIX.outOfStock.product, FIX.broken.product, FIX.sentinel.product, FIX.codes.expired, FIX.codes.unverified, "utm_source"];

let client: PrismaClient | null = null;
export function db(): PrismaClient {
  client ??= new PrismaClient({ datasourceUrl: DB_URL });
  return client;
}
export async function disconnect() {
  await client?.$disconnect();
  client = null;
}

/**
 * A product page on the brand's own site, as the engine stores it: a stated SKU/model (its identity)
 * and, in `data.offers`, the page's offers exactly as stated (price, regular "ListPrice", availability).
 */
async function product(brandId: string | null, name: string, canonicalUrl: string, now: Date, stated: { sku: string; price: number; listPrice: number; availability: string }) {
  const data = { pageUrl: canonicalUrl, offers: [{ price: stated.price, listPrice: stated.listPrice, listPriceType: "ListPrice", priceCurrency: "USD", availability: stated.availability, url: canonicalUrl }] };
  const identity = { sku: stated.sku, model: stated.sku, category: FIX.brand.category, identityStatus: "UNMATCHED", data };
  return db().commerceProduct.upsert({
    where: { canonicalUrl },
    create: { brandId, name, canonicalUrl, observedAt: now, ...identity },
    update: { brandId, name, observedAt: now, ...identity },
  });
}

type OfferSeed = { price: number; listPrice: number; observedAt: Date; linkStatus: string; availability: string; status?: string };
async function offer(productId: string, destinationUrl: string, o: OfferSeed) {
  const data = {
    seller: FIX.brand.name,
    sellerType: "MANUFACTURER",
    affiliateUrl: null,
    affiliateProvider: null,
    affiliateStatus: "NONE",
    price: o.price,
    listPrice: o.listPrice,
    currency: "USD",
    availability: o.availability,
    observedAt: o.observedAt,
    status: o.status ?? "FRESH",
    linkStatus: o.linkStatus,
    linkCheckedAt: o.observedAt,
    linkHttpStatus: o.linkStatus === "BROKEN" ? 404 : 200,
  };
  return db().commerceOffer.upsert({ where: { productId_destinationUrl: { productId, destinationUrl } }, create: { productId, destinationUrl, ...data }, update: data });
}

type CouponSeed = { code: string; status: string; discount: string; expiresAt: Date | null; lastVerifiedAt: Date | null };
async function coupon(brandId: string, c: CouponSeed, now: Date) {
  const data = {
    brandId,
    title: `${c.discount} at ${FIX.brand.name}`,
    discount: c.discount,
    discountType: "PERCENT",
    startsAt: new Date(now.getTime() - 3 * DAY),
    expiresAt: c.expiresAt,
    eligibility: "New and returning customers",
    restrictions: null,
    merchantUrl: SITE,
    status: c.status,
    verificationEvidence: c.status === "VERIFIED" ? "Code and terms listed on the brand's own offers page" : null,
    observedAt: c.lastVerifiedAt ?? now,
    lastVerifiedAt: c.lastVerifiedAt,
  };
  return db().commerceCoupon.upsert({
    where: { merchant_code_sourceUrl: { merchant: FIX.brand.name, code: c.code, sourceUrl: FIX.promoUrl } },
    create: { merchant: FIX.brand.name, code: c.code, sourceUrl: FIX.promoUrl, ...data },
    update: data,
  });
}

/**
 * Seeds the brand, products, offers and codes. The STALE offer and the EXPIRED code are stored the way
 * the engine last saw them (FRESH / VERIFIED) with an old observation / past expiry: the
 * commerce-collect job then ages them, exactly as in production, and that change purges the "deals"
 * cache (lib/commerce/revalidate.ts), so the pages read the new rows immediately.
 */
export async function seedDealFixtures(now = new Date()) {
  const t = now.getTime();
  const brand = await db().commerceBrand.upsert({
    where: { slug: FIX.brand.slug },
    create: { slug: FIX.brand.slug, name: FIX.brand.name, officialDomain: FIX.brand.domain, officialStoreUrl: SITE, categories: [FIX.brand.category], promoUrls: [FIX.promoUrl], enabled: true, priority: 1, nextCrawlAt: new Date(t + 365 * DAY) },
    update: { name: FIX.brand.name, officialDomain: FIX.brand.domain, officialStoreUrl: SITE, categories: [FIX.brand.category], promoUrls: [FIX.promoUrl], enabled: true, priority: 1, nextCrawlAt: new Date(t + 365 * DAY) },
  });
  const recent = new Date(t - 2 * HOUR);

  const mattress = await product(brand.id, FIX.valid.product, FIX.valid.url, now, { sku: "SL-OH-Q", price: FIX.valid.price, listPrice: FIX.valid.listPrice, availability: "InStock" });
  await offer(mattress.id, FIX.valid.url, { price: FIX.valid.price, listPrice: FIX.valid.listPrice, observedAt: recent, linkStatus: "OK", availability: "InStock" });
  // Duplicate: the same page with tracking parameters, seen an hour earlier.
  await offer(mattress.id, FIX.duplicateUrl, { price: FIX.valid.price, listPrice: FIX.valid.listPrice, observedAt: new Date(t - 3 * HOUR), linkStatus: "OK", availability: "InStock" });

  const pillow = await product(brand.id, FIX.stale.product, FIX.stale.url, now, { sku: "SL-CP-STD", price: 59, listPrice: 79, availability: "InStock" });
  await offer(pillow.id, FIX.stale.url, { price: 59, listPrice: 79, observedAt: new Date(t - 72 * HOUR), linkStatus: "OK", availability: "InStock" });

  const blanket = await product(brand.id, FIX.outOfStock.product, FIX.outOfStock.url, now, { sku: "SL-WB-15", price: 149, listPrice: 199, availability: "OutOfStock" });
  await offer(blanket.id, FIX.outOfStock.url, { price: 149, listPrice: 199, observedAt: recent, linkStatus: "OK", availability: "OutOfStock" });

  const frame = await product(brand.id, FIX.broken.product, FIX.broken.url, now, { sku: "SL-PBF-Q", price: 499, listPrice: 649, availability: "InStock" });
  await offer(frame.id, FIX.broken.url, { price: 499, listPrice: 649, observedAt: recent, linkStatus: "BROKEN", availability: "InStock" });

  await coupon(brand.id, { code: FIX.codes.verified, status: "VERIFIED", discount: FIX.codes.verifiedDiscount, expiresAt: new Date(t + 10 * DAY), lastVerifiedAt: new Date(t - HOUR) }, now);
  await coupon(brand.id, { code: FIX.codes.expired, status: "VERIFIED", discount: "15% off mattresses", expiresAt: new Date(t - DAY), lastVerifiedAt: new Date(t - 2 * DAY) }, now);
  await coupon(brand.id, { code: FIX.codes.unverified, status: "UNVERIFIED", discount: "10% off pillows", expiresAt: null, lastVerifiedAt: null }, now);
  return { brandId: brand.id };
}

/** Runs the commerce-collect cron job (no network: no Apify runs are stored) and returns its result. */
async function runCollect(request: APIRequestContext) {
  const res = await request.get("/api/cron/commerce-collect", { headers: CRON });
  expect(res.status(), "commerce-collect cron").toBe(200);
  const body = (await res.json()) as { results?: Record<string, { staleOffers?: number; coupons?: { expired?: number } }> };
  return body.results?.["commerce-collect"] ?? {};
}

/** Seeds, then lets the engine age the stale offer / expired code, which purges the deals cache. */
export async function seedAndPublish(request: APIRequestContext) {
  await seedDealFixtures();
  const r = await runCollect(request);
  expect(r.staleOffers ?? 0, "the stale offer is aged by commerce-collect (and the deals cache purged)").toBeGreaterThanOrEqual(1);
  expect(r.coupons?.expired ?? 0, "the expired code is marked EXPIRED by commerce-collect").toBeGreaterThanOrEqual(1);
  const stale = await db().commerceOffer.findFirst({ where: { destinationUrl: FIX.stale.url } });
  expect(stale?.status).toBe("STALE");
  const expired = await db().commerceCoupon.findFirst({ where: { code: FIX.codes.expired, merchant: FIX.brand.name } });
  expect(expired?.status).toBe("EXPIRED");
}

/**
 * Removes every fixture row, then purges the deals cache through the same production path: a
 * brand-less sentinel offer observed 72 h ago is aged by commerce-collect (which revalidates), and
 * deleted. Safe to call repeatedly.
 */
export async function cleanupDealFixtures(request: APIRequestContext) {
  const brand = await db().commerceBrand.findUnique({ where: { slug: FIX.brand.slug } });
  await db().commerceCoupon.deleteMany({ where: { OR: [{ merchant: FIX.brand.name, sourceUrl: FIX.promoUrl }, ...(brand ? [{ brandId: brand.id }] : [])] } });
  await db().commerceProduct.deleteMany({ where: { OR: [{ canonicalUrl: { startsWith: SITE } }, ...(brand ? [{ brandId: brand.id }] : [])] } });
  if (brand) await db().commerceBrand.delete({ where: { id: brand.id } });

  const sentinel = await product(null, FIX.sentinel.product, FIX.sentinel.url, new Date(), { sku: "SL-SENTINEL", price: 10, listPrice: 20, availability: "InStock" });
  await offer(sentinel.id, FIX.sentinel.url, { price: 10, listPrice: 20, observedAt: new Date(Date.now() - 72 * HOUR), linkStatus: "OK", availability: "InStock" });
  const r = await runCollect(request);
  await db().commerceProduct.deleteMany({ where: { canonicalUrl: FIX.sentinel.url } });
  expect(r.staleOffers ?? 0, "cache purge after cleanup").toBeGreaterThanOrEqual(1);
  expect(await db().commerceOffer.count({ where: { destinationUrl: { startsWith: SITE } } })).toBe(0);
  expect(await db().commerceCoupon.count({ where: { merchant: FIX.brand.name } })).toBe(0);
}
