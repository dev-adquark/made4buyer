import { config } from "@/lib/config";
import { validateOutboundUrl } from "@/lib/net/safe-fetch";
import { classifySource, registrableDomain } from "@/lib/products/page-extract";
import { canonicalDestination, displayAmount, displayText } from "@/lib/public/display";
import { couponMaxAgeDays } from "./coupons";
import { HIDDEN_LINK_STATUSES } from "./link-check";

/**
 * Deal status: the ONE decision of whether a stored offer or promo code may be shown as a deal.
 * /deals, the homepage "Verified deals" rail and Admin → Commerce all call these functions; nothing
 * else decides it. Pure (no database access): callers load the rows and pass them in.
 *
 * Offer statuses (highest precedence first; every problem found is listed in `reasons`):
 *   BROKEN       the link check found the destination BROKEN, OFF_SITE or UNREACHABLE
 *   INVALID      not USD; no price or price ≤ 0; a stated list price not above the price; no product
 *                identity; the page is neither on the brand's official domain nor a known retailer;
 *                an unusable link or seller; an observation dated in the future
 *   EXPIRED      not FRESH, observed more than PRODUCT_PRICE_MAX_AGE_HOURS (48 h) ago, or the page's
 *                own stated promotion end (priceValidUntil / validThrough) has passed
 *   CONFLICTING  the official site contradicts it: the product's official verification is MISMATCH
 *                (the official page is a different variant), the product's price/list-price fact
 *                summary is CONFLICTING, or a retailer's stated regular price is above the regular
 *                price the official site states (an inflated "was" price). A retailer's CURRENT
 *                price differing from the official price is normal and is not a conflict.
 *   UNVERIFIED   a retailer page whose product has no official-site confirmation (the product's
 *                officialStatus is not VERIFIED and no MATCHED official-domain page exists for it)
 *   VERIFIED     valid and verified, but not an active price drop: no stated list price, out of
 *                stock / sold out / discontinued, an availability we cannot read, or a duplicate of
 *                a deal already listed
 *   ACTIVE       everything above passed and the page states a list price above the price: shown.
 *
 * Coupon statuses: see couponDealStatus.
 */

export const DEAL_STATUSES = ["ACTIVE", "VERIFIED", "EXPIRED", "INVALID", "BROKEN", "CONFLICTING", "UNVERIFIED"] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];

/** Precedence when several problems apply (first wins). */
const PRECEDENCE: readonly DealStatus[] = ["BROKEN", "INVALID", "EXPIRED", "CONFLICTING", "UNVERIFIED", "VERIFIED", "ACTIVE"];

export const DEAL_REASON_STATUS = {
  // offers
  LINK_BROKEN: "BROKEN",
  NOT_USD: "INVALID",
  NO_PRICE: "INVALID",
  LIST_NOT_ABOVE_PRICE: "INVALID",
  NO_IDENTITY: "INVALID",
  UNKNOWN_SELLER_DOMAIN: "INVALID",
  BAD_URL: "INVALID",
  NO_SELLER: "INVALID",
  FUTURE_OBSERVATION: "INVALID",
  NOT_FRESH: "EXPIRED",
  STALE: "EXPIRED",
  PROMOTION_ENDED: "EXPIRED",
  OFFICIAL_MISMATCH: "CONFLICTING",
  PRICE_FACT_CONFLICTING: "CONFLICTING",
  LIST_PRICE_CONTRADICTS_OFFICIAL: "CONFLICTING",
  NO_OFFICIAL_CONFIRMATION: "UNVERIFIED",
  NO_LIST_PRICE: "VERIFIED",
  OUT_OF_STOCK: "VERIFIED",
  AVAILABILITY_UNCLEAR: "VERIFIED",
  DUPLICATE: "VERIFIED",
  // coupons
  NO_CODE: "INVALID",
  COUPON_INVALID: "INVALID",
  COUPON_EXPIRED: "EXPIRED",
  COUPON_NOT_RESEEN: "EXPIRED",
  COUPON_CONFLICTING: "CONFLICTING",
  COUPON_UNVERIFIED: "UNVERIFIED",
  COUPON_NOT_FIRST_PARTY: "UNVERIFIED",
  COUPON_NOT_STARTED: "VERIFIED",
} as const satisfies Record<string, DealStatus>;
export type DealReasonCode = keyof typeof DEAL_REASON_STATUS;
export type DealReason = { code: DealReasonCode; message: string };

