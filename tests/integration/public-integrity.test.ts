import type { ReactElement } from "react";
import { prerender } from "react-dom/static";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { runIngestion } from "@/lib/pipeline/ingest";
import { loadOfficialDeals } from "@/lib/public/deals";
import { FORBIDDEN_PUBLIC_TOKENS, NO_VERIFIED_OFFER, NO_VERIFIED_PRICE } from "@/lib/public/display";
import { freshOffersForReview } from "@/lib/public/offers";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

// Pages run outside Next here: the data cache is a pass-through and there is no router.
vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn, revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  usePathname: () => "/",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
}));

const { default: ReviewPage } = await import("@/app/review/[slug]/page");
const { default: DealsPage } = await import("@/app/deals/page");

/**
 * Public display integrity: a published review seeded with every kind of bad commerce data renders
 * exactly one verified offer, no stale price, no broken link, no unverified coupon and none of the
 * forbidden placeholder tokens. /deals lists only official, verified, fresh USD price drops with a
 * saving computed from the stated prices, and VERIFIED unexpired codes.
 */

const HOUR = 3_600_000;
const body = "The Framework Laptop 13 is a repairable ultraportable with swappable ports, a bright 2.8K display and solid battery life. We tested it for two weeks of daily work and travel.";
let restore: () => void;

beforeAll(async () => {
  await seedTaxonomy();
  restore = withEnv({ CONTENT_API_URL: undefined, AUTO_PUBLISH_ENABLED: undefined, AFFILIATE_PROVIDER: undefined, PRODUCT_PRICE_MAX_AGE_HOURS: undefined, SITE_URL: "https://www.made4buyers.com" });
});
afterAll(() => restore());
beforeEach(() => resetDb());

async function html(el: ReactElement | Promise<ReactElement>): Promise<string> {
  const { prelude } = await prerender(await el);
  return new Response(prelude).text();
}

