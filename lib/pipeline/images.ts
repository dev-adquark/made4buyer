import type { EnrichmentStatus, ImageSourceType, LicenseState } from "@prisma/client";
import { config } from "@/lib/config";
import { safeFetch } from "@/lib/net/safe-fetch";
import { CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";

/**
 * Stage IMAGE_ENRICHMENT. Priority: (1) Content API image, (2) configured image service,
 * (3) our own category placeholder. Never blocks publishing. License safety is only
 * VERIFIED when explicitly established (payload flag or operator-level assertion via
 * CONTENT_API_IMAGES_LICENSED); a license string from a provider is PROVIDER_ASSERTED.
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
  enrichmentStatus: EnrichmentStatus;
  isFallback: boolean;
  failureReason?: string;
  verifiedAt?: Date;
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

async function probeImage(url: string): Promise<{ ok: true; contentType: string } | { ok: false; reason: string }> {
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
};

type ServiceImage = { url: string; license?: string; attribution?: string; licenseVerified?: boolean; width?: number; height?: number; source?: string };

async function fromService(input: ImageInput): Promise<{ image?: ServiceImage; reason?: string }> {
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

export async function enrichImage(input: ImageInput): Promise<ImageDecision> {
  const issues: ImageDecision["issues"] = [];
  const now = new Date();

  if (input.imageUrl) {
    const probe = await probeImage(input.imageUrl);
    if (probe.ok) {
      const licenseState = licenseStateOf(Boolean(input.imageLicenseVerified) || config.contentApi.imagesLicensed(), input.imageLicense);
      if (licenseState === "UNVERIFIED") issues.push({ code: "LICENSE_UNVERIFIED", message: "Content API image has no license information" });
      return {
        sourceType: "CONTENT_API",
        sourceUrl: input.imageUrl,
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
    issues.push({ code: "IMAGE_ENRICHMENT_FAILED", message: `Content API image unusable: ${probe.reason}` });
  }

  const service = await fromService(input);
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
        enrichmentStatus: "ENRICHED",
        isFallback: false,
        verifiedAt: now,
        issues,
      };
    }
    issues.push({ code: "IMAGE_ENRICHMENT_FAILED", message: `Image service result unusable: ${probe.reason}` });
  } else if (service.reason && config.images.enrichmentUrl()) {
    issues.push({ code: "IMAGE_ENRICHMENT_FAILED", message: service.reason });
  }

  return {
    sourceType: "PLACEHOLDER",
    sourceUrl: placeholderPath(input.categorySlug),
    ...PLACEHOLDER_SIZE,
    contentType: "image/svg+xml",
    licenseState: "OWNED_PLACEHOLDER",
    enrichmentStatus: issues.some((i) => i.code === "IMAGE_ENRICHMENT_FAILED") ? "FAILED" : "FALLBACK",
    isFallback: true,
    failureReason: issues.map((i) => i.message).join("; ") || (service.reason ?? "no image source available"),
    verifiedAt: now,
    issues,
  };
}

/** Which image may be shown publicly. Unverified-license images are withheld when IMAGE_REQUIRE_LICENSE is on. */
export function publicImageUrl(asset: { sourceType: ImageSourceType; sourceUrl: string | null; cdnUrl: string | null; licenseState: LicenseState } | null | undefined, categorySlug?: string | null): { url: string; isFallback: boolean } {
  if (!asset || asset.sourceType === "PLACEHOLDER" || !asset.sourceUrl) return { url: placeholderPath(categorySlug), isFallback: true };
  if (config.images.requireLicense() && asset.licenseState === "UNVERIFIED") return { url: placeholderPath(categorySlug), isFallback: true };
  return { url: asset.cdnUrl ?? asset.sourceUrl, isFallback: false };
}
