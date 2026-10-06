import { unstable_cache } from "next/cache";
import { verifiedCouponsFor } from "@/lib/commerce/coupons";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { registrableDomain } from "@/lib/net/ip";
import { validateOutboundUrl } from "@/lib/net/safe-fetch";
import { displayAmount, displayDate, displayPrice, displayText, displayUrl } from "./display";
import { freshOfferWhere, offerDomain, offerLinkKey, offerUrl, priceMaxAgeMs } from "./offers";

/**
 * Deals: only official, verified data observed by the commerce engine.
 *
 * A PRICE DROP is a CommerceOffer that is
 *  - FRESH and observed within PRODUCT_PRICE_MAX_AGE_HOURS (48 h by default),
 *  - not BROKEN / OFF_SITE / UNREACHABLE at its last link check,
 *  - priced in USD with price > 0, and
 *  - whose page stated BOTH that price and a higher list/regular price (listPrice > price).
 * The saving is computed only from those two stated values (amount floored to the cent, percent
 * floored to a whole number: never rounded up, never an invented "was" price).
 * An offer is labelled "Official <Brand> store price" only when its seller is the MANUFACTURER and
 * the destination is on the brand's own official domain; any other offer is shown with its seller name.
 *
 * A PROMO CODE is a VERIFIED, started, unexpired and recently re-verified code from a brand's own
 * official promotions page (lib/commerce/coupons.ts), with the discount text exactly as stated.
 *
 * Each offer appears once (dedup by canonical destination, by seller domain per product, and by
 * seller + currency + amount per product); each code once per brand. Products need not be reviewed
 * on Made4Buyers; when one is, the deal links to its published review.
 */

export const DEALS_TAG = "deals";
export const DEALS_REVALIDATE_SECONDS = 300;
export const DEAL_CURRENCY = "USD";
export const MAX_PRICE_DROPS = 120;
export const MAX_PROMO_CODES = 60;

export type PriceDrop = {
  id: string;
  productName: string;
  brandName: string | null;
  brandSlug: string | null;
  /** Taxonomy category slugs of the brand (CommerceBrand.categories). */
  categories: string[];
  seller: string;
  official: boolean;
  /** "Official Acme store price" or the seller's name. */
  label: string;
  price: number;
  listPrice: number;
  currency: string;
  priceText: string;
  listPriceText: string;
  saving: number;
  savingText: string;
  /** Whole percent, floored; 0 when the saving is under 1 %. */
  savingPercent: number;
  observedAt: string;
  url: string;
  affiliated: boolean;
  /** Where the price was read, e.g. "acme.com (official site)". */
  source: string;
  review: { slug: string; title: string } | null;
};

export type PromoCode = {
  id: string;
  brandName: string;
  brandSlug: string;
  categories: string[];
  code: string;
  discount: string | null;
  eligibility: string | null;
  restrictions: string | null;
  expiresAt: string | null;
  lastVerifiedAt: string | null;
  sourceUrl: string | null;
  source: string;
};

export type OfficialDeals = { drops: PriceDrop[]; codes: PromoCode[]; checkedAt: string | null };

/** Floors to the cent (with a tiny epsilon for binary float noise): never rounds a saving up. */
function floorCents(n: number): number {
  return Math.floor(n * 100 + 1e-6) / 100;
}

/** The saving from two stated prices, or null unless list > price > 0. */
export function computeSaving(price: unknown, listPrice: unknown): { amount: number; percent: number } | null {
  const p = displayAmount(price);
  const l = displayAmount(listPrice);
  if (p === null || l === null || !(l > p)) return null;
  const amount = floorCents(l - p);
  if (amount <= 0) return null;
  return { amount, percent: Math.floor(((l - p) / l) * 100 + 1e-9) };
}

function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return registrableDomain(new URL(url).hostname.toLowerCase());
  } catch {
    return null;
  }
}

type DropRow = {
  id: string;
  seller: string;
  sellerType: string;
  price: number | null;
  listPrice: number | null;
  currency: string | null;
  observedAt: Date;
  destinationUrl: string;
  affiliateUrl: string | null;
  affiliateStatus: string;
  productId: string;
  product: { name: string; productEntityId: string | null; brand: { name: string; slug: string; categories: string[]; officialDomain: string; officialStoreUrl: string | null } | null };
};

