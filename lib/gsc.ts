import crypto from "node:crypto";
import { config } from "@/lib/config";
import { audit, SYSTEM_ACTOR } from "@/lib/security/audit";

/**
 * Google Search Console integration via service-account JWT (read-only scope).
 *  - Search Analytics (clicks/impressions) for the admin GSC page
 *  - URL Inspection for indexing status used by the Day-30 report
 *  - Sitemap status + submission of /sitemap.xml (needs the service account as a FULL user;
 *    uses the `webmasters` scope only for that one call, read-only scope everywhere else)
 * When GSC_SITE_URL / GSC_SERVICE_ACCOUNT_JSON are missing everything reports
 * NOT_AVAILABLE_IN_ENVIRONMENT; no indexing numbers are ever estimated.
 */

type GscRow = { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number };
type GscApiResponse = { rows?: GscRow[] };
export type GscSummary = { clicks: number; impressions: number; ctr: number; position: number; rows: GscRow[]; startDate: string; endDate: string };

const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");

export function gscConfigured(): boolean {
  return Boolean(config.gsc.siteUrl() && config.gsc.serviceAccountJson());
}

const READONLY_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const FULL_SCOPE = "https://www.googleapis.com/auth/webmasters";
const cachedTokens = new Map<string, { token: string; expiresAt: number }>();

/** Test hook: forget cached Google access tokens. */
export function resetGscTokenCache() {
  cachedTokens.clear();
}

/** Google endpoints; overridable only so tests can use a local stub. */
const tokenUrl = () => process.env.GSC_TOKEN_URL?.trim() || "https://oauth2.googleapis.com/token";
const webmastersBase = () => (process.env.GSC_API_BASE_URL?.trim() || "https://www.googleapis.com/webmasters/v3").replace(/\/+$/, "");
const inspectionUrl = () => process.env.GSC_INSPECTION_URL?.trim() || "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

