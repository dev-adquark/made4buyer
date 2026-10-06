import { normalizeUrl } from "@/lib/pipeline/apify";
import { extractOffersFromJsonLd, extractProductFromJsonLd, registrableDomain, type JsonLdOffer } from "@/lib/products/page-extract";
import type { ExtractedProduct } from "@/lib/products/types";

/**
 * Turns one raw commerce record (what PRODUCT_PAGE_FUNCTION returned, stored unchanged in
 * CommerceRawRecord) into a normalized product. The product itself is read by the same extractor
 * as HTML product pages (extractProductFromJsonLd); spec tables and images are carried over as the
 * page stated them. A field the page does not state stays absent; nothing is guessed.
 */

export type CommerceSpec = { name: string; value: string; source: "json-ld" | "page-table" };
export type CommerceImage = { src: string; alt: string | null };
export type CommerceOfferInput = JsonLdOffer & { source: "json-ld" | "meta" };

export type NormalizedCommerceRecord =
  | {
      ok: true;
      pageUrl: string;
      /** Canonical URL (the page's own canonical when it is on the same site, else the page URL), normalized. */
      canonicalUrl: string;
      product: ExtractedProduct;
      specs: CommerceSpec[];
      images: CommerceImage[];
      offers: CommerceOfferInput[];
      breadcrumbs: string[];
      lang?: string;
      /** e.g. "apify-web-scraper:json-ld", "apify-web-scraper:json-ld+meta". */
      extractionMethod: string;
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

export function normalizeCommerceRecord(raw: unknown): NormalizedCommerceRecord {
  if (!isObj(raw) || raw.m4bCommerce !== 1) return { ok: false, code: "NOT_COMMERCE_RECORD", reason: "item was not produced by the Made4Buyers product page function" };
  const pageUrlRaw = str(raw.url);
  const pageUrl = pageUrlRaw ? normalizeUrl(pageUrlRaw) : null;
  if (!pageUrlRaw || !pageUrl) return { ok: false, code: "INVALID_URL", reason: "item has no valid http(s) URL" };
  // A canonical pointing at another site is ignored (it must never re-home a product).
  const canonRaw = str(raw.canonicalUrl);
  const canon = canonRaw && sameSite(canonRaw, pageUrl) ? normalizeUrl(canonRaw) : null;
  const canonicalUrl = canon ?? pageUrl;

  const blocks = Array.isArray(raw.jsonLd) ? raw.jsonLd : [];
  const meta = metaOf(raw.meta);
  const titles = { title: str(raw.title), h1: str(raw.h1) };
  const product = extractProductFromJsonLd(blocks, pageUrlRaw, meta, titles);
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

  const offers: CommerceOfferInput[] = extractOffersFromJsonLd(blocks, pageUrlRaw, meta, titles).map((o) => ({ ...o, source: "json-ld" as const }));
  // Price only in product: meta tags (no JSON-LD offer): one offer at this page, as stated.
  if (!offers.length && product.extractedFrom.includes("meta") && product.price != null) {
    const o: CommerceOfferInput = { type: "Offer", price: product.price, source: "meta" };
    if (product.currency) o.currency = product.currency;
    if (product.availability) o.availability = product.availability;
    offers.push(o);
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
    offers,
    breadcrumbs,
    ...(lang ? { lang } : {}),
    extractionMethod: `${EXTRACTION_PREFIX}:${product.extractedFrom.join("+") || "json-ld"}`,
  };
}
