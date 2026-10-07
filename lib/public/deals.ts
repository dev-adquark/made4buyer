import type { Prisma } from "@prisma/client";
import { unstable_cache } from "next/cache";
import { verifiedCouponsForBrands } from "@/lib/commerce/coupons";
import { classifyOffers, computeSaving, COUPON_TIER_LABEL, couponMaxAgeDays, couponSourceTier, onOfficialDomain, validUntilMs, type DealCandidate, type DealProductInput, type OfferDealVerdict, type OfficialReference } from "@/lib/commerce/deal-status";
import { HIDDEN_LINK_STATUSES } from "@/lib/commerce/link-check";
import { db } from "@/lib/db";
import { categoryCardImage, type DealCardImage } from "@/lib/images/deal-card-image";
import { loadDealCardImages } from "@/lib/images/deal-card-images";
import { ILLUSTRATIVE_DEAL_CAPTION } from "@/lib/images/provenance";
import { log } from "@/lib/log";
import { registrableDomain } from "@/lib/net/ip";
import { validateOutboundUrl } from "@/lib/net/safe-fetch";
import { categoryPhotos, type CategoryPhoto } from "./category-images";
import { displayDate, displayPrice, displayText, displayUrl } from "./display";
import { freshOfferWhere, offerDomain, offerLinkKey, offerUrl, priceMaxAgeMs } from "./offers";

/**
 * Deals: only official, verified data observed by the commerce engine. Whether an offer or a code is
 * a deal is decided by ONE place, lib/commerce/deal-status.ts (offerDealStatus / classifyOffers /
 * couponDealStatus); this module loads the rows, asks it, and shapes the ACTIVE ones for display.
 *
 * A PRICE DROP is an ACTIVE offer: an official-domain page (or a known retailer's page for a product
 * confirmed on the official site), USD, observed within PRODUCT_PRICE_MAX_AGE_HOURS (48 h), link not
 * BROKEN / OFF_SITE / UNREACHABLE, purchasable (not out of stock / sold out / discontinued), its
 * stated promotion end (if any) not passed, nothing on the official site contradicting it, and the
 * page stating BOTH the price and a higher list/regular price. The saving is computed only from
 * those two stated values (amount floored to the cent, percent floored to a whole number).
 * "Official <Brand> store price" only when the seller is the MANUFACTURER on the brand's own domain.
 *
 * A PROMO CODE is a public code (publicCoupons() in deal-status.ts, via verifiedCouponsForBrands):
 * VERIFIED on the brand's own official site or store, started, unexpired, verified within the last
 * COMMERCE_COUPON_MAX_AGE_DAYS (7) days, not a duplicate and not contradicted by another official
 * page, with the offer text exactly as stated.
 *
 * A CURRENT PRICE ("Recently verified") is an offer that passes every price-drop rule except that its
 * page states no previous price: a real, recently checked price, never presented as a discount.
 *
 * Each offer appears once (classifyOffers' dedup); each code once per brand. Products need not be
 * reviewed on Made4Buyers; when one is, the deal links to its published review.
 */

export { computeSaving };

