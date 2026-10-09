import { describe, expect, it } from "vitest";
import {
  decodeCategoryState,
  decodeCouponsState,
  encodeCouponsState,
  parseCouponsQuery,
  decodeGuidesState,
  decodeMatchState,
  decodeReviewsState,
  encodeCategoryState,
  encodeMatchState,
  parseCategoryQuery,
  parseCompareIds,
  parseGuidesQuery,
  parseMatchQuery,
  parseReviewsQuery,
  rawParam,
  resolveListingRoute,
  searchQueryText,
} from "@/lib/public/listing-routes";

const isCategory = (s: string) => ["laptops", "phones"].includes(s);
const route = (url: string) => {
  const u = new URL(url, "http://x");
  return resolveListingRoute(u.pathname, u.searchParams, isCategory);
};

describe("listing routes: which URLs stay on the cached default view", () => {
  it("unfiltered URLs (and unrelated query keys) are served by the static page", () => {
    for (const u of ["/category/laptops", "/category/laptops?utm_source=x", "/category/laptops?page=1", "/category/laptops?q=", "/reviews", "/reviews?page=1", "/guides?page=1", "/match", "/compare", "/compare?ids=", "/compare?ids=bad", "/search", "/search?q=", "/search?q=%20%20", "/search?type=deals", "/deals?brand=x", "/"]) {
      expect(route(u), u).toEqual({ kind: "static" });
    }
  });

  it("filter states rewrite to one canonical ISR state route", () => {
    expect(route("/category/laptops?brand=dell")).toEqual({ kind: "rewrite", pathname: "/category/laptops/v/brand.dell~noindex" });
    // Key order in the URL does not matter: one cache entry per state.
    expect(route("/category/laptops?page=2&type=review&brand=dell")).toEqual(route("/category/laptops?brand=dell&type=review&page=2"));
    expect(route("/category/laptops?brand=dell&type=review&page=2")).toEqual({ kind: "rewrite", pathname: "/category/laptops/v/brand.dell~type.review~page.2~noindex" });
    expect(route("/reviews?type=guide&page=3")).toEqual({ kind: "rewrite", pathname: "/reviews/v/type.guide~page.3~noindex" });
    expect(route("/guides?page=2")).toEqual({ kind: "rewrite", pathname: "/guides/v/page.2~noindex" });
    expect(route("/match?tier=any&category=laptops")).toEqual({ kind: "rewrite", pathname: "/match/v/category.laptops~tier.any" });
  });

  it("raw parameters that change only the robots rule keep it (noindex) on the default list", () => {
    // Previously: `type`, `q` and a page other than "1" were noindexed even when they changed nothing.
    expect(route("/category/laptops?type=bogus")).toEqual({ kind: "rewrite", pathname: "/category/laptops/v/noindex" });
    expect(route("/category/laptops?brand=BAD!")).toEqual({ kind: "rewrite", pathname: "/category/laptops/v/noindex" });
    expect(route("/category/laptops?q=%20")).toEqual({ kind: "rewrite", pathname: "/category/laptops/v/noindex" });
    expect(route("/category/laptops?page=01")).toEqual({ kind: "rewrite", pathname: "/category/laptops/v/noindex" });
    expect(route("/reviews?type=bogus")).toEqual({ kind: "rewrite", pathname: "/reviews/v/noindex" });
    expect(route("/reviews?page=abc")).toEqual({ kind: "rewrite", pathname: "/reviews/v/noindex" });
  });

  it("free text and compare ids are rendered per request from the original query", () => {
    expect(route("/category/laptops?q=dell&brand=dell")).toEqual({ kind: "rewrite", pathname: "/category/laptops/q" });
    expect(route("/compare?ids=abcdefghij1,abcdefghij2")).toEqual({ kind: "rewrite", pathname: "/compare/q" });
    expect(route("/search?q=laptop&type=review")).toEqual({ kind: "rewrite", pathname: "/search/q" });
  });

  it("internal routes are not reachable directly", () => {
    for (const u of ["/category/laptops/v/brand.dell~noindex", "/category/laptops/q", "/reviews/v/type.guide", "/guides/v/page.2", "/match/v/category.laptops", "/compare/q", "/search/q"]) {
      expect(route(u), u).toEqual({ kind: "blocked" });
    }
    expect(route("/category/laptops")).toEqual({ kind: "static" });
  });
});

