import { safeFetch } from "@/lib/net/safe-fetch";
import { bareHost, env, onDomain, parseHttpUrl, wellFormedAffiliateUrl, type AffiliateProvider } from "./types";

/**
 * Skimlinks. Links use Skimlinks' documented redirect format
 *   https://go.skimresources.com/?id=<PUBLISHER_ID>X<SITE_ID>&xs=1&url=<encoded destination>
 * but a destination is wrapped ONLY when the Skimlinks Merchant API (server-side, OAuth client
 * credentials) lists a merchant for that domain for this publisher. If the API is unreachable,
 * rejects the credentials or answers in an unexpected shape, the result is UNAVAILABLE and the
 * offer keeps its plain link.
 *
 * Env: SKIMLINKS_PUBLISHER_ID, SKIMLINKS_SITE_ID (numeric, from the Skimlinks Publisher Hub),
 *      SKIMLINKS_CLIENT_ID, SKIMLINKS_CLIENT_SECRET (Hub → Toolbox → API → API credentials).
 * Overridable only so tests can use a local stub: SKIMLINKS_AUTH_URL, SKIMLINKS_MERCHANT_API_URL.
 */

const REQUIRED = ["SKIMLINKS_PUBLISHER_ID", "SKIMLINKS_SITE_ID", "SKIMLINKS_CLIENT_ID", "SKIMLINKS_CLIENT_SECRET"] as const;
const authUrl = () => env("SKIMLINKS_AUTH_URL") ?? "https://authentication.skimapis.com/access_token";
const merchantBase = () => (env("SKIMLINKS_MERCHANT_API_URL") ?? "https://merchants.skimapis.com").replace(/\/+$/, "");

function missing(): string[] {
  return REQUIRED.filter((n) => {
    const v = env(n);
    if (!v) return true;
    return (n === "SKIMLINKS_PUBLISHER_ID" || n === "SKIMLINKS_SITE_ID") && !/^\d{1,12}$/.test(v);
  });
}

let token: { value: string; expiresAt: number; key: string } | undefined;
const merchantCache = new Map<string, { supported: boolean; at: number }>();
const CACHE_MS = 6 * 3_600_000;

/** Test hook: forget cached token and merchant answers. */
export function resetSkimlinksCache() {
  token = undefined;
  merchantCache.clear();
}

async function accessToken(): Promise<string> {
  const clientId = env("SKIMLINKS_CLIENT_ID")!;
  if (token && token.key === clientId && token.expiresAt > Date.now() + 60_000) return token.value;
  const res = await safeFetch(authUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: env("SKIMLINKS_CLIENT_SECRET"), grant_type: "client_credentials" }),
    timeoutMs: 10_000,
    maxRedirects: 0,
    readBody: true,
    maxBytes: 50_000,
  });
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? "Skimlinks rejected the API credentials" : `Skimlinks auth HTTP ${res.status || res.error?.kind}`);
  const data = JSON.parse(res.body ?? "{}") as { access_token?: unknown; expiry_timestamp?: unknown };
  if (typeof data.access_token !== "string" || !data.access_token) throw new Error("Skimlinks auth response has no access_token");
  const exp = typeof data.expiry_timestamp === "number" ? data.expiry_timestamp * 1000 : Date.now() + 3_600_000;
  token = { value: data.access_token, expiresAt: exp, key: clientId };
  return token.value;
}

/** Whether the Merchant API lists a merchant for this domain (true/false), or throws when it cannot answer. */
export async function skimlinksMerchantSupported(host: string): Promise<boolean> {
  const cached = merchantCache.get(host);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.supported;
  const t = await accessToken();
  const url = `${merchantBase()}/v4/publisher/${env("SKIMLINKS_PUBLISHER_ID")}/merchants?${new URLSearchParams({ access_token: t, search: host, limit: "50" })}`;
  const res = await safeFetch(url, { headers: { Accept: "application/json" }, timeoutMs: 10_000, maxRedirects: 0, readBody: true, maxBytes: 2_000_000 });
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? "Skimlinks Merchant API rejected the token" : `Skimlinks Merchant API HTTP ${res.status || res.error?.kind}`);
  const data = JSON.parse(res.body ?? "{}") as { merchants?: unknown };
  if (!Array.isArray(data.merchants)) throw new Error("Skimlinks Merchant API response has no merchants array");
  const supported = data.merchants.some((m) => {
    if (!m || typeof m !== "object") return false;
    const rec = m as { domains?: unknown; domain?: unknown };
    const domains = Array.isArray(rec.domains) ? rec.domains : typeof rec.domain === "string" ? [rec.domain] : [];
    return domains.some((d) => typeof d === "string" && d.trim() && onDomain(host, d.trim()));
  });
  merchantCache.set(host, { supported, at: Date.now() });
  return supported;
}

export const skimlinksProvider: AffiliateProvider = {
  name: "skimlinks",
  requiredEnv: REQUIRED,
  get active() {
    return missing().length === 0;
  },
  missingEnv: missing,
  supports: (url) => {
    const u = parseHttpUrl(url);
    return Boolean(u) && !/(^|\.)skimresources\.com$|(^|\.)skimlinks\.com$/i.test(u!.hostname);
  },
  async wrap(destinationUrl) {
    if (missing().length) return { status: "UNAVAILABLE", reason: `missing ${missing().join(", ")}` };
    const dest = parseHttpUrl(destinationUrl);
    if (!dest) return { status: "NOT_AFFILIATABLE", reason: "not an http(s) URL" };
    let supported: boolean;
    try {
      supported = await skimlinksMerchantSupported(bareHost(dest));
    } catch (error) {
      return { status: "UNAVAILABLE", reason: (error as Error).message.slice(0, 200) };
    }
    if (!supported) return { status: "NOT_AFFILIATABLE", reason: `Skimlinks lists no merchant for ${bareHost(dest)}` };
    const id = `${env("SKIMLINKS_PUBLISHER_ID")}X${env("SKIMLINKS_SITE_ID")}`;
    const built = `https://go.skimresources.com/?${new URLSearchParams({ id, xs: "1", url: dest.toString() })}`;
    const u = wellFormedAffiliateUrl(built);
    if (!u || u.hostname !== "go.skimresources.com" || u.searchParams.get("id") !== id || u.searchParams.get("url") !== dest.toString()) return { status: "UNAVAILABLE", reason: "generated Skimlinks link failed verification" };
    return { status: "AFFILIATED", affiliateUrl: u.toString(), provider: "skimlinks" };
  },
};
