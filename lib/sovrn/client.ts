import { Prisma } from "@prisma/client";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { isRetryableStatus, safeFetch, withRetry } from "@/lib/net/safe-fetch";
import { sha256 } from "@/lib/util/text";
import { buildQueryString, normalizeOffers, extractOfferArray, type NormalizedOffer, type OfferQuery } from "./offers";

/**
 * Production Sovrn Commerce adapter (stage OFFER_MATCHING, fetch half).
 * Configuration (env): SOVRN_API_URL (full endpoint; may contain {query}), SOVRN_API_KEY,
 * SOVRN_AUTH_SCHEME (default "secret" → `Authorization: secret <key>`), SOVRN_QUERY_PARAM.
 * Every response — including errors — is recorded in sovrn_offers_cache for audit; only
 * successful responses are reused until expiresAt.
 */

export type SovrnFetchOutcome =
  | { status: "OK"; offers: NormalizedOffer[]; cacheId: string; fromCache: boolean; queryKey: string }
  | { status: "EMPTY"; offers: NormalizedOffer[]; cacheId: string; fromCache: boolean; queryKey: string }
  | { status: "UNAVAILABLE"; reason: string; queryKey: string }
  | { status: "TIMEOUT" | "PROVIDER_ERROR" | "INVALID_RESPONSE"; message: string; httpStatus?: number; cacheId?: string; queryKey: string };

export function sovrnConfigured(): boolean {
  return Boolean(config.sovrn.apiUrl() && config.sovrn.apiKey());
}

export function buildSovrnRequestUrl(base: string, queryKey: string, param: string): string {
  if (base.includes("{query}")) return base.replace("{query}", encodeURIComponent(queryKey));
  const url = new URL(base);
  url.searchParams.set(param, queryKey);
  return url.toString();
}

export async function fetchSovrnOffers(query: OfferQuery, opts: { bypassCache?: boolean } = {}): Promise<SovrnFetchOutcome> {
  const queryKey = buildQueryString(query);
  const base = config.sovrn.apiUrl();
  const key = config.sovrn.apiKey();
  if (!base || !key) return { status: "UNAVAILABLE", reason: "SOVRN_API_URL / SOVRN_API_KEY not configured (BLOCKED_BY_ENVIRONMENT)", queryKey };

  let requestUrl: string;
  try {
    requestUrl = buildSovrnRequestUrl(base, queryKey, config.sovrn.queryParam());
  } catch {
    return { status: "INVALID_RESPONSE", message: "SOVRN_API_URL is not a valid URL", queryKey };
  }
  const requestHash = sha256(`${requestUrl}|${config.sovrn.authScheme()}`);
  const now = new Date();

  if (!opts.bypassCache) {
    const cached = await db.sovrnOfferCache.findUnique({ where: { requestHash } });
    if (cached && cached.expiresAt > now && (cached.providerStatus === "OK" || cached.providerStatus === "EMPTY")) {
      const offers = normalizeOffers(cached.rawResponse);
      return offers.length ? { status: "OK", offers, cacheId: cached.id, fromCache: true, queryKey } : { status: "EMPTY", offers, cacheId: cached.id, fromCache: true, queryKey };
    }
  }

  const { result, attempts } = await withRetry(
    () =>
      safeFetch(requestUrl, {
        headers: { Accept: "application/json", Authorization: `${config.sovrn.authScheme()} ${key}` },
        timeoutMs: config.sovrn.timeoutMs(),
        maxRedirects: 2,
        readBody: true,
        maxBytes: 5_000_000,
      }),
    { retries: 2, shouldRetry: (r) => !r.ok && (r.error?.kind === "TIMEOUT" || isRetryableStatus(r.status)) },
  );

  const ttlMs = config.sovrn.cacheTtlMinutes() * 60_000;
  const record = async (data: { providerStatus: string; rawResponse?: unknown; httpStatus?: number; errorMessage?: string; expiresAt: Date }) => {
    const payload = {
      queryKey,
      fetchedAt: now,
      expiresAt: data.expiresAt,
      providerStatus: data.providerStatus,
      httpStatus: data.httpStatus ?? null,
      errorMessage: data.errorMessage ?? null,
      rawResponse: data.rawResponse === undefined ? Prisma.DbNull : (data.rawResponse as Prisma.InputJsonValue),
    };
    const row = await db.sovrnOfferCache.upsert({ where: { requestHash }, create: { requestHash, ...payload }, update: payload });
    return row.id;
  };

  if (!result.ok) {
    const timeout = result.error?.kind === "TIMEOUT";
    const message = result.error?.message ?? `Sovrn HTTP ${result.status}`;
    const cacheId = await record({ providerStatus: timeout ? "TIMEOUT" : "ERROR", httpStatus: result.status || undefined, errorMessage: message, expiresAt: new Date(now.getTime() + 5 * 60_000) });
    log.warn("sovrn request failed", { stage: "OFFER_MATCHING", queryKey, status: result.status, attempts, error: message });
    return { status: timeout ? "TIMEOUT" : "PROVIDER_ERROR", message, httpStatus: result.status || undefined, cacheId, queryKey };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(result.body ?? "");
  } catch {
    const cacheId = await record({ providerStatus: "INVALID", httpStatus: result.status, errorMessage: "Response is not JSON", expiresAt: new Date(now.getTime() + 5 * 60_000) });
    return { status: "INVALID_RESPONSE", message: "Sovrn response is not valid JSON", httpStatus: result.status, cacheId, queryKey };
  }
  if (!extractOfferArray(payload)) {
    const cacheId = await record({ providerStatus: "INVALID", rawResponse: payload, httpStatus: result.status, errorMessage: "No offer array in response", expiresAt: new Date(now.getTime() + 5 * 60_000) });
    return { status: "INVALID_RESPONSE", message: "Sovrn response did not contain an offer array", httpStatus: result.status, cacheId, queryKey };
  }
  const offers = normalizeOffers(payload);
  const cacheId = await record({ providerStatus: offers.length ? "OK" : "EMPTY", rawResponse: payload, httpStatus: result.status, expiresAt: new Date(now.getTime() + ttlMs) });
  log.info("sovrn offers fetched", { stage: "OFFER_MATCHING", queryKey, offers: offers.length, attempts });
  return offers.length ? { status: "OK", offers, cacheId, fromCache: false, queryKey } : { status: "EMPTY", offers, cacheId, fromCache: false, queryKey };
}