export const DEALS_TAG = "deals";
export const DEALS_REVALIDATE_SECONDS = 300;
export const DEAL_CURRENCY = "USD";
export const MAX_PRICE_DROPS = 120;
export const MAX_PROMO_CODES = 60;
export const MAX_CURRENT_PRICES = 60;

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
  /** The previous price exactly as the page labelled it: "Regular price" (ListPrice), "Was" (StrikethroughPrice), else "List price". */
  listPriceLabel: string;
  currency: string;
  priceText: string;
  listPriceText: string;
  saving: number;
  savingText: string;
  /** Whole percent, floored; 0 when the saving is under 1 %. */
  savingPercent: number;
  /** When the price was read from the page (the "Last checked" time). */
  observedAt: string;
  /** When the destination link was last checked (null: not checked yet). */
  linkCheckedAt: string | null;
  /** What was verified, e.g. "Official site (acme.com)" or "Retailer page (bestbuy.com) · product confirmed on the official site". */
  verified: string;
  /** "official": read on the brand's own site; "retailer": a retailer page for a product confirmed on the official site. */
  verifiedKind: "official" | "retailer";
  /** Registrable domain of the seller's page (the seller filter). */
  sellerDomain: string | null;
  /** "In stock", "Pre-order" … when the page stated it; null when unstated. */
  availability: string | null;
  /** The page's stated end of this price (ISO), only when it stated one. */
  validUntil: string | null;
  url: string;
  affiliated: boolean;
  /** Where the price was read, e.g. "acme.com (official site)". */
  source: string;
  review: { slug: string; title: string } | null;
  /**
   * The card's image (lib/images/deal-card-image.ts): the exact product (official, retailer or our verified
   * photo), else a labelled illustrative photo of its type, else the neutral category image. Never empty.
   */
  image: DealCardImage;
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
  /** "View offer" destination: the brand's official promotions page where the code is published. */
  useUrl: string | null;
  source: string;
  /** "Official brand site" (tier 1) or "Official brand store" (tier 2). */
  verifiedVia: string;
  /** Registrable domain of the page that publishes the code (the seller filter). */
  sellerDomain: string | null;
};

/** A recently verified current price with no stated previous price: a price, not a deal. */
export type CurrentPrice = Omit<PriceDrop, "listPrice" | "listPriceLabel" | "listPriceText" | "saving" | "savingText" | "savingPercent" | "validUntil">;

export type OfficialDeals = { drops: PriceDrop[]; codes: PromoCode[]; checkedAt: string | null };

function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return registrableDomain(new URL(url).hostname.toLowerCase());
  } catch {
    return null;
  }
}

// ── Loading offers with everything deal-status needs ─────────────────────────

const OFFER_SELECT = {
  id: true,
  seller: true,
  sellerType: true,
  price: true,
  listPrice: true,
  currency: true,
  availability: true,
  observedAt: true,
  status: true,
  linkStatus: true,
  linkCheckedAt: true,
  destinationUrl: true,
  affiliateUrl: true,
  affiliateStatus: true,
  productId: true,
  product: {
    select: {
      id: true,
      name: true,
      canonicalUrl: true,
      identityStatus: true,
      productEntityId: true,
      sku: true,
      gtin: true,
      mpn: true,
      model: true,
      brand: { select: { name: true, slug: true, categories: true, officialDomain: true, officialStoreUrl: true } },
    },
  },
} as const satisfies Prisma.CommerceOfferSelect;

export type DealOfferRow = Prisma.CommerceOfferGetPayload<{ select: typeof OFFER_SELECT }>;
export type ClassifiedOffer = DealCandidate<DealOfferRow> & { verdict: OfferDealVerdict };

/**
 * Loads offers (bounded by `take`, newest first) with their product, brand, the product's stored
 * page data, the matched Made4Buyers product's official status / fact summary and its official-site
 * page, and classifies them with classifyOffers.
 */
