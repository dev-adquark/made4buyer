import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkLink, linkCheckQueryKey, parseLinkCheck, parseLinkCheckQueryKey, type LinkCheckCacheRow, type LinkCheckStore } from "@/lib/sovrn/link-check";
import { withEnv } from "../support/env";

const SITE_KEY = "site-key-0123456789abcdef";

type Reply = { status: number; body: string };
let reply: (u: URL) => Reply = () => ({ status: 200, body: "{}" });
const requests: URL[] = [];
let server: http.Server;
let base = "";
let restore: () => void;

function memoryStore() {
  const rows = new Map<string, LinkCheckCacheRow>();
  const store: LinkCheckStore = {
    get: async (h) => rows.get(h) ?? null,
    put: async (h, row) => void rows.set(h, row),
  };
  return { rows, store };
}

const ok = (over: Record<string, unknown> = {}) => (u: URL): Reply => ({
  status: 200,
  body: JSON.stringify({
    url: u.searchParams.get("out"),
    optimized: `https://redirect.viglink.com?u=${encodeURIComponent(u.searchParams.get("out") ?? "")}&key=${u.searchParams.get("key")}&prodOvrd=RAL`,
    affiliatable: false,
    competitive: null,
    optimizable: null,
    eepc: 0.0702,
    ...over,
  }),
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push(u);
    const r = reply(u);
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(r.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/link/`;
  restore = withEnv({ SOVRN_LINK_CHECK_URL: base, SOVRN_SITE_KEY: SITE_KEY, SOVRN_API_KEY: "secret-xyz", UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: "true", SOVRN_TIMEOUT_MS: "2000" });
});
afterAll(async () => {
  restore();
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  requests.length = 0;
});

describe("parseLinkCheck", () => {
  it("reads the documented fields strictly", () => {
    expect(parseLinkCheck({ url: "https://www.walmart.com/ip/1", optimized: "https://redirect.viglink.com?u=x&key=k", affiliatable: true, competitive: true, optimizable: null, eepc: 0.12 })).toEqual({
      affiliatable: true,
      competitive: true,
      eepc: 0.12,
      optimizedUrl: "https://redirect.viglink.com/?u=x&key=k",
    });
    expect(parseLinkCheck({ affiliatable: "true" })).toBeUndefined();
    expect(parseLinkCheck({ url: "x" })).toBeUndefined();
    expect(parseLinkCheck([])).toBeUndefined();
    expect(parseLinkCheck(null)).toBeUndefined();
    expect(parseLinkCheck({ affiliatable: false, eepc: "0.3", competitive: "yes" })).toEqual({ affiliatable: false, competitive: null, eepc: null, optimizedUrl: null });
  });

  it("drops an optimized URL that is not on a Sovrn/VigLink host", () => {
    expect(parseLinkCheck({ affiliatable: true, optimized: "https://evil.example.com/?u=x" })?.optimizedUrl).toBeNull();
    expect(parseLinkCheck({ affiliatable: true, optimized: "javascript:alert(1)" })?.optimizedUrl).toBeNull();
    expect(parseLinkCheck({ affiliatable: true, optimized: "http://redirect.viglink.com/?u=x" })?.optimizedUrl).toBeNull();
  });

  it("round-trips the recorded query key", () => {
    expect(parseLinkCheckQueryKey(linkCheckQueryKey("https://a.example.com/p", "US"))).toEqual({ url: "https://a.example.com/p", geo: "US" });
    expect(parseLinkCheckQueryKey(linkCheckQueryKey("https://a.example.com/p"))).toEqual({ url: "https://a.example.com/p" });
  });
});

describe("checkLink", () => {
  it("sends out/key/format/geo and reports affiliatable:false (pending site)", async () => {
    reply = ok();
    const { store, rows } = memoryStore();
    const res = await checkLink("https://www.walmart.com/ip/105218827#frag", { geo: "us", store });
    expect(res).toEqual({ status: "OK", affiliatable: false, competitive: null, eepc: 0.0702, optimizedUrl: expect.stringMatching(/^https:\/\/redirect\.viglink\.com\//), fromCache: false });
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.get("out")).toBe("https://www.walmart.com/ip/105218827");
    expect(requests[0].searchParams.get("key")).toBe(SITE_KEY);
    expect(requests[0].searchParams.get("format")).toBe("json");
    expect(requests[0].searchParams.get("geo")).toBe("US");
    const [row] = [...rows.values()];
    expect(row.queryKey).toBe("linkcheck:https://www.walmart.com/ip/105218827|geo=US");
    expect(row.providerStatus).toBe("OK");
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
  });

  it("reports affiliatable:true and reuses a cached success; bypassCache asks again", async () => {
    reply = ok({ affiliatable: true, competitive: true, eepc: 0.31 });
    const { store } = memoryStore();
    const first = await checkLink("https://www.bestbuy.com/site/1.p", { store });
    expect(first).toMatchObject({ status: "OK", affiliatable: true, competitive: true, eepc: 0.31, fromCache: false });
    const second = await checkLink("https://www.bestbuy.com/site/1.p", { store });
    expect(second).toMatchObject({ status: "OK", affiliatable: true, fromCache: true });
    expect(requests).toHaveLength(1);
    const third = await checkLink("https://www.bestbuy.com/site/1.p", { store, bypassCache: true });
    expect(third).toMatchObject({ status: "OK", fromCache: false });
    expect(requests).toHaveLength(2);
  });

  it("drops a non-Sovrn optimized URL from the provider response", async () => {
    reply = ok({ affiliatable: true, optimized: "https://tracker.example.net/r?u=x" });
    const res = await checkLink("https://www.target.com/p/1", { store: memoryStore().store });
    expect(res).toMatchObject({ status: "OK", affiliatable: true, optimizedUrl: null });
  });

  it("rejects invalid URLs without calling Sovrn", async () => {
    const { store } = memoryStore();
    for (const bad of ["not a url", "javascript:alert(1)", "ftp://files.example.com/x", "http://localhost/admin", "http://10.0.0.1/x"]) {
      const r = withEnv({ UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: bad.includes("localhost") ? "false" : "true" });
      const res = await checkLink(bad, { store });
      r();
      expect(res.status).toBe("INVALID_URL");
    }
    expect((await checkLink("https://www.walmart.com/ip/1", { geo: "USA", store })).status).toBe("INVALID_URL");
    expect(requests).toHaveLength(0);
  });

  it("maps a provider error and never puts the site key in the message", async () => {
    reply = (u) => ({ status: 400, body: JSON.stringify({ status: 400, message: `Invalid key ${u.searchParams.get("key")}`, error: "Bad Request" }) });
    const { store, rows } = memoryStore();
    const res = await checkLink("https://www.walmart.com/ip/2", { store });
    expect(res).toMatchObject({ status: "PROVIDER_ERROR", httpStatus: 400 });
    const message = (res as { message: string }).message;
    expect(message).toMatch(/HTTP 400/);
    expect(message).not.toContain(SITE_KEY);
    expect(message).not.toContain("secret-xyz");
    const [row] = [...rows.values()];
    expect(row.errorMessage).not.toContain(SITE_KEY);
    expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    // Errors are reused briefly so an outage is not hammered.
    const again = await checkLink("https://www.walmart.com/ip/2", { store });
    expect(again).toMatchObject({ status: "PROVIDER_ERROR" });
    expect(requests).toHaveLength(1);
  });

  it("keeps the key out of network-error messages", async () => {
    const res = await checkLink("https://www.walmart.com/ip/3", {
      store: memoryStore().store,
      fetchImpl: async (u) => ({ ok: false, status: 0, finalUrl: u, chain: [], headers: {}, error: { kind: "NETWORK", message: `connect failed for ${u}` } }),
    });
    expect(res.status).toBe("PROVIDER_ERROR");
    expect((res as { message: string }).message).not.toContain(SITE_KEY);
  });

  it("flags a 200 without a boolean affiliatable as INVALID_RESPONSE", async () => {
    reply = () => ({ status: 200, body: JSON.stringify({ url: "x", affiliatable: "maybe" }) });
    expect((await checkLink("https://www.walmart.com/ip/4", { store: memoryStore().store })).status).toBe("INVALID_RESPONSE");
    reply = () => ({ status: 200, body: "<html>" });
    expect((await checkLink("https://www.walmart.com/ip/5", { store: memoryStore().store })).status).toBe("INVALID_RESPONSE");
  });

  it("is UNAVAILABLE without a usable site key", async () => {
    const r = withEnv({ SOVRN_SITE_KEY: "secret-xyz" });
    const res = await checkLink("https://www.walmart.com/ip/6", { store: memoryStore().store });
    r();
    expect(res.status).toBe("UNAVAILABLE");
    expect(requests).toHaveLength(0);
  });
});
