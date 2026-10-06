import { Prisma } from "@prisma/client";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { isRetryableStatus, safeFetch, validateOutboundUrl, withRetry } from "@/lib/net/safe-fetch";
import { sha256 } from "@/lib/util/text";
import { isProviderAffiliateUrl } from "./offers";

/**
 * Sovrn Commerce "Product Promo Codes" adapter (https://developer.sovrn.com/reference/get_product).
 *   GET https://viglink.io/coupons/product?api_key=<site key>&product_url=<retailer URL>
 *   Authorization: secret <SOVRN_API_KEY>
 * Only documented fields are read. The API has no expiry date: a code counts as current only while
 * the latest response still returns it, and is displayed only while recently verified.
 * Sovrn is monetisation only: nothing here can block or change content.
 */

export type NormalizedCoupon = {
  id: string;
  code: string;
  affiliatedUrl: string;
  currency: string;
  verified: boolean;
  originalPrice: number | null;
  priceWithCode: number | null;
  verifiedAt: Date | null;
  description: string | null;
};
export type CouponMerchant = { domain: string | null; name: string | null };
export type CouponScan = { verificationActive: boolean; whenToCheckBackSec: number | null };
export type CouponPayload = { merchant: CouponMerchant; scan: CouponScan; coupons: NormalizedCoupon[] };

export type CouponFetchOutcome =
  | { status: "OK" | "EMPTY"; data: CouponPayload; fromCache: boolean }
  | { status: "UNAVAILABLE"; reason: string }
  | { status: "AUTH_FAILED" | "NOT_FOUND" | "RATE_LIMITED" | "TIMEOUT" | "PROVIDER_ERROR" | "INVALID_RESPONSE"; message: string; httpStatus?: number };

const TRACKING = /^(utm_[a-z]+|gclid|fbclid|msclkid|dclid|yclid|mc_[a-z]+|ref|ref_|tag|ascsubtag|linkcode|linkid|camp|creative|irclickid|irgwc|clickid|cjevent|aff(_?id)?|affiliate(_?id)?|subid|sid|cuid|_ga|_gl|spm|psc)$/i;

/** The retailer product page to query: http(s), no fragment, no tracking/affiliate parameters, never a redirect/affiliate host. */
export function canonicalProductUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const v = validateOutboundUrl(url, { standardPortsOnly: true });
  if (!v.url || isProviderAffiliateUrl(v.url.toString())) return undefined;
  const u = new URL(v.url.toString());
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  return u.toString();
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

/** Strictly the documented response shape; a coupon without a code or a Sovrn-hosted affiliated_url is dropped. */
export function normalizeCoupons(payload: unknown): CouponPayload | undefined {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { coupons?: unknown }).coupons)) return undefined;
  const p = payload as { merchant?: Record<string, unknown>; scan?: Record<string, unknown>; coupons: unknown[] };
  const coupons: NormalizedCoupon[] = [];
  for (const raw of p.coupons) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    const code = str(c.code);
    const affiliatedUrl = str(c.affiliated_url);
    const id = str(c.id) ?? (typeof c.id === "number" ? String(c.id) : null);
    if (!code || !id || !affiliatedUrl || !isProviderAffiliateUrl(affiliatedUrl)) continue;
    const verifiedAt = str(c.verified_at) ? new Date(String(c.verified_at)) : null;
    coupons.push({
      id,
      code,
      affiliatedUrl,
      currency: (str(c.currency) ?? "USD").toUpperCase().slice(0, 3),
      verified: c.verified === true,
      originalPrice: numOrNull(c.original_price),
      priceWithCode: numOrNull(c.price_with_code),
      verifiedAt: verifiedAt && !Number.isNaN(verifiedAt.getTime()) ? verifiedAt : null,
      description: str(c.code_description),
    });
  }
  const scan = p.scan ?? {};
  return {
    merchant: { domain: str(p.merchant?.domain), name: str(p.merchant?.group_name) },
    scan: { verificationActive: scan.verification_active === true, whenToCheckBackSec: numOrNull(scan.when_to_check_back) },
    coupons,
  };
}

export function couponsConfigured(): boolean {
  return Boolean(config.sovrn.couponsEnabled() && config.sovrn.apiKey() && config.sovrn.siteKey());
}