export async function loadClassifiedOffers(opts: { where?: Prisma.CommerceOfferWhereInput; take?: number; now?: number } = {}): Promise<ClassifiedOffer[]> {
  const now = opts.now ?? Date.now();
  const rows = await db.commerceOffer.findMany({ where: opts.where ?? {}, select: OFFER_SELECT, orderBy: { observedAt: "desc" }, take: opts.take ?? 2000 });
  if (!rows.length) return [];
  // Page data only where it matters (a stated list price: its label and any stated end date).
  const dataIds = [...new Set(rows.filter((r) => r.listPrice != null).map((r) => r.productId))];
  const entityIds = [...new Set(rows.map((r) => r.product.productEntityId).filter((x): x is string => Boolean(x)))];
  const [dataRows, entities, officialProducts] = await Promise.all([
    dataIds.length ? db.commerceProduct.findMany({ where: { id: { in: dataIds } }, select: { id: true, data: true } }) : [],
    entityIds.length ? db.productEntity.findMany({ where: { id: { in: entityIds } }, select: { id: true, officialStatus: true, factSummary: true } }) : [],
    entityIds.length
      ? db.commerceProduct.findMany({
          where: { productEntityId: { in: entityIds }, identityStatus: "MATCHED" },
          select: {
            productEntityId: true,
            canonicalUrl: true,
            brand: { select: { name: true, officialDomain: true, officialStoreUrl: true } },
            offers: { select: { destinationUrl: true, price: true, listPrice: true, currency: true, status: true, observedAt: true, linkStatus: true }, orderBy: { observedAt: "desc" }, take: 5 },
          },
          orderBy: { observedAt: "desc" },
        })
      : [],
  ]);
  const dataById = new Map(dataRows.map((d) => [d.id, d.data]));
  const entityById = new Map(entities.map((e) => [e.id, e]));
  const maxAge = priceMaxAgeMs();
  const hidden = HIDDEN_LINK_STATUSES as readonly string[];
  const officialByEntity = new Map<string, OfficialReference>();
  for (const p of officialProducts) {
    if (!p.productEntityId || officialByEntity.has(p.productEntityId) || !onOfficialDomain(p.canonicalUrl, p.brand)) continue;
    // An official page whose every offer link is gone (BROKEN / OFF_SITE / UNREACHABLE) confirms nothing.
    if (p.offers.length && p.offers.every((o) => hidden.includes(o.linkStatus))) continue;
    const fresh = p.offers.find((o) => o.status === "FRESH" && now - o.observedAt.getTime() <= maxAge && !hidden.includes(o.linkStatus) && o.destinationUrl === p.canonicalUrl) ?? p.offers.find((o) => o.status === "FRESH" && now - o.observedAt.getTime() <= maxAge && !hidden.includes(o.linkStatus));
    officialByEntity.set(p.productEntityId, { url: p.canonicalUrl, price: fresh?.price ?? null, listPrice: fresh?.listPrice ?? null, currency: fresh?.currency ?? null });
  }
  const items = rows.map((r) => {
    const entity = r.product.productEntityId ? entityById.get(r.product.productEntityId) : undefined;
    const product: DealProductInput = {
      ...r.product,
      data: dataById.get(r.productId),
      entity: entity ? { officialStatus: entity.officialStatus, factSummary: entity.factSummary } : null,
      official: r.product.productEntityId ? (officialByEntity.get(r.product.productEntityId) ?? null) : null,
    };
    return { offer: r, product, brand: r.product.brand };
  });
  return classifyOffers(items, now, { maxAgeMs: maxAge, linkKey: offerLinkKey });
}

