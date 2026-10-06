import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkDestination, classifyLinkFetch, HIDDEN_LINK_STATUSES, nextLinkState, type LinkCheck } from "@/lib/commerce/link-check";
import { normalizeDestinationUrl } from "@/lib/commerce/urls";
import type { SafeFetchResult } from "@/lib/net/safe-fetch";
import { withEnv } from "../support/env";

// A local stand-in merchant site. SAMPLE routes only.
const hits: Array<{ method: string; path: string }> = [];
let server: http.Server;
let base = "";
let port = 0;
let restore: () => void;

const ROUTES: Record<string, (req: http.IncomingMessage) => { status: number; location?: string }> = {
  "/robots.txt": () => ({ status: 200 }),
  "/us/en/products/espresso/bes870.html": () => ({ status: 200 }),
  "/old-product": () => ({ status: 301, location: "/us/en/products/espresso/bes870-v2.html" }),
  "/us/en/products/espresso/bes870-v2.html": () => ({ status: 200 }),
  "/gone-home": () => ({ status: 301, location: "/" }),
  "/gone-locale-home": () => ({ status: 302, location: "/us/en" }),
  "/us/en": () => ({ status: 200 }),
  "/": () => ({ status: 200 }),
  "/gone-search": () => ({ status: 302, location: "/search?q=bes870" }),
  "/search": () => ({ status: 200 }),
  "/us/en/products/espresso/discontinued.html": () => ({ status: 301, location: "/us/en/products/espresso" }),
  "/us/en/products/espresso": () => ({ status: 200 }),
  "/deleted": () => ({ status: 404 }),
  "/removed": () => ({ status: 410 }),
  "/server-error": () => ({ status: 503 }),
  "/bot-wall": () => ({ status: 403 }),
  "/no-head": (req) => ({ status: req.method === "HEAD" ? 405 : 200 }),
  "/private/item": () => ({ status: 200 }),
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    hits.push({ method: req.method ?? "GET", path: url.pathname });
    if (url.pathname === "/to-other-site") {
      // Same machine, different site name: localhost vs 127.0.0.1.
      res.writeHead(302, { Location: `http://localhost:${port}/us/en/products/espresso/bes870.html` });
      return res.end();
    }
    const route = ROUTES[url.pathname];
    if (!route) {
      res.writeHead(404);
      return res.end();
    }
    const r = route(req);
    if (url.pathname === "/robots.txt") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("User-agent: *\nDisallow: /private\n");
    }
    res.writeHead(r.status, r.location ? { Location: r.location } : { "Content-Type": "text/html" });
    res.end(req.method === "HEAD" ? undefined : "<html></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  restore = withEnv({ UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: "true" });
});
afterAll(async () => {
  restore();
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  hits.length = 0;
});

const check = (path: string) => checkDestination(`${base}${path}`);
const fresh = { linkStatus: "UNCHECKED", linkHttpStatus: null, linkCheckedAt: null, linkFinalUrl: null };
const okPrev = { linkStatus: "OK", linkHttpStatus: 200, linkCheckedAt: new Date("2026-10-06T00:00:00Z"), linkFinalUrl: "https://x.test/p" };

