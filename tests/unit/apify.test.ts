import { describe, expect, it } from "vitest";
import { buildActorInput, globToRegex, hostAllowed, mapApifyItem, normalizeUrl, PAGE_FUNCTION, robotsAllows } from "@/lib/pipeline/apify";
import { validateContentItem } from "@/lib/pipeline/validate";

const source = { slug: "example", name: "Example Reviews", allowedDomains: ["example.test"], categoryHint: null };
const page = (over: Record<string, unknown> = {}) => ({
  m4b: 1,
  url: "https://reviews.example.test/reviews/widget-one",
  canonicalUrl: "https://reviews.example.test/reviews/widget-one",
  title: "Widget One review: a sample product page",
  datePublished: "2026-09-01T10:00:00Z",
  body: "Widget One is a sample product described at length so the body is comfortably longer than the minimum review length the validator requires.",
  ...over,
});

describe("Apify helpers", () => {
  it("normalizes URLs for dedupe (tracking params, hash, trailing slash, host case)", () => {
    expect(normalizeUrl("https://Example.test/a/b/?utm_source=x&b=2&a=1#frag")).toBe("https://example.test/a/b?a=1&b=2");
    expect(normalizeUrl("ftp://example.test/x")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });
  it("turns globs into anchored patterns", () => {
    const re = new RegExp(globToRegex("https://example.test/reviews/**"));
    expect(re.test("https://example.test/reviews/laptops/x")).toBe(true);
    expect(re.test("https://example.test/news/x")).toBe(false);
    expect(new RegExp(globToRegex("https://example.test/reviews/*")).test("https://example.test/reviews/a/b")).toBe(false);
  });
  it("accepts only allowed domains and their subdomains", () => {
    expect(hostAllowed("https://reviews.example.test/x", ["example.test"])).toBe(true);
    expect(hostAllowed("https://example.test.evil.org/x", ["example.test"])).toBe(false);
  });
  it("honours robots.txt for the * group, longest rule wins", () => {
    const robots = "User-agent: Googlebot\nDisallow:\n\nUser-agent: *\nDisallow: /reviews/\nAllow: /reviews/public/\n";
    expect(robotsAllows(robots, "/reviews/x")).toBe(false);
    expect(robotsAllows(robots, "/reviews/public/x")).toBe(true);
    expect(robotsAllows(robots, "/news")).toBe(true);
    expect(robotsAllows("", "/anything")).toBe(true);
  });
  it("builds a polite actor input: robots respected, no proxy, depth 1, page function compiles", () => {
    const input = buildActorInput({ slug: "example", startUrls: ["https://example.test/reviews"], reviewUrlPatterns: ["https://example.test/reviews/**"], maxPagesPerRun: 10 });
    expect(input).toMatchObject({ respectRobotsTxtFile: true, maxCrawlingDepth: 1, maxConcurrency: 2, proxyConfiguration: { useApifyProxy: false } });
    expect(() => new Function(`return (${PAGE_FUNCTION})`)()).not.toThrow();
  });
});

describe("mapping scraper output strictly", () => {
  it("maps a review page to a REVIEW with the source's own date, and never licenses its image", () => {
    const m = mapApifyItem(page({ rating: 8, ratingScale: 10, image: "https://reviews.example.test/i.jpg", productName: "Widget One", brand: "Widgets" }), source);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.raw).toMatchObject({ contentKind: "REVIEW", publishedAt: "2026-09-01T10:00:00Z", rating: 8, ratingScale: 10, imageLicenseVerified: false, publisher: "Example Reviews" });
    const v = validateContentItem(m.raw);
    expect(v.ok).toBe(true);
  });
  it("never keeps a rating without its scale", () => {
    const m = mapApifyItem(page({ rating: 4 }), source);
    expect(m.ok && "rating" in m.raw).toBe(false);
  });
  it("rejects other domains and foreign items with explicit codes", () => {
    expect(mapApifyItem(page({ url: "https://other.example.org/x", canonicalUrl: "https://other.example.org/x" }), source)).toMatchObject({ ok: false, code: "SOURCE_NOT_ALLOWED" });
    expect(mapApifyItem({ "#debug": {} }, source)).toMatchObject({ ok: false, code: "APIFY_RESPONSE_INVALID" });
    expect(mapApifyItem(page({ url: "javascript:alert(1)", canonicalUrl: null }), source)).toMatchObject({ ok: false });
  });
  it("gives each validation failure its own reason code", () => {
    const code = (over: Record<string, unknown>) => {
      const m = mapApifyItem(page(over), source);
      const v = m.ok ? validateContentItem(m.raw) : null;
      return v && !v.ok ? v.code : v?.ok ? "OK" : "MAP_FAILED";
    };
    expect(code({ datePublished: "2031-01-01T00:00:00Z" })).toBe("PUBLICATION_DATE_FUTURE");
    expect(code({ datePublished: "1970-01-02T00:00:00Z" })).toBe("PUBLICATION_DATE_TOO_OLD");
    expect(code({ datePublished: "sometime last spring" })).toBe("PUBLICATION_DATE_INVALID");
    expect(code({ body: "Too short." })).toBe("CONTENT_TOO_SHORT");
    expect(code({ datePublished: undefined })).toBe("OK"); // held in QA by PUBLICATION_DATE_MISSING instead
  });
});

describe("AI guides stay separate from reviews", () => {
  it("scraped pages are always REVIEW and AI guides never carry a rating", () => {
    expect(mapApifyItem(page({ contentKind: "AI_GUIDE" }), source)).toMatchObject({ ok: true, raw: { contentKind: "REVIEW" } });
    const guide = validateContentItem({ id: "ktb:1", title: "How to choose a mechanical keyboard", body: "x ".repeat(100), contentKind: "AI_GUIDE", rating: 9, ratingScale: 10 });
    expect(guide.ok && guide.value.contentKind === "AI_GUIDE" && guide.value.rating === undefined).toBe(true);
  });
});

describe("robots.txt wildcard matching", () => {
  it("matches prefixes, wildcards and end anchors like Google's parser", async () => {
    const { robotsPatternMatches: m } = await import("@/lib/pipeline/apify");
    expect(m("/reviews", "/reviews/x")).toBe(true);
    expect(m("/reviews", "/review")).toBe(false);
    expect(m("/*.pdf$", "/files/a.pdf")).toBe(true);
    expect(m("/*.pdf$", "/files/a.pdf?x=1")).toBe(false);
    expect(m("/a*b*c", "/a-x-b-y-c-z")).toBe(true);
    expect(m("/a*b*c", "/a-x-c-b")).toBe(false);
    expect(m("/", "/anything")).toBe(true);
    expect(m("/x$", "/x")).toBe(true);
    expect(m("/x$", "/xy")).toBe(false);
  });

  it("stays fast on hostile wildcard rules", async () => {
    const { robotsPatternMatches: m } = await import("@/lib/pipeline/apify");
    const started = Date.now();
    expect(m(`/${"*a".repeat(40)}$`, `/${"a".repeat(2000)}b`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
