import { CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";
import { tokenize } from "@/lib/util/text";

/**
 * Pure Sovrn offer normalisation + scoring. The response parser tolerates the field names
 * used by Sovrn Commerce price-comparison responses and common variants; anything without
 * a usable http(s) URL is discarded (never repaired or invented).
 */

export type NormalizedOffer = {
  offerId: string;
  title: string;
  merchantName?: string;
  merchantId?: string;
  offerUrl: string;
  providerAffiliateUrl?: string;
  price?: number;
  currency?: string;
  availability?: "in_stock" | "out_of_stock" | "preorder" | "unknown";
  availabilityRaw?: string;
  brand?: string;
  category?: string;
  imageUrl?: string;
};

export type OfferQuery = {
  productName: string;
  brand?: string | null;
  deviceType?: string | null;
  categorySlug?: string | null;
  modelNumber?: string | null;
};

export type ScoreBreakdown = {
  product: number;
  brand: number;
  model: number;
  category: number;
  availability: number;
  price: number;
  merchant: number;
  total: number;
  weights: Record<string, number>;
  notes: string[];
};

export const SCORE_WEIGHTS = { product: 0.35, brand: 0.15, model: 0.15, category: 0.1, availability: 0.1, price: 0.1, merchant: 0.05 } as const;

type Raw = Record<string, unknown>;

function s(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

function n(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const m = v.replace(/,(?=\d{3}\b)/g, "").match(/\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : undefined;
  }
  if (v && typeof v === "object") return n((v as Raw).amount ?? (v as Raw).value);
  return undefined;
}

function httpUrl(v: unknown): string | undefined {
  const str = s(v);
  if (!str) return undefined;
  try {
    const u = new URL(str);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

const AFFILIATE_HOSTS = [/(^|\.)sovrn\.co$/i, /(^|\.)viglink\.com$/i, /(^|\.)sovrn\.com$/i];

export function isProviderAffiliateUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return AFFILIATE_HOSTS.some((re) => re.test(host));
  } catch {
    return false;
  }
}

function availabilityOf(raw: Raw): NormalizedOffer["availability"] {
  const inStock = raw.inStock ?? raw.in_stock;
  if (inStock === true) return "in_stock";
  if (inStock === false) return "out_of_stock";
  const text = (s(raw.availability) ?? s(raw.stock) ?? s(raw.stockStatus) ?? "").toLowerCase();
  if (!text) return "unknown";
  if (/out[\s_-]?of[\s_-]?stock|unavailable|sold[\s_-]?out|discontinued/.test(text)) return "out_of_stock";
  if (/pre[\s_-]?order|backorder/.test(text)) return "preorder";
  if (/in[\s_-]?stock|available|instock|limited/.test(text)) return "in_stock";
  return "unknown";
}

export function extractOfferArray(payload: unknown): unknown[] | undefined {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Raw;
  for (const key of ["offers", "products", "items", "results", "data", "deals"]) {
    const v = p[key];
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") {
      const nested = extractOfferArray(v);
      if (nested) return nested;
    }
  }
  return undefined;
}

export function normalizeOffers(payload: unknown): NormalizedOffer[] {
  const items = extractOfferArray(payload) ?? [];
  const seen = new Set<string>();
  const out: NormalizedOffer[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Raw;
    const merchant = raw.merchant && typeof raw.merchant === "object" ? (raw.merchant as Raw) : undefined;
    const deeplink = httpUrl(raw.deepLink ?? raw.deeplink ?? raw.affiliateUrl ?? raw.affiliate_url ?? raw.trackingUrl);
    const merchantUrl = httpUrl(raw.merchantUrl ?? raw.merchant_url ?? raw.productUrl ?? raw.url ?? raw.link);
    const offerUrl = merchantUrl ?? deeplink;
    const title = s(raw.name) ?? s(raw.title) ?? s(raw.productName) ?? s(raw.product_name);
    if (!offerUrl || !title) continue;
    const offerId = s(raw.id) ?? s(raw.offerId) ?? s(raw.dealId) ?? s(raw.productId) ?? s(raw.sku) ?? offerUrl;
    if (seen.has(offerId)) continue;
    seen.add(offerId);
    out.push({
      offerId: offerId.slice(0, 300),
      title: title.slice(0, 300),
      merchantName: s(merchant?.name) ?? s(raw.merchantName) ?? s(raw.merchant) ?? s(raw.retailer) ?? s(raw.seller),
      merchantId: s(merchant?.id) ?? s(raw.merchantId),
      offerUrl,
      providerAffiliateUrl: deeplink && (deeplink !== offerUrl || isProviderAffiliateUrl(deeplink)) ? deeplink : undefined,
      price: n(raw.salePrice ?? raw.sale_price ?? raw.price ?? raw.currentPrice ?? raw.retailPrice),
      currency: (s(raw.currency) ?? s((raw.price as Raw | undefined)?.currency))?.toUpperCase(),
      availability: availabilityOf(raw),
      availabilityRaw: s(raw.availability) ?? s(raw.stock),
      brand: s(raw.brand) ?? s((raw.brand as Raw | undefined)?.name),
      category: s(raw.category) ?? s(raw.categoryName),
      imageUrl: httpUrl(raw.image ?? raw.imageUrl ?? raw.thumbnail),
    });
  }
  return out;
}

const STOP = new Set(["the", "a", "an", "and", "with", "for", "of", "in", "new", "review", "gb", "inch", "-", "&"]);
const ACCESSORY_WORDS = /\b(case|cover|protector|skin|sleeve|charger|cable|adapter|stand|mount|holder|strap|band|replacement|refurbished|renewed|parts?)\b/i;

function contentTokens(value: string): string[] {
  return tokenize(value).filter((t) => !STOP.has(t));
}

export function productSimilarity(productName: string, offerTitle: string): number {
  const product = contentTokens(productName);
  if (!product.length) return 0;
  const offer = new Set(contentTokens(offerTitle));
  const matched = product.filter((t) => offer.has(t)).length;
  const containment = matched / product.length;
  const union = new Set([...product, ...offer]).size;
  const jaccard = union ? matched / union : 0;
  return Math.round((0.8 * containment + 0.2 * Math.min(1, jaccard * 2)) * 1000) / 1000;
}

export function scoreOffer(query: OfferQuery, offer: NormalizedOffer, trustedMerchants: string[]): ScoreBreakdown {
  const notes: string[] = [];
  const titleLower = offer.title.toLowerCase();

  const product = productSimilarity(query.productName, offer.title);

  let brand = 0.5;
  if (query.brand) {
    const b = query.brand.toLowerCase();
    if ((offer.brand ?? "").toLowerCase() === b || titleLower.includes(b)) brand = 1;
    else if (offer.brand) {
      brand = 0;
      notes.push(`brand mismatch: offer brand "${offer.brand}"`);
    } else brand = 0.3;
  }

  let model = 0.5;
  if (query.modelNumber) {
    const m = query.modelNumber.toLowerCase().replace(/[\s-]/g, "");
    model = titleLower.replace(/[\s-]/g, "").includes(m) ? 1 : 0;
    if (!model) notes.push(`model ${query.modelNumber} not in offer title`);
  }

  let category = 0.5;
  const def = query.categorySlug ? CATEGORY_BY_SLUG.get(query.categorySlug) : undefined;
  const accessoryTitle = query.categorySlug === "wearables" ? ACCESSORY_WORDS.test(offer.title.replace(/\b(sport |solo |)(band|strap|loop)\b/gi, "")) : ACCESSORY_WORDS.test(offer.title);
  if (def && query.categorySlug !== "accessories" && accessoryTitle) {
    category = 0;
    notes.push("offer looks like an accessory/replacement, not the reviewed product");
  } else if (def) {
    const haystack = `${offer.title} ${offer.category ?? ""}`.toLowerCase();
    category = def.signals.some(([p]) => haystack.includes(p.toLowerCase())) || (query.deviceType && haystack.includes(query.deviceType.toLowerCase())) ? 1 : 0.5;
  }

  const availability = offer.availability === "in_stock" ? 1 : offer.availability === "preorder" ? 0.6 : offer.availability === "out_of_stock" ? 0 : 0.5;
  if (availability === 0) notes.push("offer is out of stock");
  const price = offer.price !== undefined && offer.price > 0 ? 1 : 0;
  const merchantName = (offer.merchantName ?? "").toLowerCase();
  const merchant = !merchantName ? 0.3 : trustedMerchants.some((m) => merchantName.includes(m)) ? 1 : 0.6;

  const total =
    product * SCORE_WEIGHTS.product +
    brand * SCORE_WEIGHTS.brand +
    model * SCORE_WEIGHTS.model +
    category * SCORE_WEIGHTS.category +
    availability * SCORE_WEIGHTS.availability +
    price * SCORE_WEIGHTS.price +
    merchant * SCORE_WEIGHTS.merchant;

  return { product, brand, model, category, availability, price, merchant, total: Math.round(total * 1000) / 1000, weights: { ...SCORE_WEIGHTS }, notes };
}

export type RankedOffer = { offer: NormalizedOffer; breakdown: ScoreBreakdown; viable: boolean };

/** Scores, filters and deterministically ranks offers. Ties break on availability, lower price, then offerId. */
export function rankOffers(query: OfferQuery, offers: NormalizedOffer[], opts: { minScore: number; trustedMerchants: string[] }): RankedOffer[] {
  return offers
    .map((offer) => {
      const breakdown = scoreOffer(query, offer, opts.trustedMerchants);
      const viable = breakdown.total >= opts.minScore && breakdown.product >= 0.5 && breakdown.brand > 0 && breakdown.category > 0;
      return { offer, breakdown, viable };
    })
    .sort(
      (a, b) =>
        Number(b.viable) - Number(a.viable) ||
        b.breakdown.total - a.breakdown.total ||
        b.breakdown.availability - a.breakdown.availability ||
        (a.offer.price ?? Infinity) - (b.offer.price ?? Infinity) ||
        a.offer.offerId.localeCompare(b.offer.offerId),
    );
}

export function selectionReason(best: RankedOffer, runnerUp?: RankedOffer): string {
  const b = best.breakdown;
  const parts = [
    `score ${b.total}`,
    `product ${b.product}`,
    `brand ${b.brand}`,
    `model ${b.model}`,
    `category ${b.category}`,
    `availability ${b.availability}`,
    `price ${b.price}`,
    `merchant ${b.merchant}`,
  ];
  const vs = runnerUp ? `; beat ${runnerUp.offer.offerId} (${runnerUp.breakdown.total})` : "; only viable offer";
  return `Selected ${best.offer.offerId} from ${best.offer.merchantName ?? "unknown merchant"}: ${parts.join(", ")}${vs}`;
}

export function buildQueryString(q: OfferQuery): string {
  const name = q.productName.trim();
  const brand = q.brand?.trim();
  const base = brand && !name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${name}` : name;
  const model = q.modelNumber && !base.toLowerCase().includes(q.modelNumber.toLowerCase()) ? ` ${q.modelNumber}` : "";
  return (base + model).replace(/\s+/g, " ").slice(0, 200);
}
