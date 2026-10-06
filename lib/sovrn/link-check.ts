import { Prisma } from "@prisma/client";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { log, redactString } from "@/lib/log";
import { isRetryableStatus, safeFetch, validateOutboundUrl, withRetry, type SafeFetchResult } from "@/lib/net/safe-fetch";
import { sha256 } from "@/lib/util/text";
import { isProviderAffiliateUrl } from "./offers";

/**
 * Sovrn Commerce Link Check API (https://developer.sovrn.com/reference/link).
 *   GET https://api.viglink.com/api/link/?out=<merchant URL>&key=<PUBLIC site key>&format=json[&optimize=true][&geo=<cc>]
 * Answers whether Sovrn can monetise a merchant URL for this site. Needs no secret.
 * Every response is recorded in sovrn_offers_cache (queryKey "linkcheck:…"): successes are
 * reused for 24 h, errors for 15 min (so an outage is not hammered). The site key never appears
 * in a returned message or a log line.
 */

export const LINK_CHECK_PREFIX = "linkcheck:";
const OK_TTL_MS = 24 * 3_600_000;
const ERROR_TTL_MS = 15 * 60_000;

export type LinkCheckOk = { status: "OK"; affiliatable: boolean; competitive: boolean | null; eepc: number | null; optimizedUrl: string | null; fromCache: boolean };
export type LinkCheckError = { status: "UNAVAILABLE" | "PROVIDER_ERROR" | "INVALID_RESPONSE" | "INVALID_URL"; message: string; httpStatus?: number };
export type LinkCheckResult = LinkCheckOk | LinkCheckError;

/** A cache row as far as link checks need it (a test seam; production uses db.sovrnOfferCache). */
export type LinkCheckCacheRow = { queryKey: string; expiresAt: Date; providerStatus: string; httpStatus: number | null; errorMessage: string | null; rawResponse: unknown };
export type LinkCheckStore = {
  get(requestHash: string): Promise<LinkCheckCacheRow | null>;
  put(requestHash: string, row: LinkCheckCacheRow & { fetchedAt: Date }): Promise<void>;
};

export const dbLinkCheckStore: LinkCheckStore = {
  async get(requestHash) {
    return db.sovrnOfferCache.findUnique({ where: { requestHash }, select: { queryKey: true, expiresAt: true, providerStatus: true, httpStatus: true, errorMessage: true, rawResponse: true } });
  },
  async put(requestHash, row) {
    const data = {
      queryKey: row.queryKey,
      fetchedAt: row.fetchedAt,
      expiresAt: row.expiresAt,
      providerStatus: row.providerStatus,
      httpStatus: row.httpStatus,
      errorMessage: row.errorMessage,
      rawResponse: row.rawResponse === undefined || row.rawResponse === null ? Prisma.DbNull : (row.rawResponse as Prisma.InputJsonValue),
    };
    await db.sovrnOfferCache.upsert({ where: { requestHash }, create: { requestHash, ...data }, update: data });
  },
};

export type CheckLinkOptions = {
  geo?: string;
  /** Skip reading the cache (the fresh answer is still recorded). */
  bypassCache?: boolean;
  fetchImpl?: typeof safeFetch;
  store?: LinkCheckStore;
};

/** The queryKey recorded for a check (shown in Admin → Deals). */
export function linkCheckQueryKey(url: string, geo?: string): string {
  return `${LINK_CHECK_PREFIX}${url}${geo ? `|geo=${geo}` : ""}`;
}

/** Splits a recorded queryKey back into the checked URL and geo. */
export function parseLinkCheckQueryKey(queryKey: string): { url: string; geo?: string } {
  const rest = queryKey.startsWith(LINK_CHECK_PREFIX) ? queryKey.slice(LINK_CHECK_PREFIX.length) : queryKey;
  const i = rest.lastIndexOf("|geo=");
  return i >= 0 ? { url: rest.slice(0, i), geo: rest.slice(i + 5) } : { url: rest };
}

/** Strictly the documented 200 body: `affiliatable` must be a boolean; the optimized link is kept only on a Sovrn/VigLink host. */
export function parseLinkCheck(payload: unknown): Omit<LinkCheckOk, "status" | "fromCache"> | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p.affiliatable !== "boolean") return undefined;
  if (p.url !== undefined && p.url !== null && typeof p.url !== "string") return undefined;
  const optimized = typeof p.optimized === "string" ? p.optimized.trim() : "";
  const checked = optimized ? validateOutboundUrl(optimized, { standardPortsOnly: true }) : {};
  const optimizedUrl = checked.url && checked.url.protocol === "https:" && isProviderAffiliateUrl(checked.url.toString()) ? checked.url.toString() : null;
  return {
    affiliatable: p.affiliatable,
    competitive: typeof p.competitive === "boolean" ? p.competitive : null,
    eepc: typeof p.eepc === "number" && Number.isFinite(p.eepc) ? p.eepc : null,
    optimizedUrl,
  };
}

/** Removes the site key (and any configured secret) from text that may be shown or logged. */
function scrub(text: string, siteKey: string): string {
  let out = text;
  for (const v of [siteKey, encodeURIComponent(siteKey)]) if (v) out = out.split(v).join("[REDACTED]");
  return redactString(out).slice(0, 300);
}