async function accessToken(scope = READONLY_SCOPE): Promise<string> {
  const cachedToken = cachedTokens.get(scope);
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const raw = config.gsc.serviceAccountJson();
  if (!raw) throw new Error("GSC_SERVICE_ACCOUNT_JSON is not configured");
  let account: { client_email?: string; private_key?: string };
  try {
    account = JSON.parse(raw);
  } catch {
    throw new Error("GSC_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  if (!account.client_email || !account.private_key) throw new Error("GSC_SERVICE_ACCOUNT_JSON is missing client_email or private_key");
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64(JSON.stringify({ iss: account.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const input = `${header}.${claims}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(input);
  const assertion = `${input}.${signer.sign(account.private_key, "base64url")}`;
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion });
  const res = await fetch(tokenUrl(), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Google token request failed: HTTP ${res.status}`);
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("Google token response missing access_token");
  cachedTokens.set(scope, { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 });
  return data.access_token;
}

async function analyticsQuery(site: string, token: string, startDate: string, endDate: string, dimensions: string[]) {
  const endpoint = `${webmastersBase()}/sites/${encodeURIComponent(site)}/searchAnalytics/query`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ startDate, endDate, dimensions, rowLimit: 25000, startRow: 0 }),
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Search Console query failed: HTTP ${res.status}`);
  return (await res.json()) as GscApiResponse;
}

export async function querySearchConsole(startDate: string, endDate: string): Promise<GscSummary> {
  const site = config.gsc.siteUrl();
  if (!site) throw new Error("GSC_SITE_URL is not configured");
  const token = await accessToken();
  const daily = (await analyticsQuery(site, token, startDate, endDate, ["date"])).rows ?? [];
  const overall = (await analyticsQuery(site, token, startDate, endDate, [])).rows?.[0];
  const clicks = overall?.clicks ?? daily.reduce((n, x) => n + (x.clicks ?? 0), 0);
  const impressions = overall?.impressions ?? daily.reduce((n, x) => n + (x.impressions ?? 0), 0);
  return { clicks, impressions, ctr: overall?.ctr ?? (impressions ? clicks / impressions : 0), position: overall?.position ?? 0, rows: daily, startDate, endDate };
}

export type InspectionResult = { verdict: "INDEXED" | "NOT_INDEXED" | "UNKNOWN"; coverageState?: string; lastCrawlTime?: Date };

/** URL Inspection API: verdict PASS → INDEXED, FAIL/NEUTRAL → NOT_INDEXED. */
export async function inspectUrl(url: string): Promise<InspectionResult> {
  const site = config.gsc.siteUrl();
  if (!site) throw new Error("GSC_SITE_URL is not configured");
  const token = await accessToken();
  const res = await fetch(inspectionUrl(), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ inspectionUrl: url, siteUrl: site }),
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`URL inspection failed: HTTP ${res.status}`);
  const data = (await res.json()) as { inspectionResult?: { indexStatusResult?: { verdict?: string; coverageState?: string; lastCrawlTime?: string } } };
  const status = data.inspectionResult?.indexStatusResult;
  const verdict = status?.verdict === "PASS" ? "INDEXED" : status?.verdict === "FAIL" || status?.verdict === "NEUTRAL" ? "NOT_INDEXED" : "UNKNOWN";
  return { verdict, coverageState: status?.coverageState, lastCrawlTime: status?.lastCrawlTime ? new Date(status.lastCrawlTime) : undefined };
}

export type GscAccess = { ok: true; siteUrl: string; permissionLevel: string } | { ok: false; reason: string; httpStatus?: number };

/**
 * Confirms the service account can read the configured property (sites.get). 403 means the
 * service account has not been added to the property; 404 means GSC_SITE_URL doesn't match.
 */
export async function checkGscAccess(): Promise<GscAccess> {
  const site = config.gsc.siteUrl();
  if (!site || !config.gsc.serviceAccountJson()) return { ok: false, reason: "GSC_SITE_URL / GSC_SERVICE_ACCOUNT_JSON not configured (NOT_AVAILABLE_IN_ENVIRONMENT)" };
  let token: string;
  try {
    token = await accessToken();
  } catch (error) {
    return { ok: false, reason: `authentication failed: ${(error as Error).message}` };
  }
  const res = await fetch(`${webmastersBase()}/sites/${encodeURIComponent(site)}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (res.status === 403) return { ok: false, httpStatus: 403, reason: "the service account has no access to this property: add its client_email as a user in Search Console" };
  if (res.status === 404) return { ok: false, httpStatus: 404, reason: `property ${site} not found: GSC_SITE_URL must match the property exactly (e.g. sc-domain:example.com)` };
  if (!res.ok) return { ok: false, httpStatus: res.status, reason: `Search Console returned HTTP ${res.status}` };
  const data = (await res.json()) as { siteUrl?: string; permissionLevel?: string };
  return { ok: true, siteUrl: data.siteUrl ?? site, permissionLevel: data.permissionLevel ?? "unknown" };
}

// ── Sitemaps ──────────────────────────────────────────────────────────────

export type GscSitemap = { path: string; lastSubmitted?: string; lastDownloaded?: string; isPending?: boolean; errors?: number; warnings?: number; submitted?: number; indexed?: number };

/** The sitemap this site serves (app/sitemap.ts), unless GSC_SITEMAP_URL overrides it. */
export function sitemapUrl(): string {
  return process.env.GSC_SITEMAP_URL?.trim() || `${gscSiteBase()}/sitemap.xml`;
}

/** Public site origin: NEXT_PUBLIC_SITE_URL, else a URL-prefix GSC_SITE_URL, else the config default. */
export function gscSiteBase(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL?.trim()) return config.siteUrl();
  const site = config.gsc.siteUrl();
  return site && /^https?:\/\//.test(site) ? site.replace(/\/+$/, "") : config.siteUrl();
}

/** sitemaps.list for the property (read-only scope). */
export async function listSitemaps(): Promise<GscSitemap[]> {
  const site = config.gsc.siteUrl();
  if (!site) throw new Error("GSC_SITE_URL is not configured");
  const token = await accessToken();
  const res = await fetch(`${webmastersBase()}/sites/${encodeURIComponent(site)}/sitemaps`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Search Console sitemaps.list failed: HTTP ${res.status}`);
  const data = (await res.json()) as { sitemap?: Array<{ path?: string; lastSubmitted?: string; lastDownloaded?: string; isPending?: boolean; errors?: string | number; warnings?: string | number; contents?: Array<{ submitted?: string | number; indexed?: string | number }> }> };
  return (data.sitemap ?? [])
    .filter((m) => typeof m.path === "string")
    .map((m) => ({
      path: m.path!,
      lastSubmitted: m.lastSubmitted,
      lastDownloaded: m.lastDownloaded,
      isPending: m.isPending,
      errors: m.errors === undefined ? undefined : Number(m.errors),
      warnings: m.warnings === undefined ? undefined : Number(m.warnings),
      submitted: m.contents?.length ? m.contents.reduce((n, c) => n + Number(c.submitted ?? 0), 0) : undefined,
      indexed: m.contents?.length ? m.contents.reduce((n, c) => n + Number(c.indexed ?? 0), 0) : undefined,
    }));
}

/**
 * sitemaps.submit (PUT). Needs the `webmasters` scope and the service account added to the
 * property with FULL permission (Restricted users get HTTP 403).
 */
export async function submitSitemap(feedpath = sitemapUrl()): Promise<{ ok: true } | { ok: false; httpStatus: number; reason: string }> {
  const site = config.gsc.siteUrl();
  if (!site) throw new Error("GSC_SITE_URL is not configured");
  const token = await accessToken(FULL_SCOPE);
  const res = await fetch(`${webmastersBase()}/sites/${encodeURIComponent(site)}/sitemaps/${encodeURIComponent(feedpath)}`, { method: "PUT", headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (res.ok) return { ok: true };
  const reason = res.status === 403 ? "the service account needs FULL permission on the property to submit sitemaps" : res.status === 404 ? "property not found: check GSC_SITE_URL" : `HTTP ${res.status}`;
  return { ok: false, httpStatus: res.status, reason };
}

export type GscMaintenance = { status: "OK" | "NOT_AVAILABLE_IN_ENVIRONMENT" | "ERROR"; sitemap?: { url: string; action: "submitted" | "already_current" | "submit_failed"; reason?: string; lastSubmitted?: string | null; indexed?: number | null; errors?: number | null }; analytics?: { startDate: string; endDate: string; clicks: number; impressions: number; days: number } | { error: string } };

/**
 * Daily (from the inspect-index job): submit the sitemap when it was never submitted or not in
 * the last 7 days, then record a 28-day clicks/impressions snapshot (the API's own numbers;
 * nothing estimated) in the audit log so Admin → Integrations can show the last successful call.
 */
export async function runGscMaintenance(now = new Date()): Promise<GscMaintenance> {
  if (!gscConfigured()) return { status: "NOT_AVAILABLE_IN_ENVIRONMENT" };
  const out: GscMaintenance = { status: "OK" };
  const url = sitemapUrl();
  try {
    const current = (await listSitemaps()).find((m) => m.path === url);
    const due = !current?.lastSubmitted || now.getTime() - new Date(current.lastSubmitted).getTime() > 7 * 86_400_000;
    if (due) {
      const r = await submitSitemap(url);
      out.sitemap = r.ok ? { url, action: "submitted", lastSubmitted: now.toISOString() } : { url, action: "submit_failed", reason: r.reason, lastSubmitted: current?.lastSubmitted ?? null };
      if (!r.ok) out.status = "ERROR";
    } else out.sitemap = { url, action: "already_current", lastSubmitted: current.lastSubmitted ?? null, indexed: current.indexed ?? null, errors: current.errors ?? null };
  } catch (error) {
    out.status = "ERROR";
    out.sitemap = { url, action: "submit_failed", reason: (error as Error).message.slice(0, 200) };
  }
  const end = new Date(now);
  end.setUTCDate(end.getUTCDate() - 2);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 27);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  try {
    const q = await querySearchConsole(iso(start), iso(end));
    out.analytics = { startDate: q.startDate, endDate: q.endDate, clicks: q.clicks, impressions: q.impressions, days: q.rows.length };
  } catch (error) {
    out.status = "ERROR";
    out.analytics = { error: (error as Error).message.slice(0, 200) };
  }
  await audit(SYSTEM_ACTOR, { action: "gsc.maintenance", entityType: "site", entityId: "gsc", metadata: out }).catch(() => undefined);
  return out;
}

/**
 * Google site-verification meta tag (HTML-tag method). Spread into the root layout's metadata:
 *   export const metadata = { ..., ...gscVerificationMetadata() }
 * GOOGLE_SITE_VERIFICATION is the `content` value Search Console shows (public, not a secret).
 */
export function gscVerificationMetadata(): { verification?: { google: string } } {
  const token = process.env.GOOGLE_SITE_VERIFICATION?.trim();
  return token && /^[A-Za-z0-9_-]{10,100}$/.test(token) ? { verification: { google: token } } : {};
}
