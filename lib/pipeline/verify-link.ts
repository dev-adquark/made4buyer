import type { LinkVerificationStatus } from "@prisma/client";
import { config } from "@/lib/config";
import { registrableDomain } from "@/lib/net/ip";
import { safeFetch, type RedirectHop, type SafeFetchResult } from "@/lib/net/safe-fetch";

/**
 * Stage LINK_VERIFICATION. Follows the affiliate redirect chain through the SSRF-safe
 * client and classifies the outcome. Only VERIFIED_OK links are ever shown publicly.
 */

export type VerificationOutcome = {
  status: LinkVerificationStatus;
  reason: string;
  httpStatus?: number;
  chain: RedirectHop[];
  finalUrl?: string;
  retryable: boolean;
};

const RETRYABLE: LinkVerificationStatus[] = ["TIMEOUT", "PROVIDER_ERROR"];

export function classifyFetch(result: SafeFetchResult, expectedDestination?: string | null): Omit<VerificationOutcome, "retryable"> {
  const base = { chain: result.chain, httpStatus: result.status || undefined, finalUrl: result.finalUrl };
  if (result.error) {
    switch (result.error.kind) {
      case "INVALID_URL":
      case "UNSUPPORTED_PROTOCOL":
      case "REDIRECT_WITHOUT_LOCATION":
        return { ...base, status: "INVALID", reason: result.error.message };
      case "BLOCKED_HOST":
      case "BLOCKED_PORT":
        return { ...base, status: "BLOCKED", reason: result.error.message };
      case "TIMEOUT":
        return { ...base, status: "TIMEOUT", reason: result.error.message };
      case "REDIRECT_LOOP":
      case "TOO_MANY_REDIRECTS":
        return { ...base, status: "REDIRECT_MISMATCH", reason: result.error.message };
      case "DNS_FAILURE":
        return { ...base, status: "UNAVAILABLE", reason: `DNS lookup failed: ${result.error.message}` };
      default:
        return { ...base, status: "UNAVAILABLE", reason: result.error.message };
    }
  }
  const status = result.status;
  if (status === 401 || status === 403 || status === 451) return { ...base, status: "FORBIDDEN", reason: `Destination returned HTTP ${status}` };
  if (status === 404 || status === 410) return { ...base, status: "UNAVAILABLE", reason: `Destination returned HTTP ${status}` };
  if (status === 429 || status >= 500) return { ...base, status: "PROVIDER_ERROR", reason: `Destination returned HTTP ${status}` };
  if (status >= 300 && status < 400) return { ...base, status: "INVALID", reason: `Unresolved redirect HTTP ${status}` };
  if (status < 200 || status >= 300) return { ...base, status: "UNAVAILABLE", reason: `Destination returned HTTP ${status}` };

  if (expectedDestination) {
    try {
      const expected = registrableDomain(new URL(expectedDestination).hostname);
      const actual = registrableDomain(new URL(result.finalUrl).hostname);
      if (expected !== actual) {
        return { ...base, status: "REDIRECT_MISMATCH", reason: `Final destination ${actual} does not match expected merchant ${expected}` };
      }
    } catch {
      return { ...base, status: "INVALID", reason: "Could not compare destination hosts" };
    }
  }
  return { ...base, status: "VERIFIED_OK", reason: `HTTP ${status} after ${Math.max(0, result.chain.length - 1)} redirect(s)` };
}

export async function verifyAffiliateLink(affiliateUrl: string, expectedDestination?: string | null): Promise<VerificationOutcome> {
  const common = {
    timeoutMs: config.links.timeoutMs(),
    maxRedirects: config.links.maxRedirects(),
    standardPortsOnly: true,
    headers: {
      "User-Agent": `Made4BuyersLinkVerifier/1.0 (+${config.siteUrl()}/about)`,
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
    },
  };
  let result = await safeFetch(affiliateUrl, { ...common, method: "HEAD" });
  // Many merchants reject HEAD; retry the chain with a minimal ranged GET.
  if (!result.error && [400, 403, 405, 501].includes(result.status)) {
    result = await safeFetch(affiliateUrl, { ...common, method: "GET", headers: { ...common.headers, Range: "bytes=0-0" } });
    if (result.status === 206) result = { ...result, ok: true, status: 200 };
  }
  const outcome = classifyFetch(result, expectedDestination);
  return { ...outcome, retryable: RETRYABLE.includes(outcome.status) };
}

export function nextVerificationDelayMs(status: LinkVerificationStatus, attempts: number): number {
  const hour = 3_600_000;
  if (status === "VERIFIED_OK") return config.links.intervalHours() * hour;
  if (RETRYABLE.includes(status)) return Math.min(24 * hour, hour * 2 ** Math.min(attempts, 5));
  return 24 * hour;
}
