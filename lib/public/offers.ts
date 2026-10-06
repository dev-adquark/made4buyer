import type { Prisma } from "@prisma/client";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { affiliateProviderActive } from "@/lib/affiliate/provider";
import { HIDDEN_LINK_STATUSES } from "@/lib/commerce/link-check";
import { registrableDomain } from "@/lib/net/ip";
import { canonicalDestination, displayAmount, displayCurrency, displayText } from "./display";

/**
 * Public commerce offers: prices and seller links observed by the commerce engine
 * (CommerceProduct → CommerceOffer), attached to a review through its PRIMARY product
 * (CommerceProduct.productEntityId = ContentEntity.productEntityId, role PRIMARY).
 *
 * Freshness rule: an offer is shown with its price only while status is FRESH and its
 * observation is at most PRODUCT_PRICE_MAX_AGE_HOURS (default 48) old. A stale price is
 * never shown. Links are the retailer's own URL unless a real affiliate provider generated
 * an affiliate URL for the offer (lib/affiliate/provider.ts).
 *
 * Link rule: an offer whose destination check (CommerceOffer.linkStatus) found it BROKEN,
 * OFF_SITE or UNREACHABLE is never shown; UNCHECKED, OK and REDIRECTED_SAME_SITE are.
 *
 * Dedup rule: an offer is shown once. Two offers are the same when they share the canonical
 * destination (no fragment, no utm_* / gclid / fbclid / mc_* or repeated parameters; affiliate
 * parameters kept only when a real provider is configured), or the same (seller, currency,
 * amount); and at most one offer per seller domain is shown (cheapest, then most recent).
 */

export type PublicOffer = {
  id: string;
  seller: string;
  /** MANUFACTURER | RETAILER */
  sellerType: string;
  price: number | null;
  currency: string | null;
  availability: string | null;
  observedAt: string;
  /** affiliateUrl when a provider set it, else the plain destinationUrl. */
  url: string;
  affiliated: boolean;
};

export const MAX_PUBLIC_OFFERS = 4;

/**
 * Destination-check results that hide an offer (BROKEN, OFF_SITE, UNREACHABLE), owned by the link
 * checker. UNCHECKED, OK, REDIRECTED_SAME_SITE and BLOCKED (bot-blocked, not dead) stay visible.
 */
export { HIDDEN_LINK_STATUSES };

export function linkStatusShowable(status: string | null | undefined): boolean {
  return !(HIDDEN_LINK_STATUSES as readonly string[]).includes(status ?? "UNCHECKED");
}

export function priceMaxAgeMs(): number {
  return config.commerce.priceMaxAgeHours() * 3_600_000;
}

/** Observations at or after this moment are fresh. */
export function freshSince(now = Date.now()): Date {
  return new Date(now - priceMaxAgeMs());
}

/** True only for a FRESH offer observed within the price window (and not in the future), whose link is not known to be bad. */
export function offerIsFresh(o: { observedAt: string | Date; status?: string; linkStatus?: string | null }, now = Date.now()): boolean {
  if (o.status !== undefined && o.status !== "FRESH") return false;
  if (o.linkStatus !== undefined && !linkStatusShowable(o.linkStatus)) return false;
  const t = o.observedAt instanceof Date ? o.observedAt.getTime() : Date.parse(o.observedAt);
  return Number.isFinite(t) && t >= now - priceMaxAgeMs() && t <= now + 3_600_000;
}

export function freshOfferWhere(now = Date.now()): Prisma.CommerceOfferWhereInput {
  return { status: "FRESH", observedAt: { gte: freshSince(now) }, linkStatus: { notIn: [...HIDDEN_LINK_STATUSES] } };
}

/** The link an offer uses: a provider-generated affiliate URL only when one is stored, else the plain URL. */
export function offerUrl(o: { destinationUrl: string; affiliateUrl: string | null; affiliateStatus?: string | null }): { url: string; affiliated: boolean } {
  const affiliated = Boolean(o.affiliateUrl) && (o.affiliateStatus == null || o.affiliateStatus === "AFFILIATED");
  return { url: affiliated ? o.affiliateUrl! : o.destinationUrl, affiliated };
}

type OfferRow = Prisma.CommerceOfferGetPayload<{ select: typeof OFFER_SELECT }>;
const OFFER_SELECT = { id: true, seller: true, sellerType: true, price: true, currency: true, availability: true, observedAt: true, destinationUrl: true, affiliateUrl: true, affiliateStatus: true, status: true, linkStatus: true } as const;

export function toPublicOffer(o: Omit<OfferRow, "linkStatus"> & { linkStatus?: string | null }, now = Date.now()): PublicOffer {
  const fresh = offerIsFresh(o, now);
  const link = offerUrl(o);
  // Belt and braces: a price is carried only while the observation is fresh, with a positive
  // amount AND a valid ISO 4217 currency (never a price without its currency).
  const amount = fresh ? displayAmount(o.price) : null;
  const currency = fresh ? displayCurrency(o.currency) : null;
  const priced = amount !== null && currency !== null;
  return {
    id: o.id,
    seller: displayText(o.seller) ?? offerDomain(link.url) ?? "",
    sellerType: o.sellerType,
    price: priced ? amount : null,
    currency: priced ? currency : null,
    availability: fresh ? displayText(o.availability) : null,
    observedAt: o.observedAt.toISOString(),
    url: link.url,
    affiliated: link.affiliated,
  };
}

