import type { EnrichmentStatus, ImageSourceType, LicenseState } from "@prisma/client";
import { config } from "@/lib/config";
import { safeFetch } from "@/lib/net/safe-fetch";
import { CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";
import type { ImageType } from "@/lib/images/provenance";
import { isCommonsFileUrl, isFreeLicence, type CommonsImage } from "@/lib/products/commons-image";
import { findPexelsImage, type PexelsSearchResult, type PexelsSearchStatus } from "./pexels";
import { productTypeTopic } from "@/lib/images/product-type";
import { imageTopic, photoMatchesTopic, type ImageTopic } from "./image-topics";
import { commonsFileTitle, namesSeveralProducts, searchCommonsProductPhoto } from "@/lib/images/commons-search";

/**
 * Stage IMAGE_ENRICHMENT. Never blocks publishing. A wrong image is worse than no image.
 *
 * Single-product content (a REVIEW, or anything with a PRIMARY product link):
 *   (1) a licensed photo of the exact product (Wikimedia Commons via a Wikidata "image" fact,
 *       identity-matched; see lib/products/commons-image.ts),
 *   (2) the review source's own image when explicitly licensed (Content API),
 *   (3) our neutral category placeholder. Never a keyword-matched stock photo (Pexels/service).
 * Category-level content (comparisons, buying guides, AI guides):
 *   (1) the source's licensed image, (2) a labelled ILLUSTRATIVE topic photo whose own
 *   description is about the topic (Pexels), (3) the neutral category placeholder.
 *
 * License safety is only VERIFIED when explicitly established (payload flag, operator-level
 * CONTENT_API_IMAGES_LICENSED, the Pexels License, or a free Commons licence); a license string
 * from a provider is PROVIDER_ASSERTED. Every decision records its provenance (imageType).
 */

export type ImageDecision = {
  sourceType: ImageSourceType;
  sourceUrl?: string;
  cdnUrl?: string;
  contentType?: string;
  width?: number;
  height?: number;
  licenseState: LicenseState;
  license?: string;
  attribution?: string;
  attributionUrl?: string;
  enrichmentStatus: EnrichmentStatus;
  isFallback: boolean;
  failureReason?: string;
  subject?: "PRODUCT" | "ILLUSTRATIVE";
  providerPhotoId?: string;
  searchQuery?: string;
  altText?: string;
  photographerUrl?: string;
  verifiedAt?: Date;
  /** Provenance: what the image shows and how we know (lib/images/provenance.ts). */
  imageType: ImageType;
  /** How sure we are the image shows the content's product (0..1); omitted for category images. */
  matchConfidence?: number;
  /** The page describing the image (e.g. its Commons file page). */
  sourcePageUrl?: string;
  /** Provider status when the provider stopped us (rate limit, auth): the caller should pause. */
  providerStatus?: PexelsSearchStatus;
  issues: Array<{ code: "IMAGE_ENRICHMENT_FAILED" | "LICENSE_UNVERIFIED"; message: string }>;
};

export const PLACEHOLDER_SIZE = { width: 1200, height: 675 };

export function placeholderPath(categorySlug?: string | null): string {
  return `/placeholders/${categorySlug && CATEGORY_BY_SLUG.has(categorySlug) ? categorySlug : "general"}.svg`;
}

export function cdnUrlFor(sourceUrl: string): string | undefined {
  const template = config.images.cdnTemplate();
  if (!template) return undefined;
  return template.includes("{url}") ? template.replace("{url}", encodeURIComponent(sourceUrl)) : `${template.replace(/\/+$/, "")}/${encodeURIComponent(sourceUrl)}`;
}

export async function probeImage(url: string): Promise<{ ok: true; contentType: string } | { ok: false; reason: string }> {
  const opts = { timeoutMs: config.images.timeoutMs(), maxRedirects: 3, standardPortsOnly: true, headers: { Accept: "image/*" } };
  let res = await safeFetch(url, { ...opts, method: "HEAD" });
  if (!res.error && [403, 405, 501].includes(res.status)) res = await safeFetch(url, { ...opts, method: "GET", headers: { ...opts.headers, Range: "bytes=0-0" } });
  if (res.error) return { ok: false, reason: `${res.error.kind}: ${res.error.message}` };
  if (res.status !== 200 && res.status !== 206) return { ok: false, reason: `image URL returned HTTP ${res.status}` };
  const contentType = (res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (!contentType.startsWith("image/")) return { ok: false, reason: `unexpected content-type "${contentType || "none"}"` };
  if (contentType === "image/svg+xml") return { ok: false, reason: "remote SVG images are not accepted" };
  return { ok: true, contentType };
}

export type ImageInput = {
  imageUrl?: string;
  imageLicense?: string;
  imageAttribution?: string;
  imageLicenseVerified?: boolean;
  productName: string;
  brand?: string | null;
  categorySlug?: string | null;
  subcategorySlug?: string | null;
  title?: string;
  /** Content kind: only a single-product REVIEW may get a "product" photo. */
  kind?: string | null;
  /**
   * The content is about one product (a REVIEW, or it has a PRIMARY product link). Defaults to
   * true unless `kind` names category-level content. Single-product content never gets a stock photo.
   */
  singleProduct?: boolean;
  /** Validated, licensed photos of the exact product, best first (lib/products/commons-image.ts). */
  productImages?: CommonsImage[];
  /** Provider photo ids already used by other reviews (avoided where an alternative exists). */
  excludePhotoIds?: Set<string>;
  /** Per-run search cache shared across reviews. */
  searchCache?: Map<string, PexelsSearchResult>;
};

type ServiceImage = {
  url: string;
  license?: string;
  attribution?: string;
  attributionUrl?: string;
  licenseVerified?: boolean;
  width?: number;
  height?: number;
  source?: string;
  subject?: "PRODUCT" | "ILLUSTRATIVE";
  providerPhotoId?: string;
  searchQuery?: string;
  altText?: string;
  photographerUrl?: string;
};

async function fromService(input: ImageInput, topic?: ImageTopic): Promise<{ image?: ServiceImage; reason?: string; providerStatus?: PexelsSearchStatus }> {
  if (config.images.pexelsKey()) {
    const p = await findPexelsImage(
      // The lookup is always for an ILLUSTRATIVE photo, never a keyword "product" photo: of the
      // product type for single-product pages, of the topic for category-level content.
      { productName: input.productName, brand: input.brand, title: input.title, categorySlug: input.categorySlug, subcategorySlug: input.subcategorySlug, kind: topic ? "PRODUCT_TYPE" : input.kind && input.kind !== "REVIEW" ? input.kind : "BUYING_GUIDE" },
      { exclude: input.excludePhotoIds, cache: input.searchCache, topic },
    );
    // Every photo served by the Pexels API is covered by the Pexels License.
    if (p.image) {
      const { alt, ...rest } = p.image;
      return { image: { ...rest, altText: alt, licenseVerified: true, source: "pexels" } };
    }
    const stopped = p.status === "RATE_LIMITED" || p.status === "AUTH_FAILED" ? p.status : undefined;
    if (!config.images.enrichmentUrl() || stopped) return { reason: p.reason, providerStatus: stopped };
  }
  const base = config.images.enrichmentUrl();
  if (!base) return { reason: "IMAGE_ENRICHMENT_URL not configured (BLOCKED_BY_ENVIRONMENT)" };
  let endpoint: URL;
  try {
    endpoint = new URL(base);
  } catch {
    return { reason: "IMAGE_ENRICHMENT_URL is invalid" };
  }
  endpoint.searchParams.set("q", input.productName);
  if (input.brand) endpoint.searchParams.set("brand", input.brand);
  if (input.categorySlug) endpoint.searchParams.set("category", input.categorySlug);
  const headers: Record<string, string> = { Accept: "application/json" };
  const key = config.images.enrichmentKey();
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await safeFetch(endpoint.toString(), { headers, timeoutMs: config.images.timeoutMs(), maxRedirects: 2, readBody: true, maxBytes: 1_000_000 });
  if (!res.ok) return { reason: `image service ${res.error ? res.error.kind : `HTTP ${res.status}`}` };
  try {
    const d = JSON.parse(res.body ?? "") as Record<string, unknown>;
    const data = (d.data && typeof d.data === "object" ? d.data : d) as Record<string, unknown>;
    const url = [data.url, data.imageUrl, data.image].find((v) => typeof v === "string") as string | undefined;
    if (!url) return { reason: "image service returned no image URL" };
    return {
      image: {
        url,
        license: typeof data.license === "string" ? data.license : undefined,
        attribution: typeof data.attribution === "string" ? data.attribution : undefined,
        licenseVerified: data.licenseVerified === true,
        width: typeof data.width === "number" ? data.width : undefined,
        height: typeof data.height === "number" ? data.height : undefined,
      },
    };
  } catch {
    return { reason: "image service returned invalid JSON" };
  }
}

function licenseStateOf(verified: boolean, license?: string): LicenseState {
  if (verified) return "VERIFIED";
  if (license) return "PROVIDER_ASSERTED";
  return "UNVERIFIED";
}

/** Whether content is about one product (so it may only show that exact product, or a neutral image). */
export function isSingleProductContent(input: { kind?: string | null; singleProduct?: boolean }): boolean {
  return input.singleProduct ?? (!input.kind || input.kind === "REVIEW");
}

/** Our neutral category image: names the category, shows no product. */
export function neutralCategoryDecision(categorySlug: string | null | undefined, issues: ImageDecision["issues"], reason: string, providerStatus?: PexelsSearchStatus): ImageDecision {
  return {
    sourceType: "PLACEHOLDER",
    sourceUrl: placeholderPath(categorySlug),
    ...PLACEHOLDER_SIZE,
    contentType: "image/svg+xml",
    licenseState: "OWNED_PLACEHOLDER",
    enrichmentStatus: issues.some((i) => i.code === "IMAGE_ENRICHMENT_FAILED") ? "FAILED" : "FALLBACK",
    isFallback: true,
    imageType: "neutral-category",
    failureReason: issues.map((i) => i.message).join("; ") || reason,
    providerStatus,
    verifiedAt: new Date(),
    issues,
  };
}

/** A licensed Commons photo of the exact product, if one loads. */
async function fromProductImages(images: CommonsImage[], issues: ImageDecision["issues"], product: { productName: string; brand?: string | null }): Promise<ImageDecision | null> {
  for (const img of images) {
    // Defence in depth: the lookup validated these, but never show an unlicensed or off-Commons file.
    if (!isCommonsFileUrl(img.url) || !isFreeLicence(img.license)) continue;
    // A group shot (its file title names several products) is never one product's exact photo.
    const title = commonsFileTitle(img.filePageUrl) ?? commonsFileTitle(img.url);
    if (title && namesSeveralProducts(title, product.productName, product.brand)) {
      issues.push({ code: "IMAGE_ENRICHMENT_FAILED", message: `Commons file names several products, not this product's exact photo: ${title}`.slice(0, 300) });
      continue;
    }
    const probe = await probeImage(img.url);
    if (!probe.ok) {
      issues.push({ code: "IMAGE_ENRICHMENT_FAILED", message: `Commons product image unusable: ${probe.reason}` });
      continue;
    }
    return {
      sourceType: "WIKIMEDIA_COMMONS",
      sourceUrl: img.url,
      cdnUrl: cdnUrlFor(img.url),
      contentType: probe.contentType,
      licenseState: "VERIFIED",
      license: img.license,
      attribution: img.attribution,
      attributionUrl: img.filePageUrl,
      sourcePageUrl: img.filePageUrl,
      subject: "PRODUCT",
      imageType: "commons-product",
      matchConfidence: img.matchConfidence,
      enrichmentStatus: "ENRICHED",
      isFallback: false,
      verifiedAt: new Date(),
      issues,
    };
  }
  return null;
}

/**
 * True when a stored stock photo still passes today's relevance rule for this content: its own
 * description must name the product type (single product) or the topic (category content).
 */
export function stockPhotoStillRelevant(altText: string | null | undefined, input: { productName: string; title?: string | null; categorySlug?: string | null; subcategorySlug?: string | null; singleProduct: boolean }): boolean {
  const topic = productTypeTopic({ productName: input.productName, title: input.title, categorySlug: input.categorySlug }) ?? (input.singleProduct ? null : imageTopic({ title: input.title ?? input.productName, productName: input.productName, categorySlug: input.categorySlug, subcategorySlug: input.subcategorySlug }));
  return Boolean(topic && altText && photoMatchesTopic(altText, topic));
}

/**
 * Display guard: only relevant images are ever shown. A stored stock photo that fails today's
 * relevance rule is dropped (the caller then shows the neutral category image). Licensed product
 * photos (Commons, the source's licensed image) and our placeholders pass unchanged.
 */
export function relevantImage<T extends { sourceType: string; altText?: string | null }>(
  asset: T | null | undefined,
  ctx: { productName: string; title?: string | null; categorySlug?: string | null; subcategorySlug?: string | null; singleProduct: boolean },
): T | null {
  if (!asset) return null;
  if (asset.sourceType !== "ENRICHMENT_SERVICE") return asset;
  return stockPhotoStillRelevant(asset.altText, ctx) ? asset : null;
}

export async function enrichImage(input: ImageInput): Promise<ImageDecision> {
  const issues: ImageDecision["issues"] = [];
  const now = new Date();
  const single = isSingleProductContent(input);

  // 1. Single-product content: a licensed photo of the exact product comes first.
  if (single && input.productImages?.length) {
    const product = await fromProductImages(input.productImages, issues, input);
    if (product) return product;
  }

  if (input.imageUrl) {
    const licenseState = licenseStateOf(Boolean(input.imageLicenseVerified) || config.contentApi.imagesLicensed(), input.imageLicense);
    // A source image we may not show (e.g. a scraped publisher's own image) is skipped, so the
    // next source gets its turn instead of the page falling back to a placeholder.
    const showable = licenseState !== "UNVERIFIED" || !config.images.requireLicense();
    const probe = showable ? await probeImage(input.imageUrl) : ({ ok: false, reason: "source image has no verified licence" } as const);
    if (probe.ok) {
      if (licenseState === "UNVERIFIED") issues.push({ code: "LICENSE_UNVERIFIED", message: "Content API image has no license information" });
      return {
        sourceType: "CONTENT_API",
        sourceUrl: input.imageUrl,
        // The review source's own image of the reviewed product; for category-level content it
        // illustrates the topic and is labelled as such.
        subject: single ? "PRODUCT" : "ILLUSTRATIVE",
        imageType: single ? "source-product" : "illustrative-category",
        cdnUrl: cdnUrlFor(input.imageUrl),
        contentType: probe.contentType,
        licenseState,
        license: input.imageLicense,
        attribution: input.imageAttribution,
        enrichmentStatus: "ENRICHED",
        isFallback: false,
        verifiedAt: now,
        issues,
      };
    }
    if (showable) issues.push({ code: "IMAGE_ENRICHMENT_FAILED", message: `Content API image unusable: ${probe.reason}` });
  }

  if (single) {
    // 2. A freely licensed Commons photo whose own file title names this exact product.
    const commons = await searchCommonsProductPhoto({ productName: input.productName, brand: input.brand }).catch(() => null);
    if (commons) {
      const found = await fromProductImages([commons], issues, input);
      if (found) return found;
    }
    // 3. A labelled illustrative photo of this KIND of product (its type read from the product
    // name, never the category), accepted only if the photo's own description names that type.
    const topic = productTypeTopic({ productName: input.productName, title: input.title, categorySlug: input.categorySlug });
    if (!topic) return neutralCategoryDecision(input.categorySlug, issues, "no licensed photo of this product, and its product type can't be read from its name");
    const typed = await fromService(input, topic);
    if (typed.image && typed.image.subject === "ILLUSTRATIVE") {
      const probe = await probeImage(typed.image.url);
      if (probe.ok) {
        return {
          sourceType: "ENRICHMENT_SERVICE",
          sourceUrl: typed.image.url,
          cdnUrl: cdnUrlFor(typed.image.url),
          contentType: probe.contentType,
          width: typed.image.width,
          height: typed.image.height,
          licenseState: licenseStateOf(Boolean(typed.image.licenseVerified), typed.image.license),
          license: typed.image.license,
          attribution: typed.image.attribution,
          attributionUrl: typed.image.attributionUrl,
          subject: "ILLUSTRATIVE",
          imageType: "illustrative-product-type",
          providerPhotoId: typed.image.providerPhotoId,
          searchQuery: typed.image.searchQuery,
          altText: typed.image.altText,
          photographerUrl: typed.image.photographerUrl,
          enrichmentStatus: "ENRICHED",
          isFallback: false,
          verifiedAt: now,
          issues,
        };
      }
      issues.push({ code: "IMAGE_ENRICHMENT_FAILED", message: `Illustrative photo unusable: ${probe.reason}` });
    }
    // 4. Nothing relevant: the neutral category image, never an unrelated photo.
    return neutralCategoryDecision(input.categorySlug, issues, typed.reason ?? `no on-topic photo of ${topic.label}`, typed.providerStatus);
  }

  // Category-level content: a labelled illustrative photo. When the title names a product type
  // ("electric shavers", "espresso machine", "carry-on luggage") that type is the topic; otherwise
  // the category's topic.
  const service = await fromService(input, productTypeTopic({ productName: input.productName, title: input.title, categorySlug: input.categorySlug }) ?? undefined);
  if (service.image) {
    const probe = await probeImage(service.image.url);
    if (probe.ok) {
      const licenseState = licenseStateOf(Boolean(service.image.licenseVerified), service.image.license);
      if (licenseState === "UNVERIFIED") issues.push({ code: "LICENSE_UNVERIFIED", message: "Image service returned no license information" });
      return {
        sourceType: "ENRICHMENT_SERVICE",
        sourceUrl: service.image.url,
        cdnUrl: cdnUrlFor(service.image.url),
        contentType: probe.contentType,
        width: service.image.width,
        height: service.image.height,
        licenseState,
        license: service.image.license,
        attribution: service.image.attribution,
        attributionUrl: service.image.attributionUrl,
        // A stock/service photo is never presented as a product.
        subject: "ILLUSTRATIVE",
        imageType: "illustrative-category",
        providerPhotoId: service.image.providerPhotoId,
        searchQuery: service.image.searchQuery,
        altText: service.image.altText,
        photographerUrl: service.image.photographerUrl,
        enrichmentStatus: "ENRICHED",
        isFallback: false,
        verifiedAt: now,
        issues,
      };
    }
    issues.push({ code: "IMAGE_ENRICHMENT_FAILED", message: `Image service result unusable: ${probe.reason}` });
  } else if (service.reason && (config.images.enrichmentUrl() || config.images.pexelsKey())) {
    issues.push({ code: "IMAGE_ENRICHMENT_FAILED", message: service.reason });
  }

  return neutralCategoryDecision(input.categorySlug, issues, service.reason ?? "no image source available", service.providerStatus);
}

/**
 * Which image may be shown publicly. Unverified-license images are withheld when IMAGE_REQUIRE_LICENSE
 * is on, and an image whose URL the image-integrity job found broken (enrichmentStatus FAILED) falls
 * back to the category placeholder straight away (the row is kept; a later check can restore it).
 */
export function publicImageUrl(asset: { sourceType: ImageSourceType; sourceUrl: string | null; cdnUrl: string | null; licenseState: LicenseState; enrichmentStatus?: EnrichmentStatus | null } | null | undefined, categorySlug?: string | null): { url: string; isFallback: boolean } {
  if (!asset || asset.sourceType === "PLACEHOLDER" || !asset.sourceUrl) return { url: placeholderPath(categorySlug), isFallback: true };
  if (asset.enrichmentStatus === "FAILED") return { url: placeholderPath(categorySlug), isFallback: true };
  if (config.images.requireLicense() && asset.licenseState === "UNVERIFIED") return { url: placeholderPath(categorySlug), isFallback: true };
  return { url: asset.cdnUrl ?? asset.sourceUrl, isFallback: false };
}
