import { config } from "@/lib/config";
import { PipelineError } from "@/lib/errors";
import { log } from "@/lib/log";
import { isRetryableStatus, safeFetch, withRetry } from "@/lib/net/safe-fetch";
import { validateContentItem, type ValidationCode } from "./validate";

/**
 * Stage CONTENT_FETCH. Configurable Content API adapter:
 *  - CONTENT_API_URL, CONTENT_API_KEY, CONTENT_API_AUTH_HEADER / CONTENT_API_AUTH_SCHEME
 *  - bounded timeout and exponential-backoff retries on timeouts / 408 / 429 / 5xx
 *  - response: an array, or an object with items|results|data|reviews|articles array
 *  - optional pagination via `next` / `nextPage` / `links.next` (absolute URL, same origin),
 *    bounded by CONTENT_API_MAX_PAGES
 *  - versioned contract (docs/CONTENT_API_CONTRACT.md): a feed that declares a schema version
 *    (body `schemaVersion` / `schema_version` / `apiVersion` / `version` / `meta.schemaVersion`, or
 *    header `X-Schema-Version` / `Api-Version` / `X-Api-Version`) must declare the supported major
 *    version (CONTENT_API_SCHEMA_VERSION, default "1"). A non-empty page on which EVERY item is
 *    structurally invalid (no id or title under any accepted alias) is a schema mismatch too.
 *    Both abort the run with CONTENT_API_SCHEMA_MISMATCH, which Admin → Ingestion runs and
 *    Admin → Failures show with the declared version / the fields actually received.
 */

/** The contract version this adapter implements (major only; minor additions are tolerated). */
export const CONTENT_API_CONTRACT_VERSION = "1";
export const CONTENT_API_REQUIRED_FIELDS = ["id (or sourceId/source_id/guid/uuid)", "title (or headline/name)", "body (or content/text/html/articleBody)"] as const;

export type FetchedBatch = { source: string; items: unknown[]; pages: number };

export function contentSourceName(): string {
  const configured = config.contentApi.sourceName();
  if (configured) return configured;
  const url = config.contentApi.url();
  if (!url) return "unconfigured";
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid-url";
  }
}

function extractItems(payload: unknown): unknown[] | undefined {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  for (const key of ["items", "results", "data", "reviews", "articles", "content"]) {
    if (Array.isArray(p[key])) return p[key] as unknown[];
  }
  return undefined;
}

function nextPage(payload: unknown, current: URL): URL | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const p = payload as Record<string, unknown>;
  const links = p.links && typeof p.links === "object" ? (p.links as Record<string, unknown>) : {};
  const raw = [p.next, p.nextPage, p.next_page, links.next].find((v) => typeof v === "string" && v) as string | undefined;
  if (!raw) return undefined;
  try {
    const next = new URL(raw, current);
    return next.origin === current.origin ? next : undefined;
  } catch {
    return undefined;
  }
}

/** Request headers for the Content API (auth header/scheme are configurable). Server-side only. */
export function contentApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const key = config.contentApi.key();
  if (key) {
    const header = config.contentApi.authHeader();
    headers[header] = header.toLowerCase() === "authorization" ? `${config.contentApi.authScheme()} ${key}`.trim() : key;
  }
  return headers;
}

export { extractItems as extractContentItems, nextPage as nextContentPage };

/** Schema version the feed declares in its body or headers, if any. */
export function declaredSchemaVersion(payload: unknown, headers: Record<string, string> = {}): string | undefined {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const p = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const meta = p.meta && typeof p.meta === "object" ? (p.meta as Record<string, unknown>) : {};
  const candidates = [p.schemaVersion, p.schema_version, p.apiVersion, p.api_version, p.version, meta.schemaVersion, meta.version, lower["x-schema-version"], lower["api-version"], lower["x-api-version"]];
  const v = candidates.find((x) => (typeof x === "string" && x.trim()) || typeof x === "number");
  return v === undefined ? undefined : String(v).trim().replace(/^v/i, "");
}

