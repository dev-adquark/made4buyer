import { config } from "@/lib/config";
import { log } from "@/lib/log";
import { safeFetch } from "@/lib/net/safe-fetch";
import { sha256 } from "@/lib/util/text";

/**
 * Sovrn Commerce Campaigns API: the account's campaigns (one per site/app) with Sovrn's own
 * approvalStatus. Auth: `authorization: secret <SOVRN_API_KEY>`. The response is JSONP
 * (`NULL({...})`) even without a callback parameter.
 *
 * Each campaign carries its PUBLIC site key (`apiKey`). It is used only to recognise this
 * site's campaign (apiKey === SOVRN_SITE_KEY) and is never returned or logged: callers get
 * `siteKeyHint` (first 6 characters) instead.
 */

export type SovrnCampaign = {
  campaignId: number | string;
  name: string;
  approvalStatus: string;
  applicationType: string | null;
  category: string | null;
  platform: string | null;
  optimize: boolean | null;
  isThisSite: boolean;
  siteKeyHint: string;
};

export type SovrnCampaignsResult =
  | { status: "OK"; accountId: number | null; campaigns: SovrnCampaign[] }
  | { status: "UNAVAILABLE" | "AUTH_FAILED" | "PROVIDER_ERROR" | "INVALID_RESPONSE"; message: string; httpStatus?: number };

export type SovrnApproval = {
  status: "APPROVED" | "PENDING" | "DENIED" | "UNKNOWN";
  source: "sovrn-api" | "env";
  campaign?: SovrnCampaign;
  message?: string;
};

type FetchImpl = typeof safeFetch;

const CACHE_MS = 5 * 60_000;
const MAX_PAGES = 10;
const ROWS_PER_PAGE = 100;
const cache = new Map<string, { at: number; value: Extract<SovrnCampaignsResult, { status: "OK" }> }>();

/** Test hook: forget cached campaign lists. */
export function clearSovrnCampaignsCache() {
  cache.clear();
}

/** Strips a JSONP wrapper such as `NULL({...})` or `cb({...});` and parses the JSON inside. */
export function parseJsonp(body: string): unknown {
  const text = body.trim();
  const m = /^[A-Za-z_$][\w$.]*\s*\(([\s\S]*)\)\s*;?$/.exec(text);
  return JSON.parse(m ? m[1] : text);
}

const strOrNull = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

function hint(key: string): string {
  return key ? `${key.slice(0, 6)}…` : "—";
}

function toCampaign(raw: Record<string, unknown>, siteKey: string | undefined): SovrnCampaign | null {
  const id = raw.campaignId;
  if (typeof id !== "number" && typeof id !== "string") return null;
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey : "";
  return {
    campaignId: id,
    name: strOrNull(raw.name) ?? strOrNull(raw.rawName) ?? String(id),
    approvalStatus: (strOrNull(raw.approvalStatus) ?? "UNKNOWN").toUpperCase(),
    applicationType: strOrNull(raw.applicationType),
    category: strOrNull(raw.category),
    platform: strOrNull(raw.platform),
    optimize: typeof raw.optimize === "boolean" ? raw.optimize : null,
    isThisSite: Boolean(siteKey && apiKey && apiKey === siteKey),
    siteKeyHint: hint(apiKey),
  };
}