/** Pure: classified offers → displayable price drops (ACTIVE only; best saving first, then most recent). */
export function toPriceDrops(items: ClassifiedOffer[], reviews: Map<string, { slug: string; title: string }>, images: Map<string, DealCardImage> = new Map()): PriceDrop[] {
  const out: PriceDrop[] = [];
  for (const { offer: r, verdict: v } of items) {
    if (v.status !== "ACTIVE" || !v.saving) continue;
    const priceText = displayPrice(r.price, r.currency);
    const listPriceText = displayPrice(r.listPrice, r.currency);
    const savingText = displayPrice(v.saving.amount, r.currency);
    const productName = displayText(r.product.name);
    const seller = displayText(r.seller);
    const link = offerUrl(r);
    const target = validateOutboundUrl(link.url, { standardPortsOnly: true });
    const url = target.url ? displayUrl(target.url.toString()) : null;
    if (!priceText || !listPriceText || !savingText || !productName || !seller || !url || !r.currency) continue;
    const brand = r.product.brand;
    const brandName = displayText(brand?.name);
    const destDomain = domainOf(r.destinationUrl);
    const official = v.officialStore && Boolean(brandName);
    const where = destDomain ?? offerDomain(url) ?? seller;
    out.push({
      id: r.id,
      productName,
      brandName,
      brandSlug: brand?.slug ?? null,
      categories: brand?.categories ?? [],
      seller,
      official,
      label: official ? `Official ${brandName} store price` : seller,
      price: r.price!,
      listPrice: r.listPrice!,
      listPriceLabel: v.listPriceLabel,
      currency: r.currency,
      priceText,
      listPriceText,
      saving: v.saving.amount,
      savingText,
      savingPercent: v.saving.percent,
      observedAt: r.observedAt.toISOString(),
      linkCheckedAt: r.linkCheckedAt?.toISOString() ?? null,
      verified: v.officialSite ? `Official site (${where})` : `Retailer page (${where}) · product confirmed on the official site`,
      verifiedKind: v.officialSite ? "official" : "retailer",
      sellerDomain: destDomain,
      availability: v.availabilityLabel,
      validUntil: v.validUntil,
      url,
      affiliated: link.affiliated,
      source: v.officialSite ? `${where} (official site)` : `${where} (retailer page)`,
      review: r.product.productEntityId ? (reviews.get(r.product.productEntityId) ?? null) : null,
      image: images.get(r.productId) ?? categoryCardImage(brand?.categories?.[0]),
    });
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

/** Necessary conditions of an ACTIVE drop, as a query (a superset: offerDealStatus decides). */
export function dropCandidateWhere(now = Date.now()): Prisma.CommerceOfferWhereInput {
  return { ...freshOfferWhere(now), currency: DEAL_CURRENCY, price: { gt: 0 }, listPrice: { gt: 0 } };
}

export async function loadPriceDrops(now = Date.now()): Promise<PriceDrop[]> {
  const items = await loadClassifiedOffers({ where: dropCandidateWhere(now), take: 2000, now });
  const active = items.filter((x) => x.verdict.status === "ACTIVE");
  const [reviews, images] = await Promise.all([reviewsFor([...new Set(active.map((x) => x.product.productEntityId).filter((x): x is string => Boolean(x)))]), cardImagesFor(active)]);
  return withCategoryPhotos(toPriceDrops(active, reviews, images));
}

/** Card images for the offers' products (stored data only; on any error every card keeps its category image). */
async function cardImagesFor(items: ClassifiedOffer[]): Promise<Map<string, DealCardImage>> {
  return loadDealCardImages(items.map((x) => x.offer.productId)).catch((error: unknown) => {
    log.warn("deal card images unavailable; category images shown", { error: String(error) });
    return new Map<string, DealCardImage>();
  });
}

export async function loadPromoCodes(now = new Date()): Promise<PromoCode[]> {
  const brands = await db.commerceBrand.findMany({ where: { enabled: true }, select: { id: true, name: true, slug: true, categories: true, officialDomain: true, officialStoreUrl: true }, orderBy: [{ priority: "asc" }, { name: "asc" }] });
  // One query for every brand (a query per brand exhausted the connection pool with 100 brands); the rows are already public (publicCoupons).
  const byBrand = await verifiedCouponsForBrands(brands.map((b) => b.id), now, 6);
  const out: PromoCode[] = [];
  for (const b of brands) for (const c of byBrand.get(b.id) ?? []) {
    const code = toPromoCode(c, b);
    if (code) out.push(code);
  }
  return out.sort((a, b) => Date.parse(b.lastVerifiedAt ?? "0") - Date.parse(a.lastVerifiedAt ?? "0")).slice(0, MAX_PROMO_CODES);
}

type PromoBrand = { name: string; slug: string; categories: string[]; officialDomain: string; officialStoreUrl: string | null };
type PromoRow = { id: string; code: string; discount: string | null; eligibility: string | null; restrictions: string | null; expiresAt: Date | null; lastVerifiedAt: Date | null; sourceUrl: string };

/** Pure: a public coupon row (already passed publicCoupons) → the display shape. Null when a required field is unusable. */
export function toPromoCode(c: PromoRow, b: PromoBrand): PromoCode | null {
  const brandName = displayText(b.name);
  const code = displayText(c.code);
  const tier = couponSourceTier(c.sourceUrl, b);
  if (!brandName || !code || (tier !== 1 && tier !== 2)) return null;
  const sourceUrl = displayUrl(c.sourceUrl);
  const useUrl = sourceUrl && validateOutboundUrl(sourceUrl, { standardPortsOnly: true }).url && onOfficialDomain(sourceUrl, b) ? sourceUrl : null;
  return {
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
    useUrl,
    source: `${domainOf(sourceUrl) ?? b.officialDomain} (official site)`,
    verifiedVia: COUPON_TIER_LABEL[tier],
    sellerDomain: domainOf(sourceUrl),
  };
}

/** Pure: classified offers → current prices (every price-drop rule passed except a stated previous price), one per product and seller, newest first. */
export function toCurrentPrices(items: ClassifiedOffer[], reviews: Map<string, { slug: string; title: string }>, images: Map<string, DealCardImage> = new Map()): CurrentPrice[] {
  const out: CurrentPrice[] = [];
  const seen = new Set<string>();
  const sorted = [...items].sort((a, b) => b.offer.observedAt.getTime() - a.offer.observedAt.getTime());
  for (const { offer: r, verdict: v } of sorted) {
    // VERIFIED solely because the page states no list price: anything else (duplicate, out of stock, refurbished …) is not shown.
    if (v.status !== "VERIFIED" || !v.reasons.length || v.reasons.some((x) => x.code !== "NO_LIST_PRICE")) continue;
    const priceText = displayPrice(r.price, r.currency);
    const productName = displayText(r.product.name);
    const seller = displayText(r.seller);
    const link = offerUrl(r);
    const target = validateOutboundUrl(link.url, { standardPortsOnly: true });
    const url = target.url ? displayUrl(target.url.toString()) : null;
    if (!priceText || !productName || !seller || !url || !r.currency) continue;
    const destDomain = domainOf(r.destinationUrl);
    const key = `${r.product.productEntityId ?? r.product.id}|${destDomain ?? seller.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const brand = r.product.brand;
    const brandName = displayText(brand?.name);
    const official = v.officialStore && Boolean(brandName);
    const where = destDomain ?? offerDomain(url) ?? seller;
    out.push({
      id: r.id,
      productName,
      brandName,
      brandSlug: brand?.slug ?? null,
      categories: brand?.categories ?? [],
      seller,
      official,
      label: official ? `Official ${brandName} store price` : seller,
      price: r.price!,
      currency: r.currency,
      priceText,
      observedAt: r.observedAt.toISOString(),
      linkCheckedAt: r.linkCheckedAt?.toISOString() ?? null,
      verified: v.officialSite ? `Official site (${where})` : `Retailer page (${where}) · product confirmed on the official site`,
      verifiedKind: v.officialSite ? "official" : "retailer",
      sellerDomain: destDomain,
      availability: v.availabilityLabel,
      url,
      affiliated: link.affiliated,
      source: v.officialSite ? `${where} (official site)` : `${where} (retailer page)`,
      review: r.product.productEntityId ? (reviews.get(r.product.productEntityId) ?? null) : null,
      image: images.get(r.productId) ?? categoryCardImage(brand?.categories?.[0]),
    });
    if (out.length >= MAX_CURRENT_PRICES) break;
  }
  return out;
}

export async function loadCurrentPrices(now = Date.now()): Promise<CurrentPrice[]> {
  const items = await loadClassifiedOffers({ where: { ...freshOfferWhere(now), currency: DEAL_CURRENCY, price: { gt: 0 }, listPrice: null }, take: 1000, now });
  const shown = items.filter((x) => x.verdict.status === "VERIFIED");
  const reviews = await reviewsFor([...new Set(shown.map((x) => x.product.productEntityId).filter((x): x is string => Boolean(x)))]);
  const prices = toCurrentPrices(shown, reviews);
  // Images only for the products actually shown (bounded by MAX_CURRENT_PRICES).
  const shownIds = new Set(prices.map((p) => p.id));
  const images = await cardImagesFor(shown.filter((x) => shownIds.has(x.offer.id)));
  const productOf = new Map(shown.map((x) => [x.offer.id, x.offer.productId]));
  return withCategoryPhotos(prices.map((p) => ({ ...p, image: images.get(productOf.get(p.id) ?? "") ?? p.image })));
}

const cachedCurrentPrices = unstable_cache(() => loadCurrentPrices(), ["current-prices-v2"], { revalidate: DEALS_REVALIDATE_SECONDS, tags: [DEALS_TAG] });

/** Cached "Recently verified" prices for /deals (same tag and lifetime as the deals; the price window re-applied on read). */
export async function recentlyVerifiedPrices(now = Date.now()): Promise<CurrentPrice[]> {
  let rows: CurrentPrice[];
  try {
    rows = await cachedCurrentPrices();
  } catch (error) {
    log.debug("current prices cache unavailable; loading directly", { error: String(error) });
    rows = await loadCurrentPrices(now);
  }
  const maxAge = priceMaxAgeMs();
  return rows.filter((p) => now - Date.parse(p.observedAt) <= maxAge);
}

/** Price drops and promo codes, uncached (tests, admin). */
export async function loadOfficialDeals(now = Date.now()): Promise<OfficialDeals> {
  const [drops, codes] = await Promise.all([loadPriceDrops(now), loadPromoCodes(new Date(now))]);
  const times = [...drops.map((d) => Date.parse(d.observedAt)), ...codes.map((c) => Date.parse(c.lastVerifiedAt ?? ""))].filter(Number.isFinite);
  return { drops, codes, checkedAt: times.length ? new Date(Math.max(...times)).toISOString() : null };
}

const cachedDeals = unstable_cache(() => loadOfficialDeals(), ["official-deals-v4"], { revalidate: DEALS_REVALIDATE_SECONDS, tags: [DEALS_TAG] });

/**
 * Cached for pages (data cache, tag "deals", 5 minutes). The cache stores JSON, so time-based rules
 * are re-applied on read: a drop that aged past the price window or whose stated end passed, and a
 * code whose stated expiry passed or whose last verification left the coupon window, since it was
 * cached are dropped.
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
  const couponWindow = couponMaxAgeDays() * 86_400_000;
  return {
    ...deals,
    drops: deals.drops.filter((d) => now - Date.parse(d.observedAt) <= maxAge && (!d.validUntil || validUntilMs(d.validUntil) >= now)),
    codes: deals.codes.filter((c) => (!c.expiresAt || Date.parse(c.expiresAt) > now) && c.lastVerifiedAt !== null && now - Date.parse(c.lastVerifiedAt) <= couponWindow),
  };
}

/**
 * Last resort of the card-image chain: the category's licensed Pexels photo (cached daily; no extra
 * requests per card), labelled illustrative — instead of the bare category placeholder graphic.
 * Cards keep the placeholder only when no category photo is available.
 */
async function withCategoryPhotos<T extends { image: DealCardImage; categories?: string[] }>(rows: T[]): Promise<T[]> {
  const need = rows.filter((r) => r.image.kind === "category");
  if (!need.length) return rows;
  const slugs = [...new Set(need.map((r) => r.categories?.[0]).filter((x): x is string => Boolean(x)))];
  if (!slugs.length) return rows;
  const photos = (await categoryPhotos(slugs).catch(() => ({}))) as Record<string, CategoryPhoto | null>;
  return rows.map((r) => {
    if (r.image.kind !== "category") return r;
    const photo = r.categories?.[0] ? photos[r.categories[0]] : null;
    if (!photo) return r;
    return { ...r, image: { ...r.image, src: photo.url, alt: "", source: "pexels-category", caption: ILLUSTRATIVE_DEAL_CAPTION, attribution: `Photo: ${photo.photographer} / Pexels`, attributionUrl: photo.photographerUrl, sourceUrl: photo.pexelsUrl, width: 800, height: 1200 } };
  });
}
