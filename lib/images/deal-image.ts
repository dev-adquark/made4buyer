import { variantParam } from "@/lib/commerce/shopify";
import { registrableDomain } from "@/lib/products/page-extract";
import { onOfficialImageDomain } from "./remote-patterns";

/**
 * Deal-card images: the official product page's OWN photo of that exact product / variant.
 *
 * Extraction (at normalize time, from the raw page record the product page function stored):
 *   1. Shopify product JSON: the chosen variant's featured_image; the product's featured image only
 *      when the product has a single variant (a multi-variant product's main photo may show another
 *      colour/size, so it is never used for a specific variant).
 *   2. JSON-LD: the image of the one Product the page states (for a ProductGroup, the hasVariant
 *      entry for this variant); several different products on a page → none.
 *   3. og:image / og:image:secure_url, only when the page is not a multi-variant product.
 * Every candidate is resolved against the page URL and must be https on the page's own registrable
 * domain (no CDN, retailer or other off-domain URL is ever kept) and not an SVG.
 *
 * Display (dealImage): the first stored candidate that is still on the product's official domain
 * (and the brand's, when known) and that the Next.js image optimizer may fetch (IMAGE_REMOTE_PATTERNS):
 * the browser never loads it from the brand directly, and the optimizer refuses anything that isn't
 * an image (the card then falls back to the placeholder). No candidate → null: the card shows the
 * neutral brand/category placeholder, never another product's photo.
 */

export type DealImageSource = "shopify-variant" | "shopify-product" | "json-ld" | "og:image";
export type StoredDealImage = { src: string; alt: string | null; source: DealImageSource; width?: number; height?: number };
export type DealImage = StoredDealImage;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const dim = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined);

function domainOf(url: string): string | null {
  try {
    return registrableDomain(new URL(url).hostname.toLowerCase());
  } catch {
    return null;
  }
}

/** An https image URL on `domain` (resolved against the page), else null. */
export function onDomainImageUrl(raw: string | undefined, pageUrl: string, domain: string): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.startsWith("//") ? `https:${raw}` : raw, pageUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  if (registrableDomain(u.hostname.toLowerCase()) !== domain) return null;
  if (/\.svg$/i.test(u.pathname)) return null;
  return u.toString();
}

function imageValues(v: unknown): Array<{ url?: string; width?: number; height?: number; alt?: string }> {
  if (typeof v === "string") return [{ url: v }];
  if (Array.isArray(v)) return v.flatMap(imageValues);
  if (isObj(v)) return [{ url: str(v.url) ?? str(v.contentUrl), width: dim(Number(v.width)), height: dim(Number(v.height)), alt: str(v.caption) ?? str(v.name) }];
  return [];
}

function types(o: Record<string, unknown>): string[] {
  const t = o["@type"];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === "string");
}

/** Product / ProductGroup nodes anywhere in the JSON-LD blocks (incl. @graph). */
function productNodes(blocks: unknown[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    const t = types(o);
    if (t.includes("Product") || t.includes("ProductGroup")) {
      out.push(o);
      return; // a product's own sub-nodes (offers, hasVariant) are read by the caller
    }
    for (const [k, x] of Object.entries(o)) if (k !== "@context") walk(x, depth + 1);
  };
  walk(blocks, 0);
  return out;
}

function variantOf(url: string | undefined, base: string): string | null {
  if (!url) return null;
  try {
    return variantParam(new URL(url, base).toString());
  } catch {
    return null;
  }
}

function variantOfGroup(group: Record<string, unknown>, variantId: string | null, pageUrl: string, sku: string | undefined): Record<string, unknown> | null {
  const variants = (Array.isArray(group.hasVariant) ? group.hasVariant : isObj(group.hasVariant) ? [group.hasVariant] : []).filter(isObj);
  if (!variants.length) return null;
  const urlOf = (v: Record<string, unknown>) => str(v.url) ?? (isObj(v.offers) ? str(v.offers.url) : undefined);
  const match = variants.filter((v) => {
    const u = urlOf(v);
    if (variantId && u) return variantOf(u, pageUrl) === variantId;
    return Boolean(sku && str(v.sku) === sku);
  });
  if (match.length === 1) return match[0];
  return variants.length === 1 && !variantId ? variants[0] : null;
}