describe("listing state parsing mirrors the previous searchParams handling", () => {
  it("category", () => {
    const s = parseCategoryQuery(new URLSearchParams("brand=dell&sub=Bad Slug&q=  hello  &page=999&type=guide&intent=work"));
    expect(s.active).toEqual({ sub: undefined, brand: "dell", intent: "work", platform: undefined, tier: undefined });
    expect(s.q).toBe("hello");
    expect(s.page).toBe(500);
    expect(s.type?.param).toBe("guide");
    expect(s.noindex).toBe(true);
    expect(parseCategoryQuery({}).noindex).toBe(false);
    expect(parseCategoryQuery({ page: "1" }).noindex).toBe(false);
    expect(parseCategoryQuery({ q: "" }).noindex).toBe(false);
    expect(parseCategoryQuery({ q: "x".repeat(200) }).q).toHaveLength(80);
  });

  it("reviews, guides, match, compare and search", () => {
    expect(parseReviewsQuery({ type: "comparison", page: "2" })).toMatchObject({ page: 2, noindex: true, type: { value: "COMPARISON" } });
    expect(parseReviewsQuery({ type: "nope" })).toMatchObject({ page: 1, noindex: true, type: { value: null } });
    expect(parseGuidesQuery({ page: "-4" })).toEqual({ page: 1, noindex: true });
    expect(parseMatchQuery({ category: "bogus", intent: "work" }, isCategory)).toEqual({ intent: "work" });
    expect(parseMatchQuery({ category: "laptops", tier: "BAD" }, isCategory)).toEqual({ category: "laptops" });
    expect(parseCompareIds({ ids: "abcdefghij1, abcdefghij1 ,x,abcdefghij2,abcdefghij3,abcdefghij4" })).toEqual(["abcdefghij1", "abcdefghij2", "abcdefghij3"]);
    expect(searchQueryText({ q: `  ${"y".repeat(150)}` })).toHaveLength(100);
    expect(rawParam(new URLSearchParams("a=1&a=2"), "a")).toBe("1,2");
    expect(rawParam({ a: ["1", "2"] }, "a")).toBe("1,2");
  });

  it("state segments round-trip and reject anything not produced by the encoder", () => {
    const s = parseCategoryQuery({ tier: "budget", platform: "windows", page: "4" });
    const seg = encodeCategoryState(s);
    expect(decodeCategoryState(seg)).toEqual({ ...s, q: "" });
    expect(decodeCategoryState(encodeURIComponent(seg))).toEqual({ ...s, q: "" });
    expect(decodeCategoryState("page.4~platform.windows")).toBeNull(); // wrong order
    expect(decodeCategoryState("q.hello~noindex")).toBeNull();
    expect(decodeCategoryState("page.1~noindex")).toBeNull();
    expect(decodeCategoryState("%E0%A4%A")).toBeNull();
    expect(decodeReviewsState("type.review~noindex")).toMatchObject({ type: { param: "review" }, page: 1, noindex: true });
    expect(decodeReviewsState("type.bogus~noindex")).toBeNull();
    expect(decodeGuidesState("page.2~noindex")).toEqual({ page: 2, noindex: true });
    expect(decodeGuidesState("page.2")).toEqual({ page: 2, noindex: false });
    const picks = { category: "laptops", intent: "any" };
    expect(decodeMatchState(encodeMatchState(picks), isCategory)).toEqual(picks);
    expect(decodeMatchState("category.bogus", isCategory)).toBeNull();
  });
});

describe("/coupons paging (60 per page, cached per page)", () => {
  const go = (u: string) => {
    const url = new URL(u, "https://x.test");
    return resolveListingRoute(url.pathname, url.searchParams, () => false);
  };
  it("page 1 is the static page; ?page=N is rewritten to a cached state; internal URLs are blocked", () => {
    expect(go("/coupons")).toEqual({ kind: "static" });
    expect(go("/coupons?page=1")).toEqual({ kind: "static" });
    expect(go("/coupons?page=2")).toEqual({ kind: "rewrite", pathname: "/coupons/v/page.2~noindex" });
    expect(go("/coupons/v/page.2~noindex")).toEqual({ kind: "blocked" });
  });
  it("decodes only the canonical spelling of a state", () => {
    expect(decodeCouponsState("page.2~noindex")).toEqual({ page: 2, noindex: true });
    expect(decodeCouponsState(encodeCouponsState(parseCouponsQuery({ page: "7" })))).toEqual({ page: 7, noindex: true });
    expect(decodeCouponsState("page.02~noindex")).toBeNull();
    expect(decodeCouponsState("sort.x")).toBeNull();
  });
});