/** Short labels for Admin. */
export const DEAL_REASON_LABEL: Record<DealReasonCode, string> = {
  LINK_BROKEN: "link broken / off-site / unreachable",
  NOT_USD: "not USD",
  NO_PRICE: "no price",
  LIST_NOT_ABOVE_PRICE: "list price not above price",
  NO_IDENTITY: "no product identity",
  UNKNOWN_SELLER_DOMAIN: "not official domain or known retailer",
  BAD_URL: "unusable link",
  NO_SELLER: "no seller",
  FUTURE_OBSERVATION: "observation time invalid",
  NOT_FRESH: "marked stale",
  STALE: "older than the price window",
  PROMOTION_ENDED: "stated promotion end passed",
  OFFICIAL_MISMATCH: "official page is a different variant",
  PRICE_FACT_CONFLICTING: "price facts conflict",
  LIST_PRICE_CONTRADICTS_OFFICIAL: "regular price above the official site's",
  NO_OFFICIAL_CONFIRMATION: "retailer, not confirmed on official site",
  NO_LIST_PRICE: "no stated list price (not a drop)",
  OUT_OF_STOCK: "out of stock / sold out / discontinued",
  AVAILABILITY_UNCLEAR: "availability not purchasable",
  DUPLICATE: "duplicate of a listed deal",
  NO_CODE: "no code",
  COUPON_INVALID: "invalid / withdrawn",
  COUPON_EXPIRED: "expired",
  COUPON_NOT_RESEEN: "not re-seen within the max age",
  COUPON_CONFLICTING: "conflicting observations",
  COUPON_UNVERIFIED: "unverified / unknown",
  COUPON_NOT_FIRST_PARTY: "source not on the official domain",
  COUPON_NOT_STARTED: "not started yet",
};

// ── Inputs ────────────────────────────────────────────────────────────────

export type DealOfferInput = {
  id?: string;
  seller: string | null;
  /** MANUFACTURER | RETAILER */
  sellerType: string;
  destinationUrl: string;
  affiliateUrl?: string | null;
  affiliateStatus?: string | null;
  price: number | null;
  listPrice: number | null;
  currency: string | null;
  availability: string | null;
  observedAt: Date | string;
  status: string;
  linkStatus: string | null;
  linkCheckedAt?: Date | string | null;
};

/** The official site's own data for the product (another CommerceProduct on the brand's official domain, MATCHED to the same product). */
export type OfficialReference = { url: string; price: number | null; listPrice: number | null; currency: string | null };

export type DealProductInput = {
  id?: string;
  name: string | null;
  canonicalUrl?: string | null;
  identityStatus: string;
  productEntityId: string | null;
  sku?: string | null;
  gtin?: string | null;
  mpn?: string | null;
  model?: string | null;
  /** CommerceProduct.data: the page's offers exactly as stated (list price type, stated price end). */
  data?: unknown;
  /** The Made4Buyers product it is matched to. */
  entity?: { officialStatus: string | null; factSummary?: unknown } | null;
  /** A MATCHED official-domain page for the same product, with its fresh offer price when known. */
  official?: OfficialReference | null;
};

export type DealBrandInput = { name: string; officialDomain: string; officialStoreUrl?: string | null } | null | undefined;

export type DealStatusOptions = { maxAgeMs?: number };

