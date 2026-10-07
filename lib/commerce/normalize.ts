import { normalizeUrl } from "@/lib/pipeline/apify";
import { extractOffersFromJsonLd, extractProductFromJsonLd, registrableDomain, type JsonLdOffer } from "@/lib/products/page-extract";
import type { ExtractedProduct } from "@/lib/products/types";
import { evaluatePriceBlocks, type HtmlListPriceType } from "./html-price";
import { readShopifyProduct, variantParam } from "./shopify";
import { extractOfficialProductImages, type StoredDealImage } from "@/lib/images/deal-image";

/**
 * Turns one raw commerce record (what PRODUCT_PAGE_FUNCTION returned, stored unchanged in
 * CommerceRawRecord) into a normalized product. The product itself is read by the same extractor
 * as HTML product pages (extractProductFromJsonLd); spec tables and images are carried over as the
 * page stated them. A field the page does not state stays absent; nothing is guessed.
 *
 * Price sources, strongest first:
 *  1. Shopify product JSON (lib/commerce/shopify.ts): one variant (the URL's ?variant=, else the first
 *     available), its price, its compare-at price as listPrice ("CompareAtPrice"), its availability,
 *     SKU and validated GTIN. The product is that variant: name "<title> – <variant>" when the product
 *     has several variants, and the canonical URL carries ?variant=<id> so variants never mix.
 *  2. JSON-LD offers (ListPrice / StrikethroughPrice priceSpecification), else product: meta tags.
 *  3. Only when neither states a previous price: the page's main price block (lib/commerce/html-price.ts),
 *     confidence 0.8, extractionMethod "apify-web-scraper:html-price-block".
 */

export type CommerceSpec = { name: string; value: string; source: "json-ld" | "page-table" };
export type CommerceImage = { src: string; alt: string | null };
export type CommerceListPriceType = NonNullable<JsonLdOffer["listPriceType"]> | "CompareAtPrice" | HtmlListPriceType;
export type CommerceOfferInput = Omit<JsonLdOffer, "listPriceType"> & {
  /** How the merchant marked the previous price: ListPrice / StrikethroughPrice (JSON-LD), CompareAtPrice (Shopify), StrikethroughPrice / WasPrice / RegularPrice (HTML price block). */
  listPriceType?: CommerceListPriceType;
  /** The page's own label for the previous price ("Was", "Regular price" …), HTML price block only. */
  listPriceLabel?: string;
  /** Promotion text shown in the main price block. */
  promotionText?: string;
  source: "json-ld" | "meta" | "shopify";
  /** Set when the offer's previous price did not come from the record's main extraction (e.g. the HTML price block). */
  extractionMethod?: string;
  /** Confidence of the stated previous price: 1 for Shopify/JSON-LD, 0.8 for the HTML price block. */
  confidence?: number;
};

export const SHOPIFY_METHOD = "apify-web-scraper:shopify-product-json";
export const HTML_PRICE_METHOD = "apify-web-scraper:html-price-block";