/** Looks up promo codes for one retailer URL. Every response (errors too) is recorded for audit; successes are reused until Sovrn's check-back time. */
export async function fetchSovrnCoupons(productUrl: string, opts: { bypassCache?: boolean } = {}): Promise<CouponFetchOutcome> {
  const key = config.sovrn.apiKey();
  const site = config.sovrn.siteKey();
  if (!config.sovrn.couponsEnabled()) return { status: "UNAVAILABLE", reason: "SOVRN_COUPONS_ENABLED is off (the Promo Codes API needs registration with Sovrn Support)" };
  if (!key || !site) return { status: "UNAVAILABLE", reason: "SOVRN_API_KEY / SOVRN_SITE_KEY not configured" };
  const url = new URL(config.sovrn.couponsUrl());
  url.searchParams.set("api_key", site);
  url.searchParams.set("product_url", productUrl);
  url.searchParams.set("include_unverified", String(config.sovrn.couponsIncludeUnverified()));
  const queryKey = `coupons:${productUrl}`;
  const requestHash = sha256(`${url.toString()}|coupons`);
  const now = new Date();
  if (!opts.bypassCache) {
    const cached = await db.sovrnOfferCache.findUnique({ where: { requestHash } });
    if (cached && cached.expiresAt > now && (cached.providerStatus === "OK" || cached.providerStatus === "EMPTY")) {
      const data = normalizeCoupons(cached.rawResponse);
      if (data) return { status: data.coupons.length ? "OK" : "EMPTY", data, fromCache: true };
    }
  }
  const { result } = await withRetry(
    () => safeFetch(url.toString(), { headers: { Accept: "application/json", Authorization: `secret ${key}` }, timeoutMs: config.sovrn.timeoutMs(), maxRedirects: 2, readBody: true, maxBytes: 2_000_000 }),
    { retries: 2, shouldRetry: (r) => !r.ok && (r.error?.kind === "TIMEOUT" || isRetryableStatus(r.status)) },
  );
  const record = (providerStatus: string, expiresAt: Date, extra: { rawResponse?: unknown; httpStatus?: number; errorMessage?: string } = {}) => {
    const data = { queryKey, fetchedAt: now, expiresAt, providerStatus, httpStatus: extra.httpStatus ?? null, errorMessage: extra.errorMessage ?? null, rawResponse: extra.rawResponse === undefined ? Prisma.DbNull : (extra.rawResponse as Prisma.InputJsonValue) };
    return db.sovrnOfferCache.upsert({ where: { requestHash }, create: { requestHash, ...data }, update: data });
  };
  if (!result.ok) {
    const s = result.status;
    const status = result.error?.kind === "TIMEOUT" ? "TIMEOUT" : s === 401 || s === 403 ? "AUTH_FAILED" : s === 404 ? "NOT_FOUND" : s === 429 ? "RATE_LIMITED" : "PROVIDER_ERROR";
    const message =
      status === "AUTH_FAILED"
        ? `Sovrn refused the promo-code request (HTTP ${s}). The Product Promo Codes API needs registration with Sovrn Support and an approved site.`
        : (result.error?.message ?? `Sovrn promo codes HTTP ${s}`);
    // Back off: auth problems a day, other errors an hour.
    await record(status, new Date(now.getTime() + (status === "AUTH_FAILED" ? 24 : 1) * 3_600_000), { httpStatus: s || undefined, errorMessage: message });
    log.warn("sovrn coupon request failed", { stage: "OFFER_MATCHING", status: s, outcome: status });
    return { status, message, httpStatus: s || undefined };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.body ?? "");
  } catch {
    payload = undefined;
  }
  const data = normalizeCoupons(payload);
  if (!data) {
    await record("INVALID", new Date(now.getTime() + 3_600_000), { httpStatus: result.status, errorMessage: "Response has no coupons array", rawResponse: payload ?? undefined });
    return { status: "INVALID_RESPONSE", message: "Sovrn promo-code response did not contain a coupons array", httpStatus: result.status };
  }
  // Sovrn tells us when its background verification has more: honour it, else re-check daily.
  const backSec = data.scan.whenToCheckBackSec;
  const expires = new Date(now.getTime() + (data.scan.verificationActive && backSec ? Math.max(300, backSec) * 1000 : 24 * 3_600_000));
  await record(data.coupons.length ? "OK" : "EMPTY", expires, { rawResponse: payload, httpStatus: result.status });
  return { status: data.coupons.length ? "OK" : "EMPTY", data, fromCache: false };
}