export type OfferDealVerdict = {
  status: DealStatus;
  /** Empty for ACTIVE. */
  reasons: DealReason[];
  /** The destination is on the brand's official domain (or its official store's). */
  officialSite: boolean;
  /** Official site AND sold by the manufacturer: may be labelled "Official <Brand> store price". */
  officialStore: boolean;
  /** For a retailer page: the product's identity is confirmed on the official site. */
  officialConfirmed: boolean;
  saving: { amount: number; percent: number } | null;
  /** How the page labelled the previous price: "Regular price" (ListPrice), "Was" (StrikethroughPrice), or "List price" when the stored data does not say. */
  listPriceLabel: string;
  /** The page's stated end of this price, ISO, when it stated one. */
  validUntil: string | null;
  /** Readable availability when the page stated a purchasable one ("In stock", "Pre-order" …); null when unstated. */
  availabilityLabel: string | null;
};

// ── Helpers ───────────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;
/** Absolute tolerance for comparing two stated regular prices (cents of rounding, per-locale display). */
const PRICE_TOLERANCE = (a: number) => Math.max(1, a * 0.01);

export const defaultPriceMaxAgeMs = () => config.commerce.priceMaxAgeHours() * HOUR_MS;

function time(v: Date | string | null | undefined): number {
  if (v == null) return NaN;
  return v instanceof Date ? v.getTime() : Date.parse(v);
}

/** Floors to the cent (with a tiny epsilon for binary float noise): never rounds a saving up. */
function floorCents(n: number): number {
  return Math.floor(n * 100 + 1e-6) / 100;
}