/** Pure: qualifying rows → displayable, de-duplicated price drops (best saving first, then most recent). */
export function toPriceDrops(rows: DropRow[], reviews: Map<string, { slug: string; title: string }>): PriceDrop[] {
  const candidates: Array<PriceDrop & { productKey: string }> = [];
  for (const r of rows) {
    if (r.currency !== DEAL_CURRENCY) continue;
    const saving = computeSaving(r.price, r.listPrice);
    const priceText = displayPrice(r.price, r.currency);
    const listPriceText = displayPrice(r.listPrice, r.currency);
    const savingText = saving ? displayPrice(saving.amount, r.currency) : null;
    if (!saving || !priceText || !listPriceText || !savingText) continue;
    const productName = displayText(r.product.name);
    const seller = displayText(r.seller);
    const link = offerUrl(r);
    const target = validateOutboundUrl(link.url, { standardPortsOnly: true });
    const url = target.url ? displayUrl(target.url.toString()) : null;
    if (!productName || !seller || !url) continue;
    const brand = r.product.brand;
    const brandName = displayText(brand?.name);
    const destDomain = domainOf(r.destinationUrl);
    const officialDomains = new Set([brand?.officialDomain ? registrableDomain(brand.officialDomain.toLowerCase().replace(/^https?:\/\//, "").split("/")[0]) : null, domainOf(brand?.officialStoreUrl)].filter((d): d is string => Boolean(d)));
    const official = r.sellerType === "MANUFACTURER" && Boolean(brandName) && Boolean(destDomain) && officialDomains.has(destDomain!);
    candidates.push({
      id: r.id,
      productKey: r.product.productEntityId ?? r.productId,
      productName,
      brandName,
      brandSlug: brand?.slug ?? null,
      categories: brand?.categories ?? [],
      seller,
      official,
      label: official ? `Official ${brandName} store price` : seller,
      price: r.price!,
      listPrice: r.listPrice!,
      currency: r.currency,
      priceText,
      listPriceText,
      saving: saving.amount,
      savingText,
      savingPercent: saving.percent,
      observedAt: r.observedAt.toISOString(),
      url,
      affiliated: link.affiliated,
      source: official ? `${destDomain} (official site)` : `${destDomain ?? seller} (retailer page)`,
      review: r.product.productEntityId ? (reviews.get(r.product.productEntityId) ?? null) : null,
    });
  }
  // Official offers win a tie, then the bigger saving, then the most recent observation.
  candidates.sort((a, b) => Number(b.official) - Number(a.official) || b.savingPercent - a.savingPercent || b.saving - a.saving || Date.parse(b.observedAt) - Date.parse(a.observedAt));
  const seen = new Set<string>();
  const out: PriceDrop[] = [];
  for (const { productKey, ...d } of candidates) {
    const dest = offerLinkKey(d.url);
    if (!dest) continue;
    const keys = [`url:${dest}`, `domain:${productKey}|${offerDomain(d.url) ?? d.seller.toLowerCase()}`, `price:${productKey}|${d.seller.toLowerCase()}|${d.currency}|${d.price}`];
    if (keys.some((k) => seen.has(k))) continue;
    for (const k of keys) seen.add(k);
    out.push(d);
  }
  return out.sort((a, b) => b.savingPercent - a.savingPercent || Date.parse(b.observedAt) - Date.parse(a.observedAt)).slice(0, MAX_PRICE_DROPS);
}

/** Published reviews of the given product entities (PRIMARY link), first published wins. */
async function reviewsFor(entityIds: string[]): Promise<Map<string, { slug: string; title: string }>> {
  if (!entityIds.length) return new Map();
  const links = await db.contentEntity.findMany({
    where: { role: "PRIMARY", productEntityId: { in: entityIds }, review: { status: "PUBLISHED" } },
    orderBy: { createdAt: "asc" },
    select: { productEntityId: true, review: { select: { slug: true, canonicalTitle: true } } },
  });
  const out = new Map<string, { slug: string; title: string }>();
  for (const l of links) if (!out.has(l.productEntityId)) out.set(l.productEntityId, { slug: l.review.slug, title: l.review.canonicalTitle });
  return out;
}

export async function loadPriceDrops(now = Date.now()): Promise<PriceDrop[]> {
  const rows = await db.commerceOffer.findMany({
    where: { ...freshOfferWhere(now), currency: DEAL_CURRENCY, price: { gt: 0 }, listPrice: { gt: 0 } },
    select: {
      id: true,
      seller: true,
      sellerType: true,
      price: true,
      listPrice: true,
      currency: true,
      observedAt: true,
      destinationUrl: true,
      affiliateUrl: true,
      affiliateStatus: true,
      productId: true,
      product: { select: { name: true, productEntityId: true, brand: { select: { name: true, slug: true, categories: true, officialDomain: true, officialStoreUrl: true } } } },
    },
    orderBy: { observedAt: "desc" },
    take: 2000,
  });
  const qualifying = rows.filter((r) => r.listPrice != null && r.price != null && r.listPrice > r.price);
  const reviews = await reviewsFor([...new Set(qualifying.map((r) => r.product.productEntityId).filter((x): x is string => Boolean(x)))]);
  return toPriceDrops(qualifying, reviews);
}

export async function loadPromoCodes(now = new Date()): Promise<PromoCode[]> {
  const brands = await db.commerceBrand.findMany({ where: { enabled: true }, select: { id: true, name: true, slug: true, categories: true, officialDomain: true }, orderBy: [{ priority: "asc" }, { name: "asc" }] });
  const perBrand = await Promise.all(brands.map(async (b) => ({ b, coupons: await verifiedCouponsFor({ brandId: b.id }, now, 6) })));
  const seen = new Set<string>();
  const out: PromoCode[] = [];
  for (const { b, coupons } of perBrand) {
    const brandName = displayText(b.name);
    if (!brandName) continue;
    for (const c of coupons) {
      const code = displayText(c.code);
      // Re-checked here: VERIFIED, started and not expired.
      if (!code || c.status !== "VERIFIED" || (c.expiresAt && c.expiresAt <= now) || (c.startsAt && c.startsAt > now)) continue;
      const key = `${b.id}|${code.toUpperCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sourceUrl = displayUrl(c.sourceUrl);
      out.push({
        id: c.id,
        brandName,
        brandSlug: b.slug,
        categories: b.categories,
        code,
        discount: displayText(c.discount),
        eligibility: displayText(c.eligibility),
        restrictions: displayText(c.restrictions),
        expiresAt: displayDate(c.expiresAt)?.toISOString() ?? null,
        lastVerifiedAt: displayDate(c.lastVerifiedAt)?.toISOString() ?? null,
        sourceUrl,
        source: `${domainOf(sourceUrl) ?? b.officialDomain} (official site)`,
      });
    }
  }
  return out.sort((a, b) => Date.parse(b.lastVerifiedAt ?? "0") - Date.parse(a.lastVerifiedAt ?? "0")).slice(0, MAX_PROMO_CODES);
}

/** Price drops and promo codes, uncached (tests, admin). */
export async function loadOfficialDeals(now = Date.now()): Promise<OfficialDeals> {
  const [drops, codes] = await Promise.all([loadPriceDrops(now), loadPromoCodes(new Date(now))]);
  const times = [...drops.map((d) => Date.parse(d.observedAt)), ...codes.map((c) => Date.parse(c.lastVerifiedAt ?? ""))].filter(Number.isFinite);
  return { drops, codes, checkedAt: times.length ? new Date(Math.max(...times)).toISOString() : null };
}

const cachedDeals = unstable_cache(() => loadOfficialDeals(), ["official-deals-v1"], { revalidate: DEALS_REVALIDATE_SECONDS, tags: [DEALS_TAG] });

/**
 * Cached for pages (data cache, tag "deals", 5 minutes). The cache stores JSON, so freshness is
 * re-applied on read: anything that aged past the price window since it was cached is dropped.
 */
export async function officialDeals(now = Date.now()): Promise<OfficialDeals> {
  let deals: OfficialDeals;
  try {
    deals = await cachedDeals();
  } catch (error) {
    log.debug("deals cache unavailable; loading directly", { error: String(error) });
    deals = await loadOfficialDeals(now);
  }
  const maxAge = priceMaxAgeMs();
  return {
    ...deals,
    drops: deals.drops.filter((d) => now - Date.parse(d.observedAt) <= maxAge),
    codes: deals.codes.filter((c) => !c.expiresAt || Date.parse(c.expiresAt) > now),
  };
}
