import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { discoverProductUrls, looksLikeProductUrl, parseSitemap, sitemapLinesFromRobots, type DiscoveryBrand } from "@/lib/commerce/discovery";
import { withEnv } from "../support/env";

// A local stand-in for a brand's site. All URLs and content here are SAMPLE data.
type Route = { status?: number; body: string; type?: string };
let routes: Record<string, Route> = {};
let hits: string[] = [];
let server: http.Server;
let host = "";
let origin = "";
let restore: () => void;

beforeAll(async () => {
  restore = withEnv({ UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: "true" });
  server = http.createServer((req, res) => {
    const path = req.url ?? "/";
    hits.push(path);
    const r = routes[path];
    if (!r) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("not found");
    }
    res.writeHead(r.status ?? 200, { "Content-Type": r.type ?? (path.endsWith(".txt") ? "text/plain" : "application/xml") });
    res.end(r.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  origin = `http://${host}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  restore();
});

beforeEach(() => {
  routes = {};
  hits = [];
});

const brand = (over: Partial<DiscoveryBrand> = {}): DiscoveryBrand => ({ officialDomain: host, discoveryUrls: [], productUrlPatterns: [], maxProductsPerRun: 20, lastCrawlAt: null, ...over });
const urlset = (entries: Array<[string, string?]>) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.map(([loc, lastmod]) => `<url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`).join("")}</urlset>`;
const index = (entries: Array<[string, string?]>) =>
  `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.map(([loc, lastmod]) => `<sitemap><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</sitemap>`).join("")}</sitemapindex>`;
const run = (b: DiscoveryBrand, opts = {}) => discoverProductUrls(b, { persist: false, ...opts });

describe("parseSitemap", () => {
  it("reads a urlset with lastmod, entities and CDATA", () => {
    const p = parseSitemap(urlset([["https://x.example/products/a?x=1&amp;y=2", "2026-09-01"], ["<![CDATA[https://x.example/products/b]]>"]]));
    expect(p.kind).toBe("urlset");
    if (p.kind !== "urlset") return;
    expect(p.urls[0]).toEqual({ loc: "https://x.example/products/a?x=1&y=2", lastmod: new Date("2026-09-01") });
    expect(p.urls[1]).toEqual({ loc: "https://x.example/products/b", lastmod: null });
  });

  it("reads a sitemap index (also with a namespace prefix)", () => {
    const p = parseSitemap(index([["https://x.example/s1.xml", "2026-09-02T10:00:00Z"], ["https://x.example/s2.xml"]]));
    expect(p.kind).toBe("index");
    if (p.kind === "index") expect(p.sitemaps.map((s) => s.loc)).toEqual(["https://x.example/s1.xml", "https://x.example/s2.xml"]);
    const ns = parseSitemap(`<sm:sitemapindex xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9"><sm:sitemap><sm:loc>https://x.example/a.xml</sm:loc></sm:sitemap></sm:sitemapindex>`);
    expect(ns.kind === "index" && ns.sitemaps[0].loc).toBe("https://x.example/a.xml");
  });

  it("reads plain-text sitemaps and HTML listing pages", () => {
    const t = parseSitemap("https://x.example/p/one\nnot a url\nhttps://x.example/p/two\n");
    expect(t.kind === "text" && t.urls.map((u) => u.loc)).toEqual(["https://x.example/p/one", "https://x.example/p/two"]);
    const h = parseSitemap(`<!doctype html><html><body><a href="/products/abc-123">A</a><a href='https://x.example/p/z'>Z</a><a href="#top">t</a></body></html>`, "https://x.example/laptops");
    expect(h.kind === "html" && h.urls.map((u) => u.loc)).toEqual(["https://x.example/products/abc-123", "https://x.example/p/z"]);
  });

  it("reads Sitemap lines from robots.txt", () => {
    expect(sitemapLinesFromRobots("User-agent: *\nDisallow: /cart\nSitemap: https://x.example/a.xml\nsitemap:https://x.example/b.xml # comment\nSitemap: https://x.example/a.xml\n")).toEqual(["https://x.example/a.xml", "https://x.example/b.xml"]);
  });
});

describe("looksLikeProductUrl (heuristic when a brand has no patterns)", () => {
  it.each([
    "https://x.example/products/aurora-headphones",
    "https://x.example/us/product/thing",
    "https://x.example/p/12345",
    "https://x.example/dp/B000TEST",
    "https://x.example/shop/laptops/ultra-14",
    "https://x.example/us/en/wh-1000xm5",
    "https://x.example/galaxy-s24-ultra.html",
  ])("accepts %s", (u) => expect(looksLikeProductUrl(u)).toBe(true));

  it.each([
    "https://x.example/",
    "https://x.example/about",
    "https://x.example/blog/products/best-of-2026",
    "https://x.example/support/product/xps-13",
    "https://x.example/2026-gift-guide",
    "https://x.example/shop/laptops",
    "https://x.example/headphones",
    "https://x.example/cart/p/123",
  ])("rejects %s", (u) => expect(looksLikeProductUrl(u)).toBe(false));
});

describe("discoverProductUrls", () => {
  it("follows robots Sitemap → index → children, keeps on-domain allowed product URLs, dedupes and prefers changed ones", async () => {
    routes["/robots.txt"] = { body: `User-agent: *\nDisallow: /products/private/\nSitemap: ${origin}/sitemap_index.xml\n` };
    routes["/sitemap_index.xml"] = { body: index([[`${origin}/sitemap-products.xml`], [`${origin}/sitemap-archive.xml.gz`], [`https://elsewhere.example/sitemap.xml`]]) };
    routes["/sitemap-products.xml"] = {
      body: urlset([
        [`${origin}/products/old-model-a1`, "2026-01-01"],
        [`${origin}/products/new-model-b2`, "2026-09-20"],
        [`${origin}/products/new-model-b2/?utm_source=feed`, "2026-09-21"],
        [`${origin}/products/undated-c3`],
        [`${origin}/products/private/secret-d4`, "2026-09-25"],
        [`https://elsewhere.example/products/foreign-e5`, "2026-09-25"],
        [`${origin}/about`, "2026-09-25"],
        [`${origin}/products/newest-f6`, "2026-09-30"],
      ]),
    };
    const r = await run(brand({ lastCrawlAt: new Date("2026-06-01") }));
    expect(r.status).toBe("OK");
    expect(r.robotsStatus).toBe("ALLOWED");
    expect(r.urls).toEqual([`${origin}/products/newest-f6`, `${origin}/products/new-model-b2`, `${origin}/products/undated-c3`, `${origin}/products/old-model-a1`]);
    expect(r.counts).toMatchObject({ offDomain: 1, robotsDisallowed: 1, duplicates: 1, notProduct: 1, candidates: 4, changed: 2 });
    expect(r.sitemaps?.find((s) => s.url.endsWith(".gz"))).toMatchObject({ status: "SKIPPED", reason: "gzip sitemaps are not read" });
    expect(r.sitemaps?.find((s) => s.url.startsWith("https://elsewhere.example"))).toMatchObject({ status: "SKIPPED" });
    expect(hits).not.toContain("/sitemap-archive.xml.gz");
  });

  it("uses the brand's discovery URLs instead of robots Sitemap lines and applies productUrlPatterns", async () => {
    routes["/robots.txt"] = { body: `User-agent: *\nAllow: /\nSitemap: ${origin}/ignored.xml\n` };
    routes["/feeds/catalog.xml"] = { body: urlset([[`${origin}/catalog/item-1`], [`${origin}/catalog/sub/item-2`], [`${origin}/products/heuristic-x1`]]) };
    const r = await run(brand({ discoveryUrls: [`${origin}/feeds/catalog.xml`], productUrlPatterns: [`${origin}/catalog/*`] }));
    expect(r.status).toBe("OK");
    expect(r.urls).toEqual([`${origin}/catalog/item-1`]);
    expect(hits).not.toContain("/ignored.xml");
  });

  it("caps the result at maxProductsPerRun", async () => {
    routes["/robots.txt"] = { body: `Sitemap: ${origin}/s.xml\n` };
    routes["/s.xml"] = { body: urlset(Array.from({ length: 30 }, (_, i): [string, string] => [`${origin}/products/item-${i}`, `2026-09-${String(i % 28 + 1).padStart(2, "0")}`])) };
    const r = await run(brand({ maxProductsPerRun: 5 }));
    expect(r.status).toBe("OK");
    expect(r.urls).toHaveLength(5);
    expect(r.counts?.candidates).toBe(30);
  });

  it("fetches at most 10 sitemap files", async () => {
    routes["/robots.txt"] = { body: `Sitemap: ${origin}/index.xml\n` };
    routes["/index.xml"] = { body: index(Array.from({ length: 15 }, (_, i): [string] => [`${origin}/child-${i}.xml`])) };
    for (let i = 0; i < 15; i++) routes[`/child-${i}.xml`] = { body: urlset([[`${origin}/products/p-${i}`]]) };
    const r = await run(brand());
    expect(r.status).toBe("OK");
    expect(hits.filter((h) => h.endsWith(".xml"))).toHaveLength(10); // the index + 9 children
    expect(r.urls).toHaveLength(9);
    expect(r.sitemaps?.filter((s) => /cap reached/.test(s.reason ?? ""))).toHaveLength(6);
  });

  it("refuses a sitemap larger than the byte cap", async () => {
    routes["/robots.txt"] = { body: `Sitemap: ${origin}/big.xml\n` };
    routes["/big.xml"] = { body: urlset(Array.from({ length: 200 }, (_, i): [string] => [`${origin}/products/item-${i}`])) };
    const r = await run(brand(), { maxBytes: 1000 });
    expect(r.status).toBe("FETCH_FAILED");
    expect(r.sitemaps?.[0]).toMatchObject({ status: "FAILED" });
    expect(r.sitemaps?.[0].reason).toMatch(/RESPONSE_TOO_LARGE/);
  });

  it("reports ROBOTS_DISALLOWED when robots.txt disallows the site", async () => {
    routes["/robots.txt"] = { body: `User-agent: *\nDisallow: /\nSitemap: ${origin}/s.xml\n` };
    routes["/s.xml"] = { body: urlset([[`${origin}/products/a1`]]) };
    const r = await run(brand());
    expect(r.status).toBe("ROBOTS_DISALLOWED");
    expect(r.robotsStatus).toBe("DISALLOWED");
    expect(r.urls).toEqual([]);
    expect(hits).not.toContain("/s.xml");
  });

  it("reports ROBOTS_DISALLOWED when every product URL is disallowed", async () => {
    routes["/robots.txt"] = { body: `User-agent: *\nDisallow: /products/\nSitemap: ${origin}/s.xml\n` };
    routes["/s.xml"] = { body: urlset([[`${origin}/products/a1`], [`${origin}/products/b2`]]) };
    const r = await run(brand());
    expect(r.status).toBe("ROBOTS_DISALLOWED");
    expect(r.counts?.robotsDisallowed).toBe(2);
  });

  it("reports NO_SITEMAP when there is no discovery URL and robots.txt lists none (paths are not guessed)", async () => {
    routes["/robots.txt"] = { body: "User-agent: *\nAllow: /\n" };
    routes["/sitemap.xml"] = { body: urlset([[`${origin}/products/a1`]]) };
    const r = await run(brand());
    expect(r.status).toBe("NO_SITEMAP");
    expect(hits).toEqual(["/robots.txt"]);
  });

  it("treats a missing robots.txt (404) as no rules", async () => {
    routes["/s.xml"] = { body: urlset([[`${origin}/products/a1`]]) };
    const r = await run(brand({ discoveryUrls: [`${origin}/s.xml`] }));
    expect(r.robotsStatus).toBe("NO_ROBOTS");
    expect(r.status).toBe("OK");
  });

  it("does not crawl when robots.txt cannot be read (5xx)", async () => {
    routes["/robots.txt"] = { status: 503, body: "down" };
    const r = await run(brand({ discoveryUrls: [`${origin}/s.xml`] }));
    expect(r.status).toBe("FETCH_FAILED");
    expect(r.robotsStatus).toBe("UNREACHABLE");
    expect(hits).toEqual(["/robots.txt"]);
  });

  it("rejects off-domain discovery URLs", async () => {
    routes["/robots.txt"] = { body: "User-agent: *\nAllow: /\n" };
    const r = await run(brand({ discoveryUrls: ["https://elsewhere.example/sitemap.xml"] }));
    expect(r.status).toBe("NO_SITEMAP");
    expect(r.sitemaps?.[0]).toMatchObject({ status: "SKIPPED" });
  });

  it("reports NO_PRODUCTS when the sitemap has no product pages", async () => {
    routes["/robots.txt"] = { body: `Sitemap: ${origin}/s.xml\n` };
    routes["/s.xml"] = { body: urlset([[`${origin}/about`], [`${origin}/blog/products/review-x1`], [`${origin}/headphones`]]) };
    const r = await run(brand());
    expect(r.status).toBe("NO_PRODUCTS");
  });

  it("reports FETCH_FAILED when the sitemap cannot be fetched, and never throws", async () => {
    routes["/robots.txt"] = { body: `Sitemap: ${origin}/missing.xml\n` };
    const r = await run(brand());
    expect(r.status).toBe("FETCH_FAILED");
    const bad = await run(brand({ officialDomain: "10.0.0.1" }));
    expect(bad.status).toBe("FETCH_FAILED");
  });
});