/** Visible text: markup, scripts and styles removed (what a reader sees). */
function visibleText(markup: string): string {
  return markup
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function jsonLd(markup: string): unknown[] {
  return [...markup.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
}

async function seedReview() {
  await runIngestion({ trigger: "test", source: "apify:example", items: [{ id: "fw13", title: "Framework Laptop 13 review", body, summary: "A repairable laptop that is easy to upgrade.", url: "https://reviews.example.test/reviews/fw13", productName: "Framework Laptop 13", brand: "Framework", category: "laptops", publishedAt: new Date(Date.now() - 86_400_000).toISOString() }] });
  const review = await db.normalizedReview.findFirstOrThrow({ where: { sourceId: "fw13" } });
  expect(review.status).toBe("PUBLISHED");
  const primary = await db.contentEntity.findFirstOrThrow({ where: { normalizedReviewId: review.id, role: "PRIMARY" } });
  const brand = await db.commerceBrand.create({ data: { name: "Framework", slug: "framework", officialDomain: "frame.work", categories: ["laptops"] } });
  const product = await db.commerceProduct.create({ data: { canonicalUrl: "https://frame.work/products/laptop13", name: "Framework Laptop 13", brandId: brand.id, productEntityId: primary.productEntityId, identityStatus: "MATCHED", observedAt: new Date() } });
  return { review, product, brand };
}

const offer = (productId: string, over: Record<string, unknown>) =>
  db.commerceOffer.create({ data: { productId, seller: "Framework", sellerType: "MANUFACTURER", destinationUrl: "https://frame.work/products/laptop13", price: 999, currency: "USD", availability: "InStock", observedAt: new Date(Date.now() - HOUR), linkStatus: "OK", ...over } });

const coupon = (brandId: string, over: Record<string, unknown>) =>
  db.commerceCoupon.create({ data: { brandId, merchant: "Framework", code: "SAVE10", discount: "10% off laptops", sourceUrl: "https://frame.work/promotions", status: "VERIFIED", observedAt: new Date(), lastVerifiedAt: new Date(Date.now() - HOUR), ...over } });

describe("review page display integrity", () => {
  it("shows one verified offer: no duplicate, stale, broken or unpriced junk, no unverified coupon, no placeholder tokens", async () => {
    const { review, product, brand } = await seedReview();
    const good = await offer(product.id, {});
    // Same seller, same amount, same page with tracking parameters and a fragment: a duplicate.
    const dup = await offer(product.id, { destinationUrl: "https://frame.work/products/laptop13?utm_source=newsletter&utm_medium=email&gclid=abc#buy" });
    // Link check found it broken: never shown.
    await offer(product.id, { seller: "Best Buy", sellerType: "RETAILER", destinationUrl: "https://www.bestbuy.com/site/framework-13/123.p", price: 949, linkStatus: "BROKEN" });
    await offer(product.id, { seller: "Newegg", sellerType: "RETAILER", destinationUrl: "https://www.newegg.com/p/fw13", price: 939, linkStatus: "OFF_SITE" });
    // Observed 72 h ago (window 48 h): never shown.
    await offer(product.id, { seller: "Micro Center", sellerType: "RETAILER", destinationUrl: "https://www.microcenter.com/product/fw13", price: 899, observedAt: new Date(Date.now() - 72 * HOUR) });
    // No price and no currency: never a "$0" or "null" price.
    await offer(product.id, { seller: "B&H", sellerType: "RETAILER", destinationUrl: "https://www.bhphotovideo.com/c/product/fw13", price: null, currency: null, availability: "unknown" });
    // A price without a valid currency is not a price.
    await offer(product.id, { seller: "Adorama", sellerType: "RETAILER", destinationUrl: "https://www.adorama.com/fw13", price: 989, currency: "$" });
    await coupon(brand.id, { code: "FAKE20", discount: "20% off everything", status: "UNVERIFIED", sourceUrl: "https://frame.work/promo-b" });
    await coupon(brand.id, { code: "OLD15", status: "EXPIRED", expiresAt: new Date(Date.now() - 86_400_000), sourceUrl: "https://frame.work/promo-c" });
    await coupon(brand.id, {});

    const offers = await freshOffersForReview(review.id);
    const priced = offers.filter((o) => o.price !== null);
    expect(priced).toHaveLength(1);
    expect([good.id, dup.id]).toContain(priced[0].id);
    expect(priced[0].price).toBe(999);

    const markup = await html(ReviewPage({ params: Promise.resolve({ slug: review.slug }) }));
    const text = visibleText(markup);
    // One offer listed (the unpriced and invalid-currency ones are not offers), one price per row.
    expect(markup.match(/class="offer-alt"/g) ?? []).toHaveLength(1);
    expect(text).toContain("$999.00 at Framework");
    expect(markup.match(new RegExp(`/go/(${good.id}|${dup.id})`, "g")) ?? []).toHaveLength(1);
    // Word boundaries: record ids (cuids) may contain these digits.
    expect(markup).not.toMatch(/\b(899|949|939|989)\b/);
    expect(markup).not.toMatch(/bestbuy|newegg|microcenter/);
    expect(text).toContain("SAVE10");
    expect(text).not.toContain("FAKE20");
    expect(text).not.toContain("OLD15");
    expect(text).not.toMatch(FORBIDDEN_PUBLIC_TOKENS);
    expect(text).not.toMatch(/\bunknown\b/i);
    expect(markup).not.toMatch(/href="#"|href=""/);

    // Structured data: one Offer with the fresh price; no empty fields anywhere.
    const ld = jsonLd(markup);
    const ldText = JSON.stringify(ld);
    expect(ldText).not.toMatch(/null|"N\/A"|"undefined"|""/);
    const products = ld.filter((x) => (x as { "@type": string })["@type"] === "Product") as Array<{ offers: { price: number; priceCurrency: string } }>;
    expect(products).toHaveLength(1);
    expect(products[0].offers).toMatchObject({ price: 999, priceCurrency: "USD" });
    expect(ldText).not.toContain("AggregateRating");
  });

  it("without a fresh verified price shows the designed empty state and no Offer markup", async () => {
    const { review, product } = await seedReview();
    await offer(product.id, { observedAt: new Date(Date.now() - 72 * HOUR) });
    await offer(product.id, { destinationUrl: "https://frame.work/products/laptop13-b", linkStatus: "UNREACHABLE" });
    const markup = await html(ReviewPage({ params: Promise.resolve({ slug: review.slug }) }));
    const text = visibleText(markup);
    expect(text).toContain(NO_VERIFIED_PRICE);
    expect(text).not.toMatch(/\$\d/);
    expect(text).not.toMatch(FORBIDDEN_PUBLIC_TOKENS);
    expect(JSON.stringify(jsonLd(markup))).not.toContain('"Offer"');
  });
});

describe("/deals: only official, verified, fresh offers", () => {
  it("lists only ACTIVE price drops (official, or a confirmed retailer) with the stated saving and ACTIVE codes; nothing else", async () => {
    const { product, brand } = await seedReview();
    const l13 = "https://frame.work/products/laptop13";
    const linkCheckedAt = new Date(Date.now() - 2 * HOUR);
    // Official drop: $799 vs stated "ListPrice" $999 → $200 (20 %), as the page stated it.
    const drop = await offer(product.id, { price: 799, listPrice: 999, linkCheckedAt });
    await db.commerceProduct.update({ where: { id: product.id }, data: { data: { offers: [{ type: "Offer", price: 799, listPrice: 999, listPriceType: "ListPrice", url: l13 }] } } });
    // Duplicate of the same page with tracking parameters (observed earlier, so the clean one is listed).
    await offer(product.id, { price: 799, listPrice: 999, destinationUrl: "https://frame.work/products/laptop13?utm_campaign=fall#x", observedAt: new Date(Date.now() - 3 * HOUR) });

    // A retailer page for the SAME product (identity-matched; its official page is frame.work): listed with its seller name.
    const bb = await db.commerceProduct.create({ data: { canonicalUrl: "https://www.bestbuy.com/site/fw13/123.p", name: "Framework Laptop 13", brandId: brand.id, productEntityId: product.productEntityId, identityStatus: "MATCHED", observedAt: new Date(), data: { offers: [{ type: "Offer", price: 849, listPrice: 999, listPriceType: "StrikethroughPrice" }] } } });
    const retailOk = await offer(bb.id, { seller: "Best Buy", sellerType: "RETAILER", destinationUrl: "https://www.bestbuy.com/site/fw13/123.p", price: 849, listPrice: 999 });
    // Another retailer claiming a "was" price above the official regular price: CONFLICTING, hidden.
    const ad = await db.commerceProduct.create({ data: { canonicalUrl: "https://www.adorama.com/fw13", name: "Framework Laptop 13", brandId: brand.id, productEntityId: product.productEntityId, identityStatus: "MATCHED", observedAt: new Date() } });
    await offer(ad.id, { seller: "Adorama", sellerType: "RETAILER", destinationUrl: "https://www.adorama.com/fw13", price: 879, listPrice: 1279 });

    // No list price: a price, not a deal.
    const other = await db.commerceProduct.create({ data: { canonicalUrl: "https://frame.work/products/laptop16", name: "Framework Laptop 16", brandId: brand.id, identityStatus: "UNMATCHED", observedAt: new Date() } });
    await offer(other.id, { destinationUrl: "https://frame.work/products/laptop16", price: 1399 });
    // List price not higher than price.
    await offer(other.id, { destinationUrl: "https://frame.work/products/laptop16-b", price: 1399, listPrice: 1399 });
    // Stale, broken, non-USD: never listed.
    await offer(other.id, { destinationUrl: "https://frame.work/products/laptop16-c", price: 1099, listPrice: 1499, observedAt: new Date(Date.now() - 49 * HOUR) });
    await offer(other.id, { destinationUrl: "https://frame.work/products/laptop16-d", price: 1199, listPrice: 1499, linkStatus: "BROKEN" });
    await offer(other.id, { destinationUrl: "https://frame.work/en-gb/products/laptop16", price: 1149, listPrice: 1499, currency: "GBP" });
    // A retailer drop on a product with no official-site confirmation: UNVERIFIED, not listed.
    await offer(other.id, { seller: "Best Buy", sellerType: "RETAILER", destinationUrl: "https://www.bestbuy.com/site/fw16/456.p", price: 1299, listPrice: 1449 });
    // A "MANUFACTURER" seller on a domain that is neither the brand's own nor a known retailer: INVALID, not listed.
    await offer(other.id, { destinationUrl: "https://framework-outlet.shop/p/16", price: 1249, listPrice: 1399, observedAt: new Date(Date.now() - 2 * HOUR) });
    // Official pages with a stated identity: out of stock, and a promotion whose stated end has passed. Neither listed.
    const l12 = await db.commerceProduct.create({
      data: { canonicalUrl: "https://frame.work/products/laptop12", name: "Framework Laptop 12", sku: "FRAKCB0001", brandId: brand.id, identityStatus: "UNMATCHED", observedAt: new Date(), data: { offers: [{ type: "Offer", price: 1029, listPrice: 1179, url: "https://frame.work/products/laptop12-sale", priceValidUntil: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10) }] } },
    });
    await offer(l12.id, { destinationUrl: "https://frame.work/products/laptop12", price: 1019, listPrice: 1179, availability: "OutOfStock" });
    await offer(l12.id, { destinationUrl: "https://frame.work/products/laptop12-sale", price: 1029, listPrice: 1179 });

    await coupon(brand.id, {});
    await coupon(brand.id, { code: "FAKE20", status: "UNVERIFIED", sourceUrl: "https://frame.work/promo-b" });
    await coupon(brand.id, { code: "OLD15", status: "EXPIRED", sourceUrl: "https://frame.work/promo-c" });
    await coupon(brand.id, { code: "GONE5", status: "VERIFIED", expiresAt: new Date(Date.now() - HOUR), sourceUrl: "https://frame.work/promo-d" });
    await coupon(brand.id, { code: "LATE30", status: "VERIFIED", lastVerifiedAt: new Date(Date.now() - 30 * 86_400_000), sourceUrl: "https://frame.work/promo-e" });
    const ends = new Date(Date.now() + 10 * 86_400_000);
    await coupon(brand.id, { code: "FALL25", discount: "$25 off orders over $500", expiresAt: ends, sourceUrl: "https://frame.work/promo-f" });

    const deals = await loadOfficialDeals();
    expect(deals.drops.map((d) => d.id)).toEqual([drop.id, retailOk.id]);
    expect(deals.drops[0]).toMatchObject({ official: true, label: "Official Framework store price", price: 799, listPrice: 999, listPriceLabel: "Regular price", saving: 200, savingPercent: 20, currency: "USD", availability: "In stock", verified: "Official site (frame.work)", review: expect.objectContaining({ slug: expect.any(String) }) });
    expect(deals.drops[1]).toMatchObject({ official: false, label: "Best Buy", listPriceLabel: "Was", saving: 150, savingPercent: 15, verified: "Retailer page (bestbuy.com) · product confirmed on the official site" });
    expect(deals.codes.map((c) => c.code).sort()).toEqual(["FALL25", "SAVE10"]);
    expect(deals.codes.find((c) => c.code === "SAVE10")).toMatchObject({ brandName: "Framework", discount: "10% off laptops", expiresAt: null, useUrl: "https://frame.work/promotions" });

    const markup = await html(DealsPage());
    const text = visibleText(markup);
    expect(text).toContain("Verified price drops");
    expect(text).toContain("Verified promo codes");
    expect(text).toContain("Official Framework store price");
    expect(text).toContain("Official promo code from Framework");
    // Current price, previous price labelled as the page labels it, the floored saving.
    expect(text).toContain("Current price $799.00");
    expect(text).toContain("Regular price $999.00");
    expect(text).toContain("Was $999.00");
    expect(text).toContain("You save $200.00 (20%)");
    expect(text).toContain("You save $150.00 (15%)");
    // What was verified, and when (relative + absolute, in a <time>).
    expect(text).toContain("Verified Official site (frame.work) · link checked 2 hours ago");
    expect(text).toMatch(/Last checked 1 hour ago · [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{2}:\d{2} UTC/);
    expect(markup).toContain(`<time dateTime="${drop.observedAt.toISOString()}"`);
    expect(text).toContain("Brand Framework");
    expect(text).toContain("Seller Best Buy");
    // View deal: the validated destination, nofollow noopener, never sponsored without an affiliate.
    expect(markup.match(/href="https:\/\/frame\.work\/products\/laptop13"/g) ?? []).toHaveLength(1);
    expect(markup).toMatch(/<a class="btn primary small" href="https:\/\/frame\.work\/products\/laptop13" rel="nofollow noopener" target="_blank"[^>]*>View deal/);
    expect(markup).not.toContain("sponsored nofollow");
    // Promo codes: the code, an accessible copy button, the offer as stated, expiry only when stated, Use code → official page.
    expect(text).toContain("Offer 10% off laptops");
    expect(text).toContain("Offer $25 off orders over $500");
    expect(text).toContain(`Expires ${ends.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })} (as stated)`);
    expect(text.match(/Expires /g) ?? []).toHaveLength(1);
    expect(markup.match(/<button type="button" class="btn small dc-copy" aria-describedby="code-[^"]+">Copy<span class="visually-hidden"> code<\/span><\/button>/g) ?? []).toHaveLength(2);
    expect(markup).toContain('role="status" aria-live="polite"');
    expect(markup).toMatch(/<a class="btn primary small" href="https:\/\/frame\.work\/promotions" rel="nofollow noopener" target="_blank">Use code/);
    expect(text).not.toMatch(/FAKE20|OLD15|GONE5|LATE30|1,099|1,199|1,149|1,249|1,299|1,019|1,029|1,279|\$879/);
    expect(text).not.toMatch(FORBIDDEN_PUBLIC_TOKENS);
    const ld = jsonLd(markup).find((x) => (x as { "@type": string })["@type"] === "ItemList") as { itemListElement: Array<{ item: { offers: Record<string, unknown> } }> };
    expect(ld.itemListElement).toHaveLength(2);
    for (const e of ld.itemListElement) expect(e.item.offers).not.toHaveProperty("priceValidUntil");
  });

  it("with nothing verified shows the empty state, never a fake card", async () => {
    const { product, brand } = await seedReview();
    await offer(product.id, { price: 799, listPrice: 999, observedAt: new Date(Date.now() - 72 * HOUR) });
    await coupon(brand.id, { status: "UNVERIFIED" });
    const markup = await html(DealsPage());
    const text = visibleText(markup);
    expect(text).toContain(NO_VERIFIED_OFFER);
    expect(markup).not.toContain("deal-card");
    expect(text).not.toMatch(FORBIDDEN_PUBLIC_TOKENS);
  });
});