/**
 * The official product photo candidates for one normalized product, best first.
 * `raw` is the stored page record (jsonLd, meta, shopifyProduct); `canonicalUrl` names the exact
 * variant (?variant=<id>) when the product has several.
 */
export function extractOfficialProductImages(raw: unknown, canonicalUrl: string, opts: { sku?: string | null } = {}): StoredDealImage[] {
  if (!isObj(raw)) return [];
  const pageUrl = str(raw.url) ?? canonicalUrl;
  const domain = domainOf(canonicalUrl);
  if (!domain || domainOf(pageUrl) !== domain) return [];
  const variantId = variantParam(canonicalUrl);
  const out: StoredDealImage[] = [];
  const add = (src: string | undefined, source: DealImageSource, extra: { alt?: string | null; width?: number; height?: number } = {}) => {
    const url = onDomainImageUrl(src, pageUrl, domain);
    if (!url || out.some((x) => x.src === url)) return;
    out.push({ src: url, alt: extra.alt ?? null, source, ...(extra.width ? { width: extra.width } : {}), ...(extra.height ? { height: extra.height } : {}) });
  };

  // 1. Shopify product JSON.
  let multiVariant = Boolean(variantId);
  const sp = raw.shopifyProduct;
  if (isObj(sp)) {
    const variants = (Array.isArray(sp.variants) ? sp.variants : []).filter(isObj);
    multiVariant = variants.length > 1;
    const chosen = variantId ? variants.find((v) => String(v.id) === variantId) : variants.length === 1 ? variants[0] : undefined;
    const fi = chosen && isObj(chosen.featured_image) ? chosen.featured_image : null;
    if (fi) add(str(fi.src), "shopify-variant", { alt: str(fi.alt) ?? null, width: dim(fi.width), height: dim(fi.height) });
    if (variants.length === 1) {
      const featured = isObj(sp.featured_image) ? str(sp.featured_image.src) : str(sp.featured_image);
      add(featured ?? (Array.isArray(sp.images) ? str(sp.images[0]) : undefined), "shopify-product", { alt: str(sp.title) ?? null });
    }
  }

  // 2. JSON-LD: the one product the page states (or this variant of its ProductGroup).
  const nodes = productNodes(Array.isArray(raw.jsonLd) ? raw.jsonLd : []);
  const groups = nodes.filter((n) => types(n).includes("ProductGroup"));
  const products = nodes.filter((n) => !types(n).includes("ProductGroup"));
  let ld: Record<string, unknown> | null = null;
  if (groups.length === 1) {
    ld = variantOfGroup(groups[0], variantId, pageUrl, opts.sku ?? undefined);
    if (ld && !imageValues(ld.image).length && !multiVariant && !variantId) ld = groups[0];
  } else if (!groups.length) {
    const names = new Set(products.map((p) => (str(p.name) ?? "").toLowerCase()));
    if (products.length && names.size === 1) {
      // Several nodes of one product (themes repeat it): fine; with a variant, the node for that variant's SKU/URL when stated.
      const exact = variantId || opts.sku ? products.find((p) => (opts.sku && str(p.sku) === opts.sku) || (variantId && variantOf(str(p.url), pageUrl) === variantId)) : undefined;
      ld = exact ?? (multiVariant ? null : products[0]);
    }
  }
  if (ld) for (const i of imageValues(ld.image).slice(0, 3)) add(i.url, "json-ld", { alt: i.alt ?? str(ld.name) ?? null, width: i.width, height: i.height });

  // 3. og:image: page-level, so only for a page that is one product without variants.
  if (!multiVariant) {
    const meta = isObj(raw.meta) ? raw.meta : {};
    add(str(meta["og:image:secure_url"]) ?? str(meta["og:image"]), "og:image", { alt: str(meta["og:image:alt"]) ?? null, width: dim(Number(meta["og:image:width"])), height: dim(Number(meta["og:image:height"])) });
  }
  return out.slice(0, 4);
}

