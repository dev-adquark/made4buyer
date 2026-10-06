import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAffiliateProvider, noneProvider } from "@/lib/affiliate/provider";
import { canonicalProductUrl, isAffiliateRedirectUrl } from "@/lib/net/product-url";
import { offerIsFresh, offerUrl, toPublicOffer } from "@/lib/public/offers";
import { withEnv } from "../support/env";

const HOUR = 3_600_000;
const row = (over: Partial<Parameters<typeof toPublicOffer>[0]> = {}) => ({
  id: "o1",
  seller: "Framework",
  sellerType: "MANUFACTURER",
  price: 999,
  currency: "USD",
  availability: "InStock",
  observedAt: new Date(Date.now() - HOUR),
  destinationUrl: "https://frame.work/p",
  affiliateUrl: null,
  affiliateStatus: "NONE",
  status: "FRESH",
  ...over,
});

describe("affiliate provider", () => {
  it('defaults to "none", which never wraps a URL or adds tracking', async () => {
    const r = withEnv({ AFFILIATE_PROVIDER: undefined });
    try {
      const p = getAffiliateProvider();
      expect(p.name).toBe("none");
      expect(p.active).toBe(false);
      const out = await p.wrap("https://shop.example.com/p/1");
      expect(out.status).toBe("UNAVAILABLE");
      expect(out).not.toHaveProperty("affiliateUrl");
    } finally {
      r();
    }
  });

  it('an unknown provider name falls back to "none"', () => {
    const r = withEnv({ AFFILIATE_PROVIDER: "made-up" });
    try {
      expect(getAffiliateProvider()).toBe(noneProvider);
    } finally {
      r();
    }
  });

  it("an offer link stays plain unless a provider stored an affiliate URL", () => {
    expect(offerUrl({ destinationUrl: "https://frame.work/p", affiliateUrl: null })).toEqual({ url: "https://frame.work/p", affiliated: false });
    expect(offerUrl({ destinationUrl: "https://frame.work/p", affiliateUrl: "https://aff.test/x", affiliateStatus: "AFFILIATED" })).toEqual({ url: "https://aff.test/x", affiliated: true });
    expect(offerUrl({ destinationUrl: "https://frame.work/p", affiliateUrl: "https://aff.test/x", affiliateStatus: "UNAVAILABLE" })).toEqual({ url: "https://frame.work/p", affiliated: false });
    expect(toPublicOffer(row()).url).toBe("https://frame.work/p");
  });
});

describe("price freshness", () => {
  it("a stale price is never shown", () => {
    const now = Date.now();
    expect(offerIsFresh({ observedAt: new Date(now - HOUR), status: "FRESH" }, now)).toBe(true);
    expect(offerIsFresh({ observedAt: new Date(now - 49 * HOUR), status: "FRESH" }, now)).toBe(false);
    expect(offerIsFresh({ observedAt: new Date(now - HOUR), status: "STALE" }, now)).toBe(false);
    expect(offerIsFresh({ observedAt: "not a date" }, now)).toBe(false);
    expect(toPublicOffer(row({ observedAt: new Date(now - 72 * HOUR) }), now)).toMatchObject({ price: null, currency: null, availability: null });
    expect(toPublicOffer(row({ status: "STALE" }), now).price).toBeNull();
    expect(toPublicOffer(row(), now).price).toBe(999);
  });

  it("honours PRODUCT_PRICE_MAX_AGE_HOURS", () => {
    const r = withEnv({ PRODUCT_PRICE_MAX_AGE_HOURS: "6" });
    try {
      expect(offerIsFresh({ observedAt: new Date(Date.now() - 7 * HOUR) })).toBe(false);
      expect(offerIsFresh({ observedAt: new Date(Date.now() - 5 * HOUR) })).toBe(true);
    } finally {
      r();
    }
  });
});

describe("product URL hygiene", () => {
  it("canonicalises the product URL and refuses affiliate-network redirectors", () => {
    expect(canonicalProductUrl("https://shop.example.com/p/123?utm_source=x&color=red&gclid=1#reviews")).toBe("https://shop.example.com/p/123?color=red");
    expect(canonicalProductUrl("https://redirect.viglink.com/?key=a&u=https%3A%2F%2Fshop.example.com")).toBeUndefined();
    expect(isAffiliateRedirectUrl("https://go.skimresources.com/?id=1")).toBe(true);
    expect(canonicalProductUrl("javascript:alert(1)")).toBeUndefined();
    expect(canonicalProductUrl(null)).toBeUndefined();
  });
});

describe("no Sovrn code paths on public pages", () => {
  const root = process.cwd();
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = path.join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|css)$/.test(f) ? [p] : [];
    });

  it("public app routes, components, layout and CSP contain no Sovrn / VigLink references", () => {
    const files = [...walk(path.join(root, "app")).filter((f) => !f.includes(`${path.sep}admin`) && !f.includes(`${path.sep}api${path.sep}admin`)), ...walk(path.join(root, "components")), path.join(root, "next.config.ts")];
    const hits = files.filter((f) => /sovrn|viglink|vglnk/i.test(readFileSync(f, "utf8"))).map((f) => path.relative(root, f));
    expect(hits).toEqual([]);
  });

  it("no lib/sovrn module or Sovrn env configuration remains", () => {
    expect(() => statSync(path.join(root, "lib", "sovrn"))).toThrow();
    expect(readFileSync(path.join(root, "lib", "config.ts"), "utf8")).not.toMatch(/SOVRN_/);
    expect(readFileSync(path.join(root, ".env.example"), "utf8")).not.toMatch(/SOVRN_|viglink/i);
  });
});
