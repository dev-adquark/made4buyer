import dns from "node:dns";
import { Agent, fetch as undiciFetch, type Response } from "undici";
import { config } from "@/lib/config";
import { isBlockedAddress, isBlockedHostname } from "./ip";

/**
 * SSRF-safe HTTP client used for every outbound request to a URL that did not come from
 * trusted configuration alone (affiliate links, image URLs, provider responses) and for
 * configured APIs too. Guarantees:
 *  - only http/https
 *  - hostnames and every resolved address are checked; the check runs inside the socket
 *    `lookup`, so DNS rebinding between check and connect is not possible
 *  - redirects are followed manually, each hop re-validated, loops detected, bounded
 *  - credentials are dropped when a redirect leaves the original host
 *  - total wall-clock timeout and response size cap
 */

export type SafeFetchErrorKind =
  | "INVALID_URL"
  | "UNSUPPORTED_PROTOCOL"
  | "BLOCKED_HOST"
  | "BLOCKED_PORT"
  | "TIMEOUT"
  | "DNS_FAILURE"
  | "NETWORK"
  | "REDIRECT_LOOP"
  | "TOO_MANY_REDIRECTS"
  | "REDIRECT_WITHOUT_LOCATION"
  | "RESPONSE_TOO_LARGE";

export type RedirectHop = { url: string; status: number };

export type SafeFetchOptions = {
  method?: "GET" | "HEAD" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** 0 disables redirect following (3xx is returned as-is). */
  maxRedirects?: number;
  /** Restrict to ports 80/443 (and 8080/8443). Untrusted URLs should keep this on. */
  standardPortsOnly?: boolean;
  readBody?: boolean;
  maxBytes?: number;
};

export type SafeFetchResult = {
  ok: boolean;
  status: number;
  finalUrl: string;
  chain: RedirectHop[];
  headers: Record<string, string>;
  body?: string;
  error?: { kind: SafeFetchErrorKind; message: string };
};

const STANDARD_PORTS = new Set(["", "80", "443", "8080", "8443"]);

class BlockedAddressError extends Error {
  code = "ESSRFBLOCKED";
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

function makeAgent(allowLoopback: boolean) {
  return new Agent({
    connect: {
      lookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback) {
        dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
          if (err) return callback(err, "");
          const list = addresses as dns.LookupAddress[];
          const blocked = list.find((a) => isBlockedAddress(a.address, { allowLoopback }));
          if (!list.length || blocked) {
            return callback(new BlockedAddressError(`Refusing to connect to non-public address ${blocked?.address ?? "(none)"}`) as NodeJS.ErrnoException, "");
          }
          if (options && (options as { all?: boolean }).all) return callback(null, list);
          return callback(null, list[0].address, list[0].family);
        });
      },
    },
    keepAliveTimeout: 1000,
  });
}

const agents: { strict?: Agent; loopback?: Agent } = {};
function agentFor(allowLoopback: boolean): Agent {
  if (allowLoopback) return (agents.loopback ??= makeAgent(true));
  return (agents.strict ??= makeAgent(false));
}

export function validateOutboundUrl(raw: string, opts: { standardPortsOnly?: boolean } = {}): { url?: URL; error?: SafeFetchResult["error"] } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: { kind: "INVALID_URL", message: "URL could not be parsed" } };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: { kind: "UNSUPPORTED_PROTOCOL", message: `Protocol ${url.protocol} is not allowed` } };
  }
  if (url.username || url.password) return { error: { kind: "INVALID_URL", message: "Credentials in URL are not allowed" } };
  const allowLoopback = config.allowLoopbackForTests();
  if (isBlockedHostname(url.hostname, { allowLoopback })) {
    return { error: { kind: "BLOCKED_HOST", message: `Host ${url.hostname} is private, internal or not allowed` } };
  }
  if (opts.standardPortsOnly && !allowLoopback && !STANDARD_PORTS.has(url.port)) {
    return { error: { kind: "BLOCKED_PORT", message: `Port ${url.port} is not allowed` } };
  }
  return { url };
}

