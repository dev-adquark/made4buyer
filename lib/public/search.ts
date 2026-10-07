import { db } from "@/lib/db";
import { officialDeals, recentlyVerifiedPrices, type PriceDrop, type PromoCode } from "./deals";

/**
 * Commerce search for /search: current verified price drops, the latest verified coupons and the
 * brands that have them. Everything comes from the same data /deals shows (officialDeals(): ACTIVE
 * drops within 48 h, coupons that pass publicCoupons() within the 7-day window), so search can never
 * list an offer the deals page would hide. Nothing is invented: no match → empty lists.
 */

export const SEARCH_DEALS_MAX = 6;
export const SEARCH_COUPONS_MAX = 6;

/** Lower-cased query terms (2+ characters, at most 6). */
export function searchTerms(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}.+-]/gu, ""))
    .filter((t) => t.length >= 2)
    .slice(0, 6);
}

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** A price drop matches when every term appears in its product name, brand or seller. */
export function dropMatches(d: Pick<PriceDrop, "productName" | "brandName" | "seller">, terms: string[]): boolean {
  if (!terms.length) return false;
  const hay = `${d.productName} ${d.brandName ?? ""} ${d.seller}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/**
 * A coupon matches its brand: the whole query is (part of) the brand name, or a term of 3+ characters
 * is one of the brand name's words or its slug ("breville espresso" → Breville's codes).
 */
export function couponMatches(c: Pick<PromoCode, "brandName" | "brandSlug">, q: string, terms: string[]): boolean {
  const name = c.brandName.toLowerCase();
  const query = q.trim().toLowerCase();
  if (query.length >= 2 && name.includes(query)) return true;
  const brandWords = new Set([...words(name), c.brandSlug.toLowerCase(), name.replace(/[^\p{L}\p{N}]+/gu, "")]);
  return terms.some((t) => t.length >= 3 && brandWords.has(t));
}

export type CommerceBrandHit = { name: string; slug: string; href: string; drops: number; coupons: number; prices: number };
export type CommerceSearch = { drops: PriceDrop[]; dropCount: number; coupons: PromoCode[]; couponCount: number; brands: CommerceBrandHit[] };

const EMPTY: CommerceSearch = { drops: [], dropCount: 0, coupons: [], couponCount: 0, brands: [] };

/** Price drops, coupons and commerce brands matching the query (grouped, with total counts). */
export async function searchCommerce(q: string, now = Date.now()): Promise<CommerceSearch> {
  const terms = searchTerms(q);
  if (!terms.length) return EMPTY;
  const [deals, prices] = await Promise.all([officialDeals(now), recentlyVerifiedPrices(now).catch(() => [])]);
  const drops = deals.drops.filter((d) => dropMatches(d, terms));
  const coupons = deals.codes.filter((c) => couponMatches(c, q, terms));

  // Brands: enabled commerce brands whose name matches, listed only when they have something verified to show.
  const nameTerms = terms.filter((t) => t.length >= 2);
  const brandRows = await db.commerceBrand.findMany({
    where: { enabled: true, OR: [{ name: { contains: q.trim(), mode: "insensitive" } }, ...nameTerms.map((t) => ({ slug: { equals: t } })), ...nameTerms.filter((t) => t.length >= 3).map((t) => ({ name: { contains: t, mode: "insensitive" as const } }))] },
    select: { name: true, slug: true },
    orderBy: [{ priority: "asc" }, { name: "asc" }],
    take: 20,
  });
  const brands: CommerceBrandHit[] = [];
  for (const b of brandRows) {
    const hit = {
      name: b.name,
      slug: b.slug,
      href: `/deals?brand=${encodeURIComponent(b.slug)}`,
      drops: deals.drops.filter((d) => d.brandSlug === b.slug).length,
      coupons: deals.codes.filter((c) => c.brandSlug === b.slug).length,
      prices: prices.filter((p) => p.brandSlug === b.slug).length,
    };
    if (hit.drops + hit.coupons + hit.prices > 0) brands.push(hit);
  }
  return { drops: drops.slice(0, SEARCH_DEALS_MAX), dropCount: drops.length, coupons: coupons.slice(0, SEARCH_COUPONS_MAX), couponCount: coupons.length, brands: brands.slice(0, 6) };
}