describe("offer link checks against a live (local) site", () => {
  it("is OK for a 2xx on the same URL", async () => {
    const c = await check("/us/en/products/espresso/bes870.html");
    expect(c).toMatchObject({ kind: "RESULT", status: "OK", httpStatus: 200 });
    expect(nextLinkState(fresh, c).linkStatus).toBe("OK");
  });

  it("is REDIRECTED_SAME_SITE for a redirect to another product page on the same site", async () => {
    const c = await check("/old-product");
    expect(c).toMatchObject({ kind: "RESULT", status: "REDIRECTED_SAME_SITE", httpStatus: 200 });
    expect(c.finalUrl).toBe(`${base}/us/en/products/espresso/bes870-v2.html`);
  });

  it.each([
    ["/gone-home", "home page"],
    ["/gone-locale-home", "home page"],
    ["/gone-search", "search page"],
    ["/us/en/products/espresso/discontinued.html", "category page"],
  ])("is BROKEN when %s redirects to the %s", async (path, what) => {
    const c = await check(path);
    expect(c).toMatchObject({ kind: "RESULT", status: "BROKEN" });
    expect(c.reason).toContain(what);
  });

  it.each(["/deleted", "/removed"])("is BROKEN for 404/410 (%s)", async (path) => {
    expect(await check(path)).toMatchObject({ kind: "RESULT", status: "BROKEN" });
  });

  it("is OFF_SITE for a redirect to a different site", async () => {
    const c = await check("/to-other-site");
    expect(c).toMatchObject({ kind: "RESULT", status: "OFF_SITE" });
    expect(HIDDEN_LINK_STATUSES).toContain("OFF_SITE");
  });

  it("falls back to GET when HEAD is refused", async () => {
    expect(await check("/no-head")).toMatchObject({ kind: "RESULT", status: "OK", httpStatus: 200 });
    expect(hits.filter((h) => h.path === "/no-head").map((h) => h.method)).toEqual(["HEAD", "GET"]);
  });

  it("never fetches a URL robots.txt disallows; it is BLOCKED (displayable), and a known BROKEN finding is kept", async () => {
    const c = await check("/private/item");
    expect(c).toMatchObject({ kind: "ROBOTS" });
    expect(c.reason).toMatch(/robots\.txt disallows/);
    expect(hits.some((h) => h.path === "/private/item")).toBe(false);
    expect(nextLinkState(fresh, c).linkStatus).toBe("BLOCKED");
    expect(nextLinkState(okPrev, c).linkStatus).toBe("BLOCKED");
    expect(HIDDEN_LINK_STATUSES).not.toContain("BLOCKED");
    expect(nextLinkState({ ...okPrev, linkStatus: "BROKEN", linkHttpStatus: 404 }, c).linkStatus).toBe("BROKEN");
  });

  it("keeps the previous status on a first 5xx/network failure and is UNREACHABLE on the second", async () => {
    const first = await check("/server-error");
    expect(first).toMatchObject({ kind: "FAILURE", httpStatus: 503 });
    const s1 = nextLinkState(okPrev, first);
    expect(s1).toMatchObject({ linkStatus: "OK", linkHttpStatus: 503 });
    const s2 = nextLinkState({ ...okPrev, linkHttpStatus: s1.linkHttpStatus, linkCheckedAt: new Date() }, await check("/server-error"));
    expect(s2.linkStatus).toBe("UNREACHABLE");
    // A success afterwards clears it.
    expect(nextLinkState({ ...okPrev, linkStatus: "UNREACHABLE", linkHttpStatus: 503 }, await check("/us/en/products/espresso/bes870.html")).linkStatus).toBe("OK");
  });

  it("treats a refused connection as a failure (first keeps status, second UNREACHABLE)", async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    const c = await checkDestination(`http://127.0.0.1:${deadPort}/p`);
    expect(c.kind).toBe("FAILURE");
    expect(c.httpStatus).toBe(0);
    const s1 = nextLinkState(fresh, c);
    expect(s1).toMatchObject({ linkStatus: "UNCHECKED", linkHttpStatus: 0 });
    expect(nextLinkState({ ...fresh, linkHttpStatus: 0, linkCheckedAt: new Date() }, c).linkStatus).toBe("UNREACHABLE");
  });

  it("does not call a site that refuses automated checks BROKEN", async () => {
    const c = await check("/bot-wall");
    expect(c).toMatchObject({ kind: "INCONCLUSIVE", httpStatus: 403 });
    expect(nextLinkState(fresh, c).linkStatus).toBe("BLOCKED");
    expect(nextLinkState(okPrev, c).linkStatus).toBe("OK");
  });
});

describe("classification (pure)", () => {
  const res = (over: Partial<SafeFetchResult>): SafeFetchResult => ({ ok: true, status: 200, finalUrl: "https://www.breville.com/us/en/products/espresso/bes870.html", chain: [], headers: {}, ...over });
  const dest = "https://www.breville.com/us/en/products/espresso/bes870.html";
  it("treats http→https and www changes as the same page", () => {
    expect(classifyLinkFetch("http://breville.com/us/en/products/espresso/bes870.html", res({}))).toMatchObject({ status: "OK" });
  });
  it("same registrable domain on another subdomain is same-site", () => {
    expect(classifyLinkFetch(dest, res({ finalUrl: "https://shop.breville.com/products/bes870xl" }))).toMatchObject({ status: "REDIRECTED_SAME_SITE" });
  });
  it("another registrable domain is OFF_SITE", () => {
    expect(classifyLinkFetch(dest, res({ finalUrl: "https://www.example-marketplace.com/bes870" }))).toMatchObject({ status: "OFF_SITE" });
  });
  it("a redirect into a non-public address is OFF_SITE, a non-public destination is BROKEN", () => {
    const c: LinkCheck = classifyLinkFetch(dest, res({ ok: false, status: 0, chain: [{ url: dest, status: 302 }], error: { kind: "BLOCKED_HOST", message: "x" } }));
    expect(c).toMatchObject({ kind: "RESULT", status: "OFF_SITE" });
    expect(classifyLinkFetch(dest, res({ ok: false, status: 0, error: { kind: "BLOCKED_HOST", message: "x" } }))).toMatchObject({ kind: "RESULT", status: "BROKEN" });
  });
  it("redirect loops are inconclusive, timeouts are failures", () => {
    expect(classifyLinkFetch(dest, res({ ok: false, status: 0, error: { kind: "REDIRECT_LOOP", message: "x" } })).kind).toBe("INCONCLUSIVE");
    expect(classifyLinkFetch(dest, res({ ok: false, status: 0, error: { kind: "TIMEOUT", message: "x" } }))).toMatchObject({ kind: "FAILURE", httpStatus: 0 });
  });
});

describe("destination URL normalization", () => {
  it("strips tracking parameters and fragments so variants share one offer", () => {
    const canon = "https://www.breville.com/us/en/products/espresso/bes870.html";
    for (const v of [`${canon}?utm_source=x&utm_medium=y`, `${canon}#reviews`, `${canon}?gclid=abc`, `${canon}?fbclid=abc&msclkid=1`, `https://WWW.Breville.com/us/en/products/espresso/bes870.html/`]) {
      expect(normalizeDestinationUrl(v)).toBe(canon);
    }
    expect(normalizeDestinationUrl(`${canon}?color=red&utm_source=x`)).toBe(`${canon}?color=red`);
    expect(normalizeDestinationUrl("javascript:alert(1)")).toBeNull();
  });
});