function headerRecord(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function classifyNetworkError(error: unknown, aborted: boolean): SafeFetchResult["error"] {
  if (aborted) return { kind: "TIMEOUT", message: "Request timed out" };
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? (error as { code?: string })?.code;
  const message = cause?.message ?? (error instanceof Error ? error.message : String(error));
  if (code === "ESSRFBLOCKED") return { kind: "BLOCKED_HOST", message };
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENODATA") return { kind: "DNS_FAILURE", message };
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "ETIMEDOUT") return { kind: "TIMEOUT", message };
  return { kind: "NETWORK", message };
}

async function readLimited(res: Response, maxBytes: number): Promise<{ body?: string; tooLarge?: boolean }> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return { tooLarge: true };
  }
  if (!res.body) return { body: "" };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  return { body: Buffer.concat(chunks).toString("utf8") };
}

export async function safeFetch(raw: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const method = options.method ?? "GET";
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 10000;
  const maxBytes = options.maxBytes ?? 5_000_000;
  const allowLoopback = config.allowLoopbackForTests();
  const chain: RedirectHop[] = [];
  const visited = new Set<string>();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let headers = { ...(options.headers ?? {}) };
  let current = raw;
  let originHost: string | undefined;

  const fail = (error: SafeFetchResult["error"], status = 0): SafeFetchResult => ({ ok: false, status, finalUrl: current, chain, headers: {}, error });

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const checked = validateOutboundUrl(current, { standardPortsOnly: options.standardPortsOnly });
      if (!checked.url) return fail(checked.error);
      const url = checked.url;
      url.hash = "";
      const key = url.toString();
      if (visited.has(key)) return fail({ kind: "REDIRECT_LOOP", message: `Redirect loop detected at ${url.host}` });
      visited.add(key);
      originHost ??= url.host;
      if (url.host !== originHost) {
        // Never forward credentials to a different host.
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(authorization|cookie|x-api-key)$/i.test(k)));
      }

      let res: Response;
      try {
        res = await undiciFetch(key, {
          method: hop > 0 && method === "POST" ? "GET" : method,
          headers,
          body: hop === 0 && method === "POST" ? options.body : undefined,
          redirect: "manual",
          signal: controller.signal,
          dispatcher: agentFor(allowLoopback),
        });
      } catch (error) {
        return fail(classifyNetworkError(error, controller.signal.aborted));
      }

      chain.push({ url: key, status: res.status });
      if (res.status >= 300 && res.status < 400 && maxRedirects > 0) {
        await res.body?.cancel().catch(() => undefined);
        const location = res.headers.get("location");
        if (!location) return fail({ kind: "REDIRECT_WITHOUT_LOCATION", message: "Redirect response had no Location header" }, res.status);
        try {
          current = new URL(location, key).toString();
        } catch {
          return fail({ kind: "INVALID_URL", message: "Redirect Location is not a valid URL" }, res.status);
        }
        continue;
      }

      const result: SafeFetchResult = { ok: res.ok, status: res.status, finalUrl: key, chain, headers: headerRecord(res) };
      if (options.readBody && method !== "HEAD") {
        try {
          const read = await readLimited(res, maxBytes);
          if (read.tooLarge) return { ...result, ok: false, error: { kind: "RESPONSE_TOO_LARGE", message: `Response exceeds ${maxBytes} bytes` } };
          result.body = read.body;
        } catch (error) {
          return { ...result, ok: false, error: classifyNetworkError(error, controller.signal.aborted) };
        }
      } else {
        await res.body?.cancel().catch(() => undefined);
      }
      return result;
    }
    return fail({ kind: "TOO_MANY_REDIRECTS", message: `More than ${maxRedirects} redirects` });
  } finally {
    clearTimeout(timer);
  }
}

/** Bounded exponential backoff with jitter, used for retryable upstream failures. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { retries: number; baseMs?: number; maxMs?: number; shouldRetry: (result: T) => boolean },
): Promise<{ result: T; attempts: number }> {
  const base = opts.baseMs ?? 300;
  const max = opts.maxMs ?? 4000;
  let attempt = 0;
  for (;;) {
    const result = await fn(attempt);
    if (attempt >= opts.retries || !opts.shouldRetry(result)) return { result, attempts: attempt + 1 };
    const delay = Math.min(max, base * 2 ** attempt) * (0.5 + Math.random() / 2);
    await new Promise((r) => setTimeout(r, delay));
    attempt++;
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
}