function normaliseGeo(geo: string | undefined): string | undefined | null {
  if (geo === undefined) return undefined;
  const g = geo.trim();
  if (!g) return undefined;
  return /^[A-Za-z]{2}$/.test(g) ? g.toUpperCase() : null;
}

/** Asks Sovrn whether a merchant URL is monetisable for this site. Never throws for provider problems. */
export async function checkLink(url: string, opts: CheckLinkOptions = {}): Promise<LinkCheckResult> {
  const target = validateOutboundUrl(url, { standardPortsOnly: true });
  if (!target.url) return { status: "INVALID_URL", message: `URL rejected: ${target.error?.message ?? "invalid"}` };
  target.url.hash = "";
  const out = target.url.toString();
  const geo = normaliseGeo(opts.geo);
  if (geo === null) return { status: "INVALID_URL", message: "geo must be a two-letter country code" };

  const siteKey = config.sovrn.siteKey();
  if (!siteKey) return { status: "UNAVAILABLE", message: "SOVRN_SITE_KEY is not configured (or holds the secret key)" };
  let request: URL;
  try {
    request = new URL(config.sovrn.linkCheckUrl());
  } catch {
    return { status: "UNAVAILABLE", message: "SOVRN_LINK_CHECK_URL is not a valid URL" };
  }
  request.searchParams.set("out", out);
  request.searchParams.set("key", siteKey);
  request.searchParams.set("format", "json");
  if (geo) request.searchParams.set("geo", geo);

  const store = opts.store ?? dbLinkCheckStore;
  const queryKey = linkCheckQueryKey(out, geo);
  const requestHash = sha256(`${request.toString()}|linkcheck`);
  const now = new Date();

  if (!opts.bypassCache) {
    const cached = await store.get(requestHash);
    if (cached && cached.expiresAt > now) {
      if (cached.providerStatus === "OK") {
        const parsed = parseLinkCheck(cached.rawResponse);
        if (parsed) return { status: "OK", ...parsed, fromCache: true };
      } else if (cached.providerStatus === "PROVIDER_ERROR" || cached.providerStatus === "INVALID") {
        return {
          status: cached.providerStatus === "INVALID" ? "INVALID_RESPONSE" : "PROVIDER_ERROR",
          message: `${cached.errorMessage ?? "Sovrn link check failed"} (cached)`,
          httpStatus: cached.httpStatus ?? undefined,
        };
      }
    }
  }

  const fetcher = opts.fetchImpl ?? safeFetch;
  const { result } = await withRetry<SafeFetchResult>(
    () => fetcher(request.toString(), { headers: { Accept: "application/json" }, timeoutMs: config.sovrn.timeoutMs(), maxRedirects: 2, readBody: true, maxBytes: 200_000 }),
    { retries: 1, shouldRetry: (r) => !r.ok && (r.error?.kind === "TIMEOUT" || isRetryableStatus(r.status)) },
  );
  const record = (providerStatus: string, ttlMs: number, extra: { rawResponse?: unknown; httpStatus?: number; errorMessage?: string }) =>
    store
      .put(requestHash, { queryKey, fetchedAt: now, expiresAt: new Date(now.getTime() + ttlMs), providerStatus, httpStatus: extra.httpStatus ?? null, errorMessage: extra.errorMessage ?? null, rawResponse: extra.rawResponse ?? null })
      .catch((error: unknown) => log.warn("sovrn link check not recorded", { stage: "AFFILIATE_LINK", error: scrub(error instanceof Error ? error.message : String(error), siteKey) }));

  let payload: unknown;
  try {
    payload = result.body ? JSON.parse(result.body) : undefined;
  } catch {
    payload = undefined;
  }

  if (!result.ok) {
    const s = result.status;
    const providerMessage = payload && typeof payload === "object" && typeof (payload as { message?: unknown }).message === "string" ? (payload as { message: string }).message : undefined;
    const message = scrub(
      result.error ? `Sovrn link check failed: ${result.error.message}` : `Sovrn link check HTTP ${s}${providerMessage ? `: ${providerMessage}` : ""}`,
      siteKey,
    );
    await record("PROVIDER_ERROR", ERROR_TTL_MS, { httpStatus: s || undefined, errorMessage: message });
    log.warn("sovrn link check failed", { stage: "AFFILIATE_LINK", host: target.url.hostname, status: s, kind: result.error?.kind });
    return { status: "PROVIDER_ERROR", message, httpStatus: s || undefined };
  }

  const parsed = parseLinkCheck(payload);
  if (!parsed) {
    const message = "Sovrn link check response did not contain a boolean 'affiliatable' field";
    await record("INVALID", ERROR_TTL_MS, { httpStatus: result.status, errorMessage: message });
    return { status: "INVALID_RESPONSE", message, httpStatus: result.status };
  }
  await record("OK", OK_TTL_MS, { httpStatus: result.status, rawResponse: payload });
  log.info("sovrn link checked", { stage: "AFFILIATE_LINK", host: target.url.hostname, affiliatable: parsed.affiliatable });
  return { status: "OK", ...parsed, fromCache: false };
}
