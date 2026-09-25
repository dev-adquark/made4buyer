import crypto from "node:crypto";
import { config } from "@/lib/config";

/**
 * Google Search Console integration via service-account JWT (read-only scope).
 *  - Search Analytics (clicks/impressions) for the admin GSC page
 *  - URL Inspection for indexing status used by the Day-30 report
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

let cachedToken: { token: string; expiresAt: number } | undefined;

async function accessToken(): Promise<string> {
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
  const claims = b64(JSON.stringify({ iss: account.client_email, scope: "https://www.googleapis.com/auth/webmasters.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const input = `${header}.${claims}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(input);
  const assertion = `${input}.${signer.sign(account.private_key, "base64url")}`;
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion });
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Google token request failed: HTTP ${res.status}`);
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("Google token response missing access_token");
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return data.access_token;
}

async function analyticsQuery(site: string, token: string, startDate: string, endDate: string, dimensions: string[]) {
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`;
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
  const res = await fetch("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
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