/** The saving from two stated prices, or null unless list > price > 0 (amount floored to the cent, percent to a whole number). */
export function computeSaving(price: unknown, listPrice: unknown): { amount: number; percent: number } | null {
  const p = displayAmount(price);
  const l = displayAmount(listPrice);
  if (p === null || l === null || !(l > p)) return null;
  const amount = floorCents(l - p);
  if (amount <= 0) return null;
  return { amount, percent: Math.floor(((l - p) / l) * 100 + 1e-9) };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function bareDomain(d: string | null | undefined): string | null {
  const s = d?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  return s ? registrableDomain(s) : null;
}

/** Registrable domains of the brand's own sites (officialDomain, and the official store's when set). */
export function officialDomainsOf(brand: DealBrandInput): Set<string> {
  const out = new Set<string>();
  if (!brand) return out;
  const a = bareDomain(brand.officialDomain);
  if (a) out.add(a);
  const storeHost = brand.officialStoreUrl ? hostOf(brand.officialStoreUrl) : null;
  if (storeHost) out.add(registrableDomain(storeHost.replace(/^www\./, "")));
  return out;
}

export function onOfficialDomain(url: string | null | undefined, brand: DealBrandInput): boolean {
  const host = url ? hostOf(url) : null;
  return !!host && officialDomainsOf(brand).has(registrableDomain(host.replace(/^www\./, "")));
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The page's own statement of this offer in CommerceProduct.data.offers (same amounts; same URL when the page gave one). */
function statedOffer(product: DealProductInput, offer: DealOfferInput): { listPriceType?: string; priceValidUntil?: string } | null {
  const data = isObj(product.data) ? product.data : null;
  const offers = data && Array.isArray(data.offers) ? data.offers.filter(isObj) : [];
  const same = offers.filter((o) => o.price === offer.price && (o.listPrice ?? null) === (offer.listPrice ?? null));
  if (!same.length) return null;
  const dest = canonicalDestination(offer.destinationUrl);
  const canon = canonicalDestination(product.canonicalUrl ?? (typeof data?.pageUrl === "string" ? data.pageUrl : null));
  const byUrl = same.find((o) => (typeof o.url === "string" ? canonicalDestination(o.url) : canon) === dest);
  const o = byUrl ?? (same.length === 1 ? same[0] : null);
  if (!o) return null;
  return { listPriceType: typeof o.listPriceType === "string" ? o.listPriceType : undefined, priceValidUntil: typeof o.priceValidUntil === "string" ? o.priceValidUntil : undefined };
}

/** A stated date-only end ("2026-10-31") is valid through the end of that day (UTC); a date-time as stated. */
export function validUntilMs(stated: string): number {
  const t = Date.parse(stated);
  if (!Number.isFinite(t)) return NaN;
  return /^\d{4}-\d{2}-\d{2}$/.test(stated.trim()) ? t + 24 * HOUR_MS - 1 : t;
}

const AVAILABLE: Record<string, string> = {
  instock: "In stock",
  preorder: "Pre-order",
  presale: "Pre-sale",
  limitedavailability: "Limited availability",
  backorder: "Backorder",
  onlineonly: "Online only",
};
const UNAVAILABLE: Record<string, string> = { outofstock: "out of stock", soldout: "sold out", discontinued: "discontinued" };

function availabilityKey(v: string | null | undefined): string | null {
  const k = v?.replace(/^https?:\/\/(www\.)?schema\.org\//i, "").toLowerCase().replace(/[^a-z]/g, "");
  return k ? k : null;
}

/** The official site's regular price for this product, USD: its offer's list price (else its price), else its MANUFACTURER list-price/price fact. */
function officialRegularPrice(product: DealProductInput): number | null {
  const o = product.official;
  if (o && (o.currency ?? "USD").toUpperCase() === "USD") {
    const v = displayAmount(o.listPrice) ?? displayAmount(o.price);
    if (v !== null) return v;
  }
  const fields = isObj(product.entity?.factSummary) && isObj(product.entity!.factSummary.fields) ? product.entity!.factSummary.fields : null;
  for (const f of ["listPrice", "price"]) {
    const x = fields && isObj(fields[f]) ? fields[f] : null;
    if (!x || x.source !== "MANUFACTURER" || !["VERIFIED", "SUPPORTED"].includes(String(x.status))) continue;
    if (x.unit != null && String(x.unit).toUpperCase() !== "USD") continue;
    const v = displayAmount(x.value);
    if (v !== null) return v;
  }
  return null;
}

function priceFactConflicting(product: DealProductInput): string | null {
  const s = product.entity?.factSummary;
  const fields = isObj(s) && isObj(s.fields) ? s.fields : null;
  for (const f of ["price", "listPrice"]) {
    const x = fields && isObj(fields[f]) ? fields[f] : null;
    if (x?.status === "CONFLICTING") return typeof x.note === "string" ? `${f}: ${x.note}` : f;
  }
  if (isObj(s) && Array.isArray(s.conflicting) && s.conflicting.some((f) => f === "price" || f === "listPrice")) return "price";
  return null;
}

function hasIdentity(p: DealProductInput): boolean {
  if (!displayText(p.name)) return false;
  if (p.identityStatus === "MATCHED" || p.productEntityId) return true;
  return [p.sku, p.gtin, p.mpn, p.model].some((v) => typeof v === "string" && v.trim().length >= 2);
}

const usd = (n: number) => `$${n.toFixed(2)}`;

function statusOf(reasons: DealReason[]): DealStatus {
  if (!reasons.length) return "ACTIVE";
  const present = new Set<DealStatus>(reasons.map((r) => DEAL_REASON_STATUS[r.code]));
  return PRECEDENCE.find((s) => present.has(s)) ?? "ACTIVE";
}

// ── Offers ────────────────────────────────────────────────────────────────

/** The status of one stored offer as a public price drop. `now` in ms or a Date. */
export function offerDealStatus(offer: DealOfferInput, product: DealProductInput, brand: DealBrandInput, now: number | Date = Date.now(), opts: DealStatusOptions = {}): OfferDealVerdict {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const maxAge = opts.maxAgeMs ?? defaultPriceMaxAgeMs();
  const reasons: DealReason[] = [];
  const add = (code: DealReasonCode, message: string) => reasons.push({ code, message });

  // Link
  if ((HIDDEN_LINK_STATUSES as readonly string[]).includes(offer.linkStatus ?? "UNCHECKED")) add("LINK_BROKEN", `link check: ${offer.linkStatus}`);

  // Validity
  const currency = offer.currency?.trim().toUpperCase() ?? null;
  if (currency !== "USD") add("NOT_USD", currency ? `priced in ${currency}, not USD` : "no currency stated");
  const price = displayAmount(offer.price);
  const listPrice = offer.listPrice == null ? null : displayAmount(offer.listPrice);
  if (price === null) add("NO_PRICE", "no positive price stated");
  const saving = price !== null && listPrice !== null ? computeSaving(price, listPrice) : null;
  if (offer.listPrice != null && price !== null && !saving) add("LIST_NOT_ABOVE_PRICE", `stated list price ${offer.listPrice} is not above the price ${price}`);
  if (!hasIdentity(product)) add("NO_IDENTITY", "the product has no identity (not matched, no stated identifier)");
  if (!displayText(offer.seller)) add("NO_SELLER", "no seller name");
  const officialSite = onOfficialDomain(offer.destinationUrl, brand);
  const linkUrl = offer.affiliateUrl && (offer.affiliateStatus == null || offer.affiliateStatus === "AFFILIATED") ? offer.affiliateUrl : offer.destinationUrl;
  if (!validateOutboundUrl(linkUrl, { standardPortsOnly: true }).url) add("BAD_URL", "the link is not a usable public http(s) URL");
  const knownRetailer = !officialSite && classifySource(offer.destinationUrl, brand?.name ?? null) === "RETAILER";
  if (!officialSite && !knownRetailer) add("UNKNOWN_SELLER_DOMAIN", `${hostOf(offer.destinationUrl) ?? "the page"} is neither the brand's official domain nor a known retailer`);

  // Freshness and stated promotion end
  const observed = time(offer.observedAt);
  if (!Number.isFinite(observed) || observed > nowMs + HOUR_MS) add("FUTURE_OBSERVATION", "observation time is missing or in the future");
  if (offer.status !== "FRESH") add("NOT_FRESH", `offer status ${offer.status}`);
  else if (Number.isFinite(observed) && nowMs - observed > maxAge) add("STALE", `observed ${Math.floor((nowMs - observed) / HOUR_MS)} h ago (limit ${Math.round(maxAge / HOUR_MS)} h)`);
  const stated = statedOffer(product, offer);
  const validUntil = stated?.priceValidUntil && Number.isFinite(validUntilMs(stated.priceValidUntil)) ? stated.priceValidUntil : null;
  if (validUntil && validUntilMs(validUntil) < nowMs) add("PROMOTION_ENDED", `the page states the price was valid until ${validUntil}`);

  // Official-site evidence
  const officialConfirmed = officialSite || product.entity?.officialStatus === "VERIFIED" || !!product.official;
  if (product.entity?.officialStatus === "MISMATCH") add("OFFICIAL_MISMATCH", "the official site's page is a different variant of this product");
  const factConflict = priceFactConflicting(product);
  if (factConflict) add("PRICE_FACT_CONFLICTING", `the product's price facts conflict (${factConflict})`.slice(0, 300));
  if (!officialSite && listPrice !== null) {
    const regular = officialRegularPrice(product);
    if (regular !== null && listPrice - regular > PRICE_TOLERANCE(regular)) add("LIST_PRICE_CONTRADICTS_OFFICIAL", `stated regular price ${usd(listPrice)} is above the official site's ${usd(regular)}`);
  }
  if (!officialSite && !officialConfirmed) add("NO_OFFICIAL_CONFIRMATION", "retailer page; the product is not confirmed on the brand's official site");

  // Deal shape
  if (offer.listPrice == null) add("NO_LIST_PRICE", "the page states no list/regular price: a price, not a drop");
  const av = availabilityKey(offer.availability);
  if (av && UNAVAILABLE[av]) add("OUT_OF_STOCK", `the page states it is ${UNAVAILABLE[av]}`);
  else if (av && !AVAILABLE[av]) add("AVAILABILITY_UNCLEAR", `stated availability "${String(offer.availability).slice(0, 60)}" is not a purchasable state`);

  const type = stated?.listPriceType;
  return {
    status: statusOf(reasons),
    reasons,
    officialSite,
    officialStore: officialSite && offer.sellerType === "MANUFACTURER",
    officialConfirmed,
    saving,
    listPriceLabel: type === "StrikethroughPrice" ? "Was" : type === "ListPrice" ? "Regular price" : "List price",
    validUntil,
    availabilityLabel: av && AVAILABLE[av] ? AVAILABLE[av] : null,
  };
}

export type DealCandidate<O extends DealOfferInput = DealOfferInput> = { offer: O; product: DealProductInput; brand: DealBrandInput };

/**
 * Statuses for a set of offers, with duplicates resolved: among offers that are otherwise ACTIVE,
 * one listing per canonical destination, per (product, seller domain) and per (product, seller,
 * currency, amount): official first, then the bigger saving, then the most recent. The others
 * become VERIFIED with reason DUPLICATE.
 */
export function classifyOffers<O extends DealOfferInput>(items: Array<DealCandidate<O>>, now: number | Date = Date.now(), opts: DealStatusOptions & { linkKey?: (url: string) => string | null } = {}): Array<DealCandidate<O> & { verdict: OfferDealVerdict }> {
  const linkKey = opts.linkKey ?? ((u: string) => canonicalDestination(u));
  const out = items.map((it) => ({ ...it, verdict: offerDealStatus(it.offer, it.product, it.brand, now, opts) }));
  const active = out
    .filter((x) => x.verdict.status === "ACTIVE")
    .sort((a, b) => Number(b.verdict.officialStore) - Number(a.verdict.officialStore) || (b.verdict.saving?.percent ?? 0) - (a.verdict.saving?.percent ?? 0) || (b.verdict.saving?.amount ?? 0) - (a.verdict.saving?.amount ?? 0) || time(b.offer.observedAt) - time(a.offer.observedAt));
  const seen = new Map<string, string>();
  for (const x of active) {
    const o = x.offer;
    const url = o.affiliateUrl && (o.affiliateStatus == null || o.affiliateStatus === "AFFILIATED") ? o.affiliateUrl : o.destinationUrl;
    const productKey = x.product.productEntityId ?? x.product.id ?? x.product.canonicalUrl ?? "";
    const host = hostOf(url);
    const seller = (displayText(o.seller) ?? "").toLowerCase();
    const keys = [`url:${linkKey(url) ?? url}`, `domain:${productKey}|${host ? registrableDomain(host.replace(/^www\./, "")) : seller}`, `price:${productKey}|${seller}|${o.currency}|${o.price}`];
    const dup = keys.map((k) => seen.get(k)).find(Boolean);
    if (dup) {
      x.verdict = { ...x.verdict, status: "VERIFIED", reasons: [{ code: "DUPLICATE", message: `same deal already listed (offer ${dup})` }] };
      continue;
    }
    for (const k of keys) seen.set(k, o.id ?? url);
  }
  return out;
}

// ── Coupons ───────────────────────────────────────────────────────────────

export type DealCouponInput = {
  code: string | null;
  status: string;
  startsAt: Date | string | null;
  expiresAt: Date | string | null;
  lastVerifiedAt: Date | string | null;
  sourceUrl: string | null;
  /** When given, the source page must be on the brand's official domain. */
  brand?: DealBrandInput;
};

export type CouponDealVerdict = { status: DealStatus; reasons: DealReason[] };

/**
 * ACTIVE only for a VERIFIED code that has started, has not expired, and was re-seen on the brand's
 * official page within COMMERCE_COUPON_MAX_AGE_DAYS (7 days). Otherwise:
 *   INVALID      no code, or stored INVALID (withdrawn from the official page / marked invalid)
 *   EXPIRED      stored EXPIRED, its stated expiry has passed, or not re-seen within the max age
 *   CONFLICTING  stored CONFLICTING (first-party observations disagree)
 *   UNVERIFIED   stored UNVERIFIED / UNKNOWN, or its source page is not on the brand's official domain
 *   VERIFIED     verified, but its stated start date is still ahead
 */
export function couponDealStatus(coupon: DealCouponInput, now: number | Date = Date.now(), opts: { maxAgeDays?: number } = {}): CouponDealVerdict {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const reasons: DealReason[] = [];
  const add = (code: DealReasonCode, message: string) => reasons.push({ code, message });
  if (!displayText(coupon.code)) add("NO_CODE", "no code");
  if (coupon.status === "INVALID") add("COUPON_INVALID", "marked INVALID (no longer published, or marked invalid)");
  const expires = time(coupon.expiresAt);
  if (coupon.status === "EXPIRED") add("COUPON_EXPIRED", "marked EXPIRED");
  else if (Number.isFinite(expires) && expires <= nowMs) add("COUPON_EXPIRED", `stated expiry ${new Date(expires).toISOString()} has passed`);
  if (coupon.status === "CONFLICTING") add("COUPON_CONFLICTING", "first-party observations disagree");
  if (!["VERIFIED", "INVALID", "EXPIRED", "CONFLICTING"].includes(coupon.status)) add("COUPON_UNVERIFIED", `status ${coupon.status}`);
  if (coupon.brand && !onOfficialDomain(coupon.sourceUrl, coupon.brand)) add("COUPON_NOT_FIRST_PARTY", "the source page is not on the brand's official domain");
  if (coupon.status === "VERIFIED") {
    const maxAge = (opts.maxAgeDays ?? couponMaxAgeDays()) * 24 * HOUR_MS;
    const seen = time(coupon.lastVerifiedAt);
    if (!Number.isFinite(seen) || nowMs - seen > maxAge) add("COUPON_NOT_RESEEN", Number.isFinite(seen) ? `last seen on the official page ${Math.floor((nowMs - seen) / (24 * HOUR_MS))} days ago` : "never re-verified");
    const starts = time(coupon.startsAt);
    if (Number.isFinite(starts) && starts > nowMs) add("COUPON_NOT_STARTED", `starts ${new Date(starts).toISOString()}`);
  }
  return { status: statusOf(reasons), reasons };
}

/** Counts by status plus the most common reason codes per status (Admin). */
export function summarizeStatuses(verdicts: Array<{ status: DealStatus; reasons: DealReason[] }>, topN = 3) {
  const byStatus = Object.fromEntries(DEAL_STATUSES.map((s) => [s, 0])) as Record<DealStatus, number>;
  const reasonCounts = new Map<DealStatus, Map<DealReasonCode, number>>();
  for (const v of verdicts) {
    byStatus[v.status]++;
    const m = reasonCounts.get(v.status) ?? new Map<DealReasonCode, number>();
    // Only the reasons that put it in this status (secondary problems are listed on the row itself).
    for (const r of v.reasons) if (DEAL_REASON_STATUS[r.code] === v.status) m.set(r.code, (m.get(r.code) ?? 0) + 1);
    reasonCounts.set(v.status, m);
  }
  const topReasons = Object.fromEntries(
    DEAL_STATUSES.map((s) => [
      s,
      [...(reasonCounts.get(s) ?? new Map<DealReasonCode, number>()).entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, topN)
        .map(([code, count]) => ({ code, count })),
    ]),
  ) as Record<DealStatus, Array<{ code: DealReasonCode; count: number }>>;
  return { total: verdicts.length, byStatus, topReasons };
}
