import { describe, expect, it } from "vitest";
import type { SafeFetchResult } from "@/lib/net/safe-fetch";
import { classifyFetch, nextVerificationDelayMs } from "@/lib/pipeline/verify-link";

const ok = (over: Partial<SafeFetchResult>): SafeFetchResult => ({ ok: true, status: 200, finalUrl: "https://www.bestbuy.com/p", chain: [{ url: "https://sovrn.co/x", status: 302 }, { url: "https://www.bestbuy.com/p", status: 200 }], headers: {}, ...over });

describe("link verification classification", () => {
  it("verifies a redirect chain that lands on the expected merchant", () => {
    expect(classifyFetch(ok({}), "https://bestbuy.com/p/1").status).toBe("VERIFIED_OK");
  });
  it("flags a destination on another domain", () => {
    expect(classifyFetch(ok({ finalUrl: "https://evil.example.net/" }), "https://www.bestbuy.com/p").status).toBe("REDIRECT_MISMATCH");
  });
  it.each([
    [{ ok: false, status: 403 }, "FORBIDDEN"],
    [{ ok: false, status: 404 }, "UNAVAILABLE"],
    [{ ok: false, status: 410 }, "UNAVAILABLE"],
    [{ ok: false, status: 429 }, "PROVIDER_ERROR"],
    [{ ok: false, status: 503 }, "PROVIDER_ERROR"],
    [{ ok: false, status: 0, error: { kind: "TIMEOUT" as const, message: "t" } }, "TIMEOUT"],
    [{ ok: false, status: 0, error: { kind: "BLOCKED_HOST" as const, message: "b" } }, "BLOCKED"],
    [{ ok: false, status: 0, error: { kind: "REDIRECT_LOOP" as const, message: "l" } }, "REDIRECT_MISMATCH"],
    [{ ok: false, status: 0, error: { kind: "INVALID_URL" as const, message: "i" } }, "INVALID"],
    [{ ok: false, status: 0, error: { kind: "DNS_FAILURE" as const, message: "d" } }, "UNAVAILABLE"],
  ])("maps %j → %s", (over, status) => {
    expect(classifyFetch(ok(over), null).status).toBe(status);
  });
  it("backs off retryable failures and re-checks healthy links on the interval", () => {
    expect(nextVerificationDelayMs("TIMEOUT", 1)).toBeLessThan(nextVerificationDelayMs("TIMEOUT", 3));
    expect(nextVerificationDelayMs("TIMEOUT", 20)).toBe(24 * 3_600_000);
    expect(nextVerificationDelayMs("VERIFIED_OK", 0)).toBe(24 * 3_600_000);
  });
});
