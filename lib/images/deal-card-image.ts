import { placeholderPath } from "@/lib/pipeline/images";
import { isPexelsImageUrl } from "@/lib/pipeline/pexels";
import { brokenImageSrcs, dealImage, retailerDealImage, type DealImageProduct } from "./deal-image";
import { commerceProductTopic, type CommerceTopic } from "./product-type";
import { LOW_CONFIDENCE, PRODUCT_IMAGE_TYPES, REPRESENTATIVE_CAPTION } from "./provenance";

/**
 * The image on a deal / price card. Every card gets one, by this priority (never another product's photo):
 *
 *   1. official      the brand's own product page's photo of this exact product/variant (lib/images/deal-image.ts),
 *                    or, for a retailer page, the official page of the same identity-matched product
 *   2. retailer      the retailer page's own photo of this exact (identity-matched) product, on its own domain
 *   3. internal      the verified exact-product ImageAsset of the published review of the same product
 *   4. illustrative  a Pexels photo of the product's TYPE, noted "Representative photo" (data.cardImage, chosen by
 *                    the deal-images job from the product's own name / page category / description; stored with provenance)
 *   5. category      the category's licensed Pexels photo (lib/public/deals.ts, from the daily category-photo cache),
 *                    noted "Representative photo"; our neutral category graphic only when no such photo exists
 *
 * Pure and network-free: the request path only reads what the jobs stored.
 */

export type DealCardImageKind = "official" | "retailer" | "internal" | "illustrative" | "category";

export type DealCardImage = {
  src: string;
  alt: string;
  kind: DealCardImageKind;
  /** Shows the exact product (kinds official, retailer, internal). */
  exact: boolean;
  /** Visible note for an image that is not the exact product ("Representative photo"); null otherwise. */
  caption: string | null;
  /** Tried in order in the browser when `src` fails to load (e.g. the category's licensed photo), before the placeholder graphic. */
  alternates?: string[];
  /** Provenance: where the image comes from. */
  source: string;
  sourceUrl: string | null;
  query: string | null;
  attribution: string | null;
  attributionUrl: string | null;
  confidence: number;
  width: number;
  height: number;
};

/** What the deal-images job stores in CommerceProduct.data.cardImage (provenance included). */
export type StoredCardImage = {
  v: 1;
  kind: "illustrative";
  src: string;
  alt: string;
  source: "pexels";
  sourceType: "ENRICHMENT_SERVICE";
  /** The Pexels photo page. */
  sourceUrl: string;
  photoId: string;
  query: string;
  topicKey: string;
  topicLabel: string;
  imageType: CommerceTopic["imageType"];
  basis: CommerceTopic["basis"];
  /** The CommerceProduct this was chosen for: a stored image is never shown for another product. */
  productId: string;
  productName: string;
  confidence: number;
  observedAt: string;
  attribution: string;
  attributionUrl: string;
  license: string;
};

export type CardImageProduct = DealImageProduct & {
  id: string;
  name: string;
  identityStatus?: string | null;
};

export type InternalImage = { url: string; imageType: string | null; matchConfidence: number | null; licenseState: string; enrichmentStatus: string; sourceType: string; attribution?: string | null; attributionUrl?: string | null; sourcePageUrl?: string | null };