/** Canonical destination of an offer link (affiliate parameters kept only with a real provider). */
export function offerLinkKey(url: string): string | null {
  return canonicalDestination(url, { keepAffiliateParams: affiliateProviderActive() });
}

/**
 * Shown once: cheapest priced first, then by recency; drops offers without a usable http(s)
 * link or seller, and any offer whose canonical destination, (seller, currency, amount) or
 * seller domain was already shown.
 */
export function sortAndDedupe<T extends Pick<PublicOffer, "url" | "seller" | "price" | "currency" | "observedAt">>(rows: T[]): T[] {
  const sorted = [...rows].sort((a, b) => (a.price == null ? 1 : 0) - (b.price == null ? 1 : 0) || (a.price ?? 0) - (b.price ?? 0) || Date.parse(b.observedAt) - Date.parse(a.observedAt));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const o of sorted) {
    const dest = offerLinkKey(o.url);
    if (!dest || !o.seller) continue;
    const keys = [`url:${dest}`, `domain:${offerDomain(o.url) ?? o.seller.toLowerCase()}`, ...(o.price != null ? [`price:${o.seller.toLowerCase()}|${o.currency}|${o.price}`] : [])];
    if (keys.some((k) => seen.has(k))) continue;
    for (const k of keys) seen.add(k);
    out.push(o);
  }
  return out;
}

export function offerDomain(url: string): string | null {
  try {
    return registrableDomain(new URL(url).hostname.toLowerCase());
  } catch {
    return null;
  }
}

/** Fresh offers for one product entity (exact identity match only; the engine sets productEntityId). */
export async function freshOffersForProduct(productEntityId: string, now = Date.now()): Promise<PublicOffer[]> {
  const rows = await db.commerceOffer.findMany({
    where: { ...freshOfferWhere(now), product: { productEntityId } },
    select: OFFER_SELECT,
    orderBy: { observedAt: "desc" },
    take: 20,
  });
  return sortAndDedupe(rows.map((r) => toPublicOffer(r, now))).slice(0, MAX_PUBLIC_OFFERS);
}

/** The review's PRIMARY product, if any. */
export async function primaryProductId(reviewId: string): Promise<string | null> {
  const link = await db.contentEntity.findFirst({ where: { normalizedReviewId: reviewId, role: "PRIMARY" }, select: { productEntityId: true } });
  return link?.productEntityId ?? null;
}

/** Fresh commerce offers for a review's PRIMARY product (none for comparisons/guides without one). */
export async function freshOffersForReview(reviewId: string, now = Date.now()): Promise<PublicOffer[]> {
  const pid = await primaryProductId(reviewId);
  return pid ? freshOffersForProduct(pid, now) : [];
}

export type ReviewOffer = PublicOffer & { review: { id: string; slug: string; productName: string; categorySlug: string | null; canonicalTitle: string } };

/**
 * Fresh priced offers attached to PUBLISHED reviews (via their PRIMARY product), best price per
 * review first. Used by /deals, the homepage ledger, navigation and stats.
 */
export async function publishedFreshOffers(opts: { categorySlug?: string; limit?: number; now?: number } = {}): Promise<ReviewOffer[]> {
  const now = opts.now ?? Date.now();
  const rows = await db.commerceOffer.findMany({
    where: { ...freshOfferWhere(now), price: { gt: 0 }, product: { productEntityId: { not: null } } },
    select: { ...OFFER_SELECT, product: { select: { productEntityId: true } } },
    orderBy: { observedAt: "desc" },
    take: 1000,
  });
  if (!rows.length) return [];
  const entityIds = [...new Set(rows.map((r) => r.product.productEntityId!))];
  const links = await db.contentEntity.findMany({
    where: { role: "PRIMARY", productEntityId: { in: entityIds }, review: { status: "PUBLISHED", ...(opts.categorySlug ? { categorySlug: opts.categorySlug } : {}) } },
    select: { productEntityId: true, review: { select: { id: true, slug: true, productName: true, categorySlug: true, canonicalTitle: true } } },
  });
  const byEntity = new Map<string, Array<(typeof links)[number]["review"]>>();
  for (const l of links) byEntity.set(l.productEntityId, [...(byEntity.get(l.productEntityId) ?? []), l.review]);
  const best = new Map<string, ReviewOffer>();
  for (const r of rows) {
    const pub = toPublicOffer(r, now);
    if (pub.price == null || !pub.seller || !offerLinkKey(pub.url)) continue;
    for (const review of byEntity.get(r.product.productEntityId!) ?? []) {
      const cur = best.get(review.id);
      if (!cur || pub.price < (cur.price ?? Infinity)) best.set(review.id, { ...pub, review });
    }
  }
  return [...best.values()].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt)).slice(0, opts.limit ?? 500);
}

/**
 * The commerce-engine brand behind a review's PRIMARY product (for its official promo codes):
 * the brand of an identity-matched CommerceProduct, else a configured brand with the same name.
 */
export async function commerceBrandIdForReview(reviewId: string, brandName: string | null): Promise<string | null> {
  const pid = await primaryProductId(reviewId);
  if (pid) {
    const p = await db.commerceProduct.findFirst({ where: { productEntityId: pid, brandId: { not: null } }, select: { brandId: true } });
    if (p?.brandId) return p.brandId;
  }
  if (!brandName?.trim()) return null;
  const b = await db.commerceBrand.findFirst({ where: { name: { equals: brandName.trim(), mode: "insensitive" } }, select: { id: true } });
  return b?.id ?? null;
}