/** Reads `data.productImages` back (only well-formed entries). */
export function storedDealImages(data: unknown): StoredDealImage[] {
  const list = isObj(data) && Array.isArray(data.productImages) ? data.productImages : [];
  const sources: DealImageSource[] = ["shopify-variant", "shopify-product", "json-ld", "og:image"];
  return list.filter(isObj).flatMap((x) => {
    const src = str(x.src);
    const source = sources.find((s) => s === x.source);
    if (!src || !source) return [];
    return [{ src, alt: str(x.alt) ?? null, source, ...(dim(x.width) ? { width: dim(x.width) } : {}), ...(dim(x.height) ? { height: dim(x.height) } : {}) }];
  });
}

/** Image URLs of this product the image-integrity job found broken (data.brokenImages: src → when). */
export function brokenImageSrcs(data: unknown): Set<string> {
  const b = isObj(data) && isObj(data.brokenImages) ? data.brokenImages : {};
  return new Set(Object.keys(b));
}

/**
 * A retailer page's own photo of the exact product (priority 2): the product must be identity-matched
 * to a Made4Buyers product (MATCHED), the page must not be on the brand's own domain, and the photo must
 * be on the retailer page's own registrable domain (validated at extraction and again here). Null otherwise.
 */
export function retailerDealImage(product: (DealImageProduct & { identityStatus?: string | null }) | null | undefined): DealImage | null {
  if (!product || product.identityStatus !== "MATCHED") return null;
  const domain = domainOf(product.canonicalUrl);
  if (!domain || !product.canonicalUrl.toLowerCase().startsWith("https://")) return null;
  if (product.brand?.officialDomain && registrableDomain(product.brand.officialDomain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")) === domain) return null;
  const broken = brokenImageSrcs(product.data);
  for (const img of storedDealImages(product.data)) {
    if (broken.has(img.src) || onDomainImageUrl(img.src, product.canonicalUrl, domain) !== img.src) continue;
    return img;
  }
  return null;
}

export type DealImageProduct = {
  canonicalUrl: string;
  data: unknown;
  /** The commerce brand (its official domain), when the product belongs to one. */
  brand?: { officialDomain: string } | null;
};

/**
 * The image to show on a deal card for this CommerceProduct, or null (show the placeholder).
 * Render it with <SafeImg …>: the URL is on the brand's own official domain (validated here), so it may load directly.
 */
export function dealImage(product: DealImageProduct | null | undefined, opts: { requireListedDomain?: boolean } = {}): DealImage | null {
  if (!product) return null;
  const domain = domainOf(product.canonicalUrl);
  if (!domain || !product.canonicalUrl.toLowerCase().startsWith("https://")) return null;
  if (product.brand?.officialDomain) {
    const official = registrableDomain(product.brand.officialDomain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
    if (official !== domain) return null; // a retailer's page: not the brand's own photo
  }
  const broken = brokenImageSrcs(product.data);
  for (const img of storedDealImages(product.data)) {
    if (broken.has(img.src)) continue; // the image-integrity job found it no longer loads
    if (onDomainImageUrl(img.src, product.canonicalUrl, domain) !== img.src) continue;
    // On the brand's own official domain (checked above): loads directly from that domain. Deal cards
    // also require the domain to be on the reviewed list (OFFICIAL_IMAGE_DOMAINS); a review hero only
    // needs the brand's own registered domain (opts.requireListedDomain = false).
    if (opts.requireListedDomain !== false && !onOfficialImageDomain(img.src)) continue;
    return img;
  }
  return null;
}