const major = (v: string) => v.split(/[.\-]/)[0];

/** Expected major version (CONTENT_API_SCHEMA_VERSION, default the contract version). */
export function expectedSchemaVersion(): string {
  return (process.env.CONTENT_API_SCHEMA_VERSION?.trim() || CONTENT_API_CONTRACT_VERSION).replace(/^v/i, "");
}

export type PageSchemaCheck = { ok: true; declaredVersion?: string; valid: number; invalid: number; invalidByCode: Partial<Record<ValidationCode, number>> } | { ok: false; reason: string; declaredVersion?: string; fieldsSeen: string[] };

/**
 * Contract check for one page: declared version (if any) must match, and a non-empty page must
 * not be entirely structurally invalid. Field NAMES (never values) are reported on mismatch.
 */
export function checkPageSchema(payload: unknown, items: unknown[], headers: Record<string, string> = {}): PageSchemaCheck {
  const declaredVersion = declaredSchemaVersion(payload, headers);
  const fieldsSeen = [...new Set(items.flatMap((i) => (i && typeof i === "object" && !Array.isArray(i) ? Object.keys(i) : [typeof i])))].slice(0, 40);
  if (declaredVersion !== undefined && major(declaredVersion) !== major(expectedSchemaVersion())) {
    return { ok: false, declaredVersion, fieldsSeen, reason: `feed declares schema version ${declaredVersion}, this site supports version ${major(expectedSchemaVersion())} (set CONTENT_API_SCHEMA_VERSION only after the adapter supports the new contract)` };
  }
  let valid = 0;
  let structural = 0;
  const invalidByCode: Partial<Record<ValidationCode, number>> = {};
  for (const item of items) {
    const v = validateContentItem(item);
    if (v.ok) valid++;
    else {
      invalidByCode[v.code] = (invalidByCode[v.code] ?? 0) + 1;
      if (v.issues.some((i) => /^(sourceId|title|item):/.test(i))) structural++;
    }
  }
  if (items.length > 0 && structural === items.length) {
    return { ok: false, declaredVersion, fieldsSeen, reason: `none of the ${items.length} item(s) has the required fields ${CONTENT_API_REQUIRED_FIELDS.slice(0, 2).join(", ")}; fields received: ${fieldsSeen.join(", ") || "(none)"}` };
  }
  return { ok: true, declaredVersion, valid, invalid: items.length - valid, invalidByCode };
}