export type DealCardImageInput = {
  product: CardImageProduct;
  /** For a retailer page: the official-domain CommerceProduct of the same identity-matched product. */
  official?: DealImageProduct | null;
  /** The primary image of the published review of the same product (when there is one). */
  internal?: InternalImage | null;
  /** The brand's categories (taxonomy slugs): the first names the category image. */
  categories: string[];
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The commerce product's image topic from what its own page states (lib/images/product-type.ts). */
export function cardImageTopic(product: { name: string; data: unknown }, categories: string[]): CommerceTopic | null {
  const data = isObj(product.data) ? product.data : {};
  const p = isObj(data.product) ? data.product : {};
  const crumbs = Array.isArray(data.breadcrumbs) ? data.breadcrumbs.filter((x): x is string => typeof x === "string") : [];
  return commerceProductTopic({ name: product.name, pageCategory: str(p.category), breadcrumbs: crumbs, description: str(p.description), brandCategories: categories });
}

/** Reads data.cardImage back; null unless well formed, a Pexels https photo, and chosen for THIS product and its current type. */
export function storedCardImage(product: { id: string; name: string; data: unknown }, categories: string[]): StoredCardImage | null {
  const data = isObj(product.data) ? product.data : null;
  const c = data && isObj(data.cardImage) ? data.cardImage : null;
  if (!c || c.v !== 1 || c.kind !== "illustrative" || c.source !== "pexels") return null;
  const src = str(c.src);
  if (!src || !isPexelsImageUrl(src)) return null;
  // Wrong-image prevention: chosen for another product (copied data), or for a type the page no longer states.
  if (c.productId !== product.id) return null;
  const topic = cardImageTopic(product, categories);
  if (!topic || topic.topic.key !== c.topicKey) return null;
  if (brokenImageSrcs(product.data).has(src)) return null;
  return c as unknown as StoredCardImage;
}

/** How sure an official / retailer page photo is of the exact product, by where on the page it was read. */
export function exactConfidence(source: string): number {
  return source === "shopify-variant" || source === "shopify-product" ? 1 : source === "json-ld" ? 0.95 : 0.9;
}

/** The internal image qualifies only when it is a verified, confident photo of the exact product. */
function internalExact(i: InternalImage | null | undefined): InternalImage | null {
  if (!i || !/^https:\/\//.test(i.url)) return null;
  if (!i.imageType || !PRODUCT_IMAGE_TYPES.has(i.imageType)) return null;
  if (i.enrichmentStatus === "FAILED" || i.licenseState !== "VERIFIED" || i.sourceType === "PLACEHOLDER") return null;
  return i.matchConfidence != null && i.matchConfidence >= LOW_CONFIDENCE ? i : null;
}

export function dealCardImage(input: DealCardImageInput): DealCardImage {
  const { product } = input;
  const base = { query: null, attribution: null, attributionUrl: null, width: 300, height: 200 };

  // 1. The brand's own page: this product's page, or (retailer page) the official page of the same matched product.
  const own = dealImage(product);
  if (own) return { ...base, src: own.src, alt: own.alt ?? product.name, kind: "official", exact: true, caption: null, source: `official:${own.source}`, sourceUrl: product.canonicalUrl, confidence: exactConfidence(own.source), width: own.width ?? 300, height: own.height ?? 200 };
  if (product.identityStatus === "MATCHED" && input.official) {
    const off = dealImage(input.official);
    if (off) return { ...base, src: off.src, alt: off.alt ?? product.name, kind: "official", exact: true, caption: null, source: `official:${off.source}`, sourceUrl: input.official.canonicalUrl, confidence: exactConfidence(off.source) * 0.95, width: off.width ?? 300, height: off.height ?? 200 };
  }
  // 2. The retailer page's own photo of the exact product.
  const ret = retailerDealImage(product);
  if (ret) return { ...base, src: ret.src, alt: ret.alt ?? product.name, kind: "retailer", exact: true, caption: null, source: `retailer:${ret.source}`, sourceUrl: product.canonicalUrl, confidence: exactConfidence(ret.source) * 0.9, width: ret.width ?? 300, height: ret.height ?? 200 };
  // 3. Our own verified photo of the exact product (the published review's hero).
  const internal = internalExact(input.internal);
  if (internal) return { ...base, src: internal.url, alt: product.name, kind: "internal", exact: true, caption: null, source: `image-asset:${internal.imageType}`, sourceUrl: internal.sourcePageUrl ?? null, attribution: internal.attribution ?? null, attributionUrl: internal.attributionUrl ?? null, confidence: internal.matchConfidence ?? LOW_CONFIDENCE };
  // 4. A labelled photo of this kind of product.
  const stored = storedCardImage(product, input.categories);
  if (stored) return { src: stored.src, alt: stored.alt || `Photo of ${stored.topicLabel}`, kind: "illustrative", exact: false, caption: REPRESENTATIVE_CAPTION, source: "pexels", sourceUrl: stored.sourceUrl, query: stored.query, attribution: stored.attribution, attributionUrl: stored.attributionUrl, confidence: stored.confidence, width: 1200, height: 627 };
  // 5. Our neutral category image.
  return categoryCardImage(input.categories[0]);
}

/** Priority 5 before the category photo is applied (lib/public/deals.ts): our neutral category image. */
export function categoryCardImage(categorySlug: string | null | undefined): DealCardImage {
  return { src: placeholderPath(categorySlug), alt: "", kind: "category", exact: false, caption: null, source: "category-placeholder", sourceUrl: null, query: null, attribution: null, attributionUrl: null, confidence: 0, width: 1200, height: 675 };
}
