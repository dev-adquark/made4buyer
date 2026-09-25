import { config } from "@/lib/config";
import { PipelineError } from "@/lib/errors";
import { log } from "@/lib/log";
import { isRetryableStatus, safeFetch, withRetry } from "@/lib/net/safe-fetch";

/**
 * Stage CONTENT_FETCH. Configurable Content API adapter:
 *  - CONTENT_API_URL, CONTENT_API_KEY, CONTENT_API_AUTH_HEADER / CONTENT_API_AUTH_SCHEME
 *  - bounded timeout and exponential-backoff retries on timeouts / 408 / 429 / 5xx
 *  - response: an array, or an object with items|results|data|reviews|articles array
 *  - optional pagination via `next` / `nextPage` / `links.next` (absolute URL, same origin),
 *    bounded by CONTENT_API_MAX_PAGES
 */

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

export async function fetchContentBatch(): Promise<FetchedBatch> {
  const url = config.contentApi.url();
  if (!url) throw new PipelineError("CONTENT_API_NOT_CONFIGURED", "CONTENT_API_URL is not configured (BLOCKED_BY_ENVIRONMENT)");
  let endpoint: URL;
  try {
    endpoint = new URL(url);
  } catch {
    throw new PipelineError("CONTENT_API_NOT_CONFIGURED", "CONTENT_API_URL is not a valid URL");
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  const key = config.contentApi.key();
  if (key) {
    const header = config.contentApi.authHeader();
    headers[header] = header.toLowerCase() === "authorization" ? `${config.contentApi.authScheme()} ${key}`.trim() : key;
  }

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
    if (!pageItems) throw new PipelineError("CONTENT_API_RESPONSE_INVALID", "Content API response must be an array or contain an items/results/data array");
    items.push(...pageItems);
    pages++;
    log.info("content page fetched", { stage: "CONTENT_FETCH", page: pages, items: pageItems.length, attempts });
    current = nextPage(payload, current);
  }
  return { source: contentSourceName(), items, pages };
}