export async function fetchContentBatch(): Promise<FetchedBatch> {
  const url = config.contentApi.url();
  if (!url) throw new PipelineError("CONTENT_API_NOT_CONFIGURED", "CONTENT_API_URL is not configured (BLOCKED_BY_ENVIRONMENT)");
  let endpoint: URL;
  try {
    endpoint = new URL(url);
  } catch {
    throw new PipelineError("CONTENT_API_NOT_CONFIGURED", "CONTENT_API_URL is not a valid URL");
  }
  const headers = contentApiHeaders();

  const items: unknown[] = [];
  let pages = 0;
  let current: URL | undefined = endpoint;
  const seen = new Set<string>();
  while (current && pages < config.contentApi.maxPages()) {
    if (seen.has(current.toString())) break;
    seen.add(current.toString());
    const target: string = current.toString();
    const { result, attempts } = await withRetry(
      () => safeFetch(target, { headers, timeoutMs: config.contentApi.timeoutMs(), maxRedirects: 3, readBody: true, maxBytes: 20_000_000 }),
      { retries: config.contentApi.maxRetries(), shouldRetry: (r) => !r.ok && (r.error?.kind === "TIMEOUT" || isRetryableStatus(r.status)) },
    );
    if (!result.ok) {
      if (result.error?.kind === "TIMEOUT") throw new PipelineError("CONTENT_API_TIMEOUT", `Content API timed out after ${attempts} attempt(s)`);
      throw new PipelineError(
        "CONTENT_API_HTTP_ERROR",
        result.error ? `Content API request failed: ${result.error.kind} ${result.error.message}` : `Content API returned HTTP ${result.status} after ${attempts} attempt(s)`,
        { status: result.status },
        result.error ? result.error.kind !== "BLOCKED_HOST" : isRetryableStatus(result.status),
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(result.body ?? "");
    } catch {
      throw new PipelineError("CONTENT_API_RESPONSE_INVALID", "Content API response is not valid JSON");
    }
    const pageItems = extractItems(payload);
    if (!pageItems) {
      const keys = payload && typeof payload === "object" ? Object.keys(payload).slice(0, 20).join(", ") : typeof payload;
      throw new PipelineError("CONTENT_API_RESPONSE_INVALID", `Content API response must be an array or contain an items/results/data/reviews/articles/content array (top-level keys received: ${keys || "(none)"})`);
    }
    const schema = checkPageSchema(payload, pageItems, result.headers);
    if (!schema.ok) throw new PipelineError("CONTENT_API_SCHEMA_MISMATCH", `Content API schema mismatch on page ${pages + 1}: ${schema.reason}`, { declaredVersion: schema.declaredVersion ?? null, fieldsSeen: schema.fieldsSeen });
    items.push(...pageItems);
    pages++;
    log.info("content page fetched", { stage: "CONTENT_FETCH", page: pages, items: pageItems.length, attempts });
    current = nextPage(payload, current);
  }
  return { source: contentSourceName(), items, pages };
}

export type ContentApiProbe =
  | { status: "BLOCKED_BY_ENVIRONMENT"; missing: string[] }
  | { status: "HTTP_ERROR" | "INVALID_RESPONSE" | "SCHEMA_MISMATCH"; httpStatus?: number; reason: string }
  | { status: "OK" | "EMPTY"; httpStatus: number; items: number; valid: number; invalid: number; invalidByCode: Partial<Record<ValidationCode, number>>; declaredVersion: string | null; expectedVersion: string; hasNextPage: boolean };

/**
 * Fetches ONE page with the configured credentials and checks it against the contract.
 * Returns counts and field/version metadata only: never item content, never the key.
 */
export async function probeContentApi(): Promise<ContentApiProbe> {
  const url = config.contentApi.url();
  if (!url) return { status: "BLOCKED_BY_ENVIRONMENT", missing: ["CONTENT_API_URL"] };
  let endpoint: URL;
  try {
    endpoint = new URL(url);
  } catch {
    return { status: "INVALID_RESPONSE", reason: "CONTENT_API_URL is not a valid URL" };
  }
  const res = await safeFetch(endpoint.toString(), { headers: contentApiHeaders(), timeoutMs: config.contentApi.timeoutMs(), maxRedirects: 3, readBody: true, maxBytes: 20_000_000 });
  if (!res.ok) return { status: "HTTP_ERROR", httpStatus: res.status, reason: res.error ? `${res.error.kind}` : res.status === 401 || res.status === 403 ? "authentication rejected: check CONTENT_API_KEY / CONTENT_API_AUTH_HEADER / CONTENT_API_AUTH_SCHEME" : `HTTP ${res.status}` };
  let payload: unknown;
  try {
    payload = JSON.parse(res.body ?? "");
  } catch {
    return { status: "INVALID_RESPONSE", httpStatus: res.status, reason: `response is not JSON (content-type ${res.headers["content-type"] ?? "unknown"})` };
  }
  const items = extractItems(payload);
  if (!items) return { status: "INVALID_RESPONSE", httpStatus: res.status, reason: "no items/results/data/reviews/articles/content array" };
  const schema = checkPageSchema(payload, items, res.headers);
  if (!schema.ok) return { status: "SCHEMA_MISMATCH", httpStatus: res.status, reason: schema.reason };
  return { status: items.length ? "OK" : "EMPTY", httpStatus: res.status, items: items.length, valid: schema.valid, invalid: schema.invalid, invalidByCode: schema.invalidByCode, declaredVersion: schema.declaredVersion ?? null, expectedVersion: expectedSchemaVersion(), hasNextPage: Boolean(nextPage(payload, endpoint)) };
}