/** Lists every campaign in the Sovrn account behind SOVRN_API_KEY (cached 5 minutes; errors are not cached). */
export async function fetchSovrnCampaigns(opts: { fetchImpl?: FetchImpl; bypassCache?: boolean } = {}): Promise<SovrnCampaignsResult> {
  const key = config.sovrn.apiKey();
  if (!key) return { status: "UNAVAILABLE", message: "SOVRN_API_KEY is not configured (BLOCKED_BY_ENVIRONMENT)" };
  const base = config.sovrn.campaignsUrl().replace(/\/+$/, "");
  const siteKey = config.sovrn.siteKey();
  const cacheKey = `${sha256(key).slice(0, 16)}|${base}|${siteKey ?? ""}`;
  if (!opts.bypassCache) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  }
  const doFetch = opts.fetchImpl ?? safeFetch;

  const campaigns: SovrnCampaign[] = [];
  let accountId: number | null = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let url: string;
    try {
      const u = new URL(`${base}/PRIMARY`);
      u.searchParams.set("format", "json");
      u.searchParams.set("rowsPerPage", String(ROWS_PER_PAGE));
      if (page > 1) u.searchParams.set("page", String(page));
      url = u.toString();
    } catch {
      return { status: "INVALID_RESPONSE", message: "SOVRN_CAMPAIGNS_URL is not a valid URL" };
    }
    const res = await doFetch(url, {
      headers: { Accept: "application/json", authorization: `secret ${key}` },
      timeoutMs: config.sovrn.timeoutMs(),
      maxRedirects: 2,
      readBody: true,
      maxBytes: 2_000_000,
    });
    if (!res.ok) {
      const auth = res.status === 401 || res.status === 403;
      const message = auth
        ? `Sovrn rejected the Campaigns API request (HTTP ${res.status}): check that SOVRN_API_KEY is the account's secret key, not the public site key.`
        : res.error
          ? `Sovrn Campaigns API request failed (${res.error.kind})`
          : `Sovrn Campaigns API HTTP ${res.status}`;
      log.warn("sovrn campaigns request failed", { status: res.status, error: res.error?.kind });
      return { status: auth ? "AUTH_FAILED" : "PROVIDER_ERROR", message, httpStatus: res.status || undefined };
    }
    let payload: unknown;
    try {
      payload = parseJsonp(res.body ?? "");
    } catch {
      return { status: "INVALID_RESPONSE", message: "Sovrn Campaigns API response is not valid JSON", httpStatus: res.status };
    }
    const obj = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
    if (!obj || !Array.isArray(obj.campaigns)) {
      return { status: "INVALID_RESPONSE", message: "Sovrn Campaigns API response has no campaigns array", httpStatus: res.status };
    }
    const profile = obj.queryProfile && typeof obj.queryProfile === "object" ? (obj.queryProfile as Record<string, unknown>) : {};
    if (accountId === null && typeof profile.accountId === "number") accountId = profile.accountId;
    const batch = obj.campaigns
      .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object")
      .map((c) => toCampaign(c, siteKey))
      .filter((c): c is SovrnCampaign => c !== null);
    campaigns.push(...batch);
    const total = typeof obj.totalResults === "number" ? obj.totalResults : campaigns.length;
    if (!obj.campaigns.length || campaigns.length >= total) break;
  }

  const value = { status: "OK" as const, accountId, campaigns };
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}

/**
 * This site's approval status, live from the Sovrn campaign whose public key is SOVRN_SITE_KEY.
 * Falls back to the manual SOVRN_SITE_STATUS when the API or a matching campaign is unavailable.
 */
export async function sovrnApprovalStatus(opts: { fetchImpl?: FetchImpl; bypassCache?: boolean } = {}): Promise<SovrnApproval> {
  const env = (message: string): SovrnApproval => ({ status: config.sovrn.siteStatus(), source: "env", message });
  if (!config.sovrn.siteKey()) {
    return env(config.sovrn.siteKeyIsSecret() ? "SOVRN_SITE_KEY holds the secret key, so this site's campaign cannot be identified" : "SOVRN_SITE_KEY is not configured, so this site's campaign cannot be identified");
  }
  const res = await fetchSovrnCampaigns(opts);
  if (res.status !== "OK") return env(`Sovrn Campaigns API unavailable: ${res.message}`);
  const campaign = res.campaigns.find((c) => c.isThisSite);
  if (!campaign) return env("no campaign in this Sovrn account uses SOVRN_SITE_KEY");
  const raw = campaign.approvalStatus;
  if (raw === "APPROVED" || raw === "PENDING" || raw === "DENIED") return { status: raw, source: "sovrn-api", campaign };
  return { status: "UNKNOWN", source: "sovrn-api", campaign, message: `Sovrn reports approvalStatus "${raw}"` };
}
