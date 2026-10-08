import { NextResponse } from "next/server";
import { DEALS_REVALIDATE_SECONDS, officialDeals, type PriceDrop, type PromoCode } from "@/lib/public/deals";
import { memoryRateLimit } from "@/lib/security/rate-limit";
import { clientIp } from "@/lib/security/request";

export const dynamic = "force-dynamic";

/** Per-IP requests per minute (per instance; responses are also CDN-cached for 5 minutes). */
const LIMIT_PER_MINUTE = 60;

/** Exactly the fields /deals renders: no row ids, no internal statuses or provenance ids. */
const publicDrop = (d: PriceDrop) => ({
  productName: d.productName,
  brandName: d.brandName,
  brandSlug: d.brandSlug,
  categories: d.categories,
  seller: d.seller,
  official: d.official,
  label: d.label,
  price: d.price,
  listPrice: d.listPrice,
  listPriceLabel: d.listPriceLabel,
  currency: d.currency,
  priceText: d.priceText,
  listPriceText: d.listPriceText,
  saving: d.saving,
  savingText: d.savingText,
  savingPercent: d.savingPercent,
  availability: d.availability,
  validUntil: d.validUntil,
  lastChecked: d.observedAt,
  linkCheckedAt: d.linkCheckedAt,
  verified: d.verified,
  source: d.source,
  url: d.url,
  affiliated: d.affiliated,
  review: d.review ? { slug: d.review.slug, title: d.review.title, url: `/review/${d.review.slug}` } : null,
  // The card's image: exact product photo, a labelled illustrative photo of its type, or our category image.
  image: d.image ? { src: d.image.src, alt: d.image.alt, kind: d.image.kind, exact: d.image.exact, caption: d.image.caption, attribution: d.image.attribution, attributionUrl: d.image.attributionUrl } : null,
});

const publicCode = (c: PromoCode) => ({
  brandName: c.brandName,
  brandSlug: c.brandSlug,
  categories: c.categories,
  code: c.code,
  discount: c.discount,
  eligibility: c.eligibility,
  restrictions: c.restrictions,
  expiresAt: c.expiresAt,
  lastVerifiedAt: c.lastVerifiedAt,
  sourceUrl: c.sourceUrl,
  useUrl: c.useUrl,
  source: c.source,
  verifiedVia: c.verifiedVia,
  viaFeed: Boolean(c.viaFeed),
  checkedAt: c.checkedAt ?? c.lastVerifiedAt,
});

/**
 * GET /api/commerce/deals — public, read-only: the ACTIVE price drops and the public promo codes /deals
 * shows (officialDeals(): the same cached data, the same 48 h price window and the same coupon rule,
 * publicCoupons() with its 7-day verification window). Rate-limited per IP.
 */
export async function GET(req: Request) {
  if (!memoryRateLimit(`commerce-deals:${clientIp(req) ?? "unknown"}`, LIMIT_PER_MINUTE, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "60" } });
  }
  const deals = await officialDeals();
  return NextResponse.json(
    { checkedAt: deals.checkedAt, priceDrops: deals.drops.map(publicDrop), promoCodes: deals.codes.map(publicCode) },
    { headers: { "Cache-Control": `public, s-maxage=${DEALS_REVALIDATE_SECONDS}, stale-while-revalidate=60` } },
  );
}