export type NormalizedCommerceRecord =
  | {
      ok: true;
      pageUrl: string;
      /** Canonical URL (the page's own canonical when it is on the same site, else the page URL), normalized. */
      canonicalUrl: string;
      product: ExtractedProduct;
      specs: CommerceSpec[];
      images: CommerceImage[];
      /** The page's own photo(s) of this exact product/variant, on its own domain (lib/images/deal-image.ts). */
      productImages: StoredDealImage[];
      offers: CommerceOfferInput[];
      breadcrumbs: string[];
      lang?: string;
      /** e.g. "apify-web-scraper:json-ld", "apify-web-scraper:json-ld+meta", "apify-web-scraper:shopify-product-json". */
      extractionMethod: string;
      /** PRODUCT (a start product URL), LISTING (a deal page that is itself a product page) or LINKED (reached by a followed link). */
      crawlLabel: "PRODUCT" | "LISTING" | "LINKED";
      /** The URL the crawler requested (before redirects). */
      requestUrl: string;
      /** Why a secondary price source was not used (Shopify JSON, HTML price block); diagnostics only. */
      notes: string[];
    }
  | { ok: false; code: "NOT_COMMERCE_RECORD" | "INVALID_URL" | "NO_PRODUCT"; reason: string; pageUrl?: string };

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function sameSite(a: string, b: string): boolean {
  try {
    return registrableDomain(new URL(a).hostname.toLowerCase()) === registrableDomain(new URL(b).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function metaOf(v: unknown): Record<string, string> {
  if (!isObj(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) if (typeof x === "string" && x.trim()) out[k] = x;
  return out;
}

export const EXTRACTION_PREFIX = "apify-web-scraper";

export type NormalizeContext = { market?: string | null };

/**
 * The page's own JSON-LD offer for one Shopify variant: an Offer whose url names ?variant=<id>, else
 * one whose (or whose product's) sku is the variant's SKU. Several matches must agree on price and
 * currency (themes often repeat a variant); otherwise none.
 */
export function jsonLdVariantOffer(blocks: unknown[], pageUrl: string, variantId: string, sku: string | null): { offer: JsonLdOffer | null; conflict: boolean } {
  const byUrl: Array<Record<string, unknown>> = [];
  const bySku: Array<Record<string, unknown>> = [];
  const seen = new Set<object>();
  const visit = (o: Record<string, unknown>, productSku: string | undefined) => {
    if (seen.has(o)) return;
    seen.add(o);
    const url = str(o.url);
    if (url && variantParam(new URL(url, pageUrl).toString()) === variantId) byUrl.push(o);
    else if (sku && (str(o.sku) === sku || (!str(o.sku) && productSku === sku))) bySku.push(o);
    for (const sub of Array.isArray(o.offers) ? o.offers : isObj(o.offers) ? [o.offers] : []) if (isObj(sub)) visit(sub, productSku);
  };
  const walk = (v: unknown, depth: number) => {
    if (depth > 12 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    for (const off of Array.isArray(o.offers) ? o.offers : isObj(o.offers) ? [o.offers] : []) if (isObj(off)) visit(off, str(o.sku));
    for (const [k, x] of Object.entries(o)) if (k !== "offers" && k !== "@context") walk(x, depth + 1);
  };
  try {
    walk(blocks.filter((b) => b && typeof b === "object"), 0);
  } catch {
    return { offer: null, conflict: false };
  }
  const matches = byUrl.length ? byUrl : bySku;
  const read = matches.map((m) => extractOffersFromJsonLd([{ "@context": "https://schema.org", "@type": "Product", name: "variant", offers: m }], pageUrl)[0]).filter((x): x is JsonLdOffer => !!x && x.price != null);
  if (!read.length) return { offer: null, conflict: false };
  const key = (x: JsonLdOffer) => `${x.price}|${x.currency ?? ""}|${x.listPrice ?? ""}`;
  if (new Set(read.map(key)).size > 1) return { offer: null, conflict: true };
  return { offer: read[0], conflict: false };
}

function crawlLabelOf(v: unknown): "PRODUCT" | "LISTING" | "LINKED" {
  return v === "LISTING" || v === "LINKED" ? v : "PRODUCT";
}

const upperCurrency = (v: unknown): string | undefined => (typeof v === "string" && /^[a-z]{3}$/i.test(v.trim()) ? v.trim().toUpperCase() : undefined);

export function normalizeCommerceRecord(raw: unknown, ctx: NormalizeContext = {}): NormalizedCommerceRecord {
  if (!isObj(raw) || raw.m4bCommerce !== 1) return { ok: false, code: "NOT_COMMERCE_RECORD", reason: "item was not produced by the Made4Buyers product page function" };
  const pageUrlRaw = str(raw.url);
  const pageUrl = pageUrlRaw ? normalizeUrl(pageUrlRaw) : null;
  if (!pageUrlRaw || !pageUrl) return { ok: false, code: "INVALID_URL", reason: "item has no valid http(s) URL" };
  const requestUrl = (str(raw.requestUrl) && normalizeUrl(str(raw.requestUrl)!)) || pageUrl;
  // A canonical pointing at another site is ignored (it must never re-home a product).
  const canonRaw = str(raw.canonicalUrl);
  const canon = canonRaw && sameSite(canonRaw, pageUrl) ? normalizeUrl(canonRaw) : null;
  let canonicalUrl = canon ?? pageUrl;
  const notes: string[] = [];

  const blocks = Array.isArray(raw.jsonLd) ? raw.jsonLd : [];
  const meta = metaOf(raw.meta);
  const titles = { title: str(raw.title), h1: str(raw.h1) };
  let product = extractProductFromJsonLd(blocks, pageUrlRaw, meta, titles);

  // Shopify product JSON: usable only with a known currency and, for a US-market brand, a US storefront session.
  let shopify: ReturnType<typeof readShopifyProduct> | null = null;
  let shopifyCurrency: string | undefined;
  if (raw.shopifyProduct != null) {
    shopify = readShopifyProduct(raw.shopifyProduct, str(raw.requestUrl) ?? pageUrlRaw);
    shopifyCurrency = upperCurrency(raw.shopifyCurrency) ?? product?.currency?.toUpperCase();
    const country = str(raw.shopifyCountry)?.toUpperCase();
    if (!shopify.ok) notes.push(`shopify: ${shopify.reason}`);
    else if (!shopifyCurrency) {
      notes.push("shopify: currency unknown");
      shopify = null;
    } else if ((ctx.market ?? null) === "US" && country && country !== "US") {
      notes.push(`shopify: storefront session is ${country}, not US`);
      shopify = null;
    }
  } else if (str(raw.shopifyNote)) notes.push(`shopify: ${str(raw.shopifyNote)}`);
  const sh = shopify && shopify.ok ? shopify.offer : null;

  if (!product && !sh) return { ok: false, code: "NO_PRODUCT", reason: "the page states no single product in its structured data", pageUrl };
  let shopifyOffer: CommerceOfferInput | null = null;
  if (sh) {
    // The variant's price: the product JSON, unless the page's own offer for this variant states another
    // price (a store-applied discount shown on the page and in its structured data): then the page's offer.
    const ld = jsonLdVariantOffer(blocks, pageUrlRaw, sh.variant.id, sh.variant.sku);
    if (ld.conflict) notes.push("shopify: the page's offers for this variant disagree");
    const ldOffer = ld.offer && (!ld.offer.currency || ld.offer.currency === shopifyCurrency) ? ld.offer : null;
    let o: CommerceOfferInput;
    if (ldOffer && ldOffer.price != null && Math.abs(ldOffer.price - sh.price) >= 0.005) {
      notes.push(`shopify: product JSON price ${sh.price} differs from the page's own offer for this variant (${ldOffer.price}); the page's offer is used`);
      o = { ...ldOffer, type: "Offer", currency: ldOffer.currency ?? shopifyCurrency, url: undefined, source: "json-ld", confidence: 1 };
      if (!o.availability && sh.availability) o.availability = sh.availability;
    } else {
      o = { type: "Offer", price: sh.price, currency: shopifyCurrency, source: "shopify", confidence: 1 };
      if (sh.listPrice != null) {
        o.listPrice = sh.listPrice;
        o.listPriceType = "CompareAtPrice";
      } else if (ldOffer?.listPrice != null && ldOffer.listPrice > sh.price && ldOffer.listPriceType) {
        o.listPrice = ldOffer.listPrice;
        o.listPriceType = ldOffer.listPriceType;
      }
      if (sh.availability) o.availability = sh.availability;
      if (ldOffer?.priceValidUntil) o.priceValidUntil = ldOffer.priceValidUntil;
    }
    shopifyOffer = o;
    // One variant, never a mix: identity, price and availability all come from it.
    const p: ExtractedProduct = product ?? { url: pageUrl, extractedFrom: [] };
    p.name = sh.name;
    delete p.sku;
    delete p.gtin;
    if (sh.variantCount > 1) delete p.mpn;
    if (sh.variant.sku) p.sku = sh.variant.sku;
    if (sh.variant.gtin) p.gtin = sh.variant.gtin;
    p.price = o.price;
    if (o.listPrice != null) p.listPrice = o.listPrice;
    else delete p.listPrice;
    p.currency = o.currency;
    if (o.availability) p.availability = o.availability;
    else delete p.availability;
    p.extractedFrom = [...p.extractedFrom.filter((x) => x !== "shopify"), "shopify"];
    product = p;
    if (sh.variantCount > 1) {
      const u = new URL(canonicalUrl);
      u.search = "";
      u.searchParams.set("variant", sh.variant.id);
      canonicalUrl = normalizeUrl(u.toString()) ?? canonicalUrl;
    }
  }
  if (!product) return { ok: false, code: "NO_PRODUCT", reason: "the page states no single product in its structured data", pageUrl };
  product.url = canonicalUrl;

  // Specs: JSON-LD additionalProperty first, then the page's own spec tables; first name wins.
  const specs: CommerceSpec[] = [];
  const seen = new Set<string>();
  const addSpec = (name: unknown, value: unknown, source: CommerceSpec["source"]) => {
    const n = str(name);
    const v = str(value);
    if (!n || !v || specs.length >= 200) return;
    const key = n.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) return;
    seen.add(key);
    specs.push({ name: n, value: v, source });
  };
  for (const s of product.specs ?? []) addSpec(s.name, s.value, "json-ld");
  for (const s of Array.isArray(raw.specTables) ? raw.specTables : []) if (isObj(s)) addSpec(s.name, s.value, "page-table");

  const images: CommerceImage[] = [];
  for (const i of Array.isArray(raw.images) ? raw.images : []) {
    if (!isObj(i) || images.length >= 12) continue;
    const src = str(i.src);
    if (!src || !/^https?:\/\//i.test(src) || images.some((x) => x.src === src)) continue;
    images.push({ src, alt: str(i.alt) ?? null });
  }

  let offers: CommerceOfferInput[];
  if (shopifyOffer) {
    offers = [{ ...shopifyOffer, url: canonicalUrl }];
  } else {
    offers = extractOffersFromJsonLd(blocks, pageUrlRaw, meta, titles).map((o) => ({ ...o, source: "json-ld" as const }));
    // Price only in product: meta tags (no JSON-LD offer): one offer at this page, as stated.
    if (!offers.length && product.extractedFrom.includes("meta") && product.price != null) {
      const o: CommerceOfferInput = { type: "Offer", price: product.price, source: "meta" };
      if (product.currency) o.currency = product.currency;
      if (product.availability) o.availability = product.availability;
      offers.push(o);
    }
  }

  // The page's main price block: a stated end date / promotion text for the offer it shows and, only
  // when no structured source states a previous price, the block's own previous price (confidence 0.8).
  if (Array.isArray(raw.priceBlocks) && raw.priceBlocks.length) {
    const priced = offers.filter((o) => typeof o.price === "number" && o.price > 0);
    const prices = [...new Set(priced.map((o) => o.price!))];
    const results = prices.map((price) => ({ price, r: evaluatePriceBlocks(raw.priceBlocks, { price, currency: priced.find((o) => o.price === price)?.currency ?? product!.currency }) })).filter((x) => x.r.matched);
    if (results.length === 1) {
      const { price, r } = results[0];
      const targets = priced.filter((o) => o.price === price);
      if (targets.length === 1) {
        const o = targets[0];
        if (!offers.some((x) => x.listPrice != null) && r.listPrice != null && r.listPriceType) {
          o.listPrice = r.listPrice;
          o.listPriceType = r.listPriceType;
          if (r.listPriceLabel) o.listPriceLabel = r.listPriceLabel;
          o.confidence = r.confidence;
          o.extractionMethod = HTML_PRICE_METHOD;
        }
        if (!o.priceValidUntil && r.priceValidUntil) o.priceValidUntil = r.priceValidUntil;
        if (r.promotionText) o.promotionText = r.promotionText;
      } else notes.push(`price block: ${targets.length} offers share the shown price`);
      if (r.listPrice == null && r.reasons.length) notes.push(...r.reasons.slice(0, 3).map((x) => `price block: ${x}`));
    } else if (results.length > 1) notes.push("price block: shows several structured prices");
  }

  const breadcrumbs = (Array.isArray(raw.breadcrumbs) ? raw.breadcrumbs : []).map(str).filter((x): x is string => !!x).slice(0, 20);
  const lang = str(raw.lang);
  return {
    ok: true,
    pageUrl,
    canonicalUrl,
    product,
    specs,
    images,
    productImages: extractOfficialProductImages(raw, canonicalUrl, { sku: product.sku }),
    offers,
    breadcrumbs,
    ...(lang ? { lang } : {}),
    extractionMethod: sh ? SHOPIFY_METHOD : `${EXTRACTION_PREFIX}:${product.extractedFrom.join("+") || "json-ld"}`,
    crawlLabel: crawlLabelOf(raw.crawlLabel),
    requestUrl,
    notes: notes.slice(0, 10),
  };
}
