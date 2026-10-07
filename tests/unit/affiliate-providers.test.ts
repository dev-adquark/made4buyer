import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { amazonProvider, asinFromAmazonUrl } from "@/lib/affiliate/amazon";
import { impactProvider } from "@/lib/affiliate/impact";
import { affiliateConfigIssues, affiliateProviderActive, getAffiliateProvider, noneProvider } from "@/lib/affiliate/provider";
import { resetSkimlinksCache, skimlinksProvider } from "@/lib/affiliate/skimlinks";
import { withEnv } from "../support/env";
import { miniStub, type StubReply, type StubRequest } from "../support/mini-stub";

const CLEAR = { AFFILIATE_PROVIDER: undefined, AMAZON_ASSOCIATES_TAG: undefined, SKIMLINKS_PUBLISHER_ID: undefined, SKIMLINKS_SITE_ID: undefined, SKIMLINKS_CLIENT_ID: undefined, SKIMLINKS_CLIENT_SECRET: undefined, IMPACT_ACCOUNT_SID: undefined, IMPACT_AUTH_TOKEN: undefined, IMPACT_PROGRAMS: undefined };

let route: (r: StubRequest) => StubReply = () => ({ status: 404 });
let stub: Awaited<ReturnType<typeof miniStub>>;
let restoreAll: () => void;
beforeAll(async () => {
  stub = await miniStub((r) => route(r));
  restoreAll = withEnv({ UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: "true", SKIMLINKS_AUTH_URL: `${stub.base}/access_token`, SKIMLINKS_MERCHANT_API_URL: stub.base, IMPACT_API_BASE_URL: stub.base });
});
afterAll(async () => {
  restoreAll();
  await stub.close();
});
let restore: () => void = () => undefined;
beforeEach(() => {
  restore();
  restore = withEnv(CLEAR);
  stub.requests.length = 0;
  resetSkimlinksCache();
});

describe("selection", () => {
  it("defaults to none: inactive, nothing wrapped, disclosure says no affiliate links", async () => {
    expect(getAffiliateProvider()).toBe(noneProvider);
    expect(affiliateProviderActive()).toBe(false);
    expect(await noneProvider.wrap("https://www.amazon.com/dp/B0ABCDEF12")).toMatchObject({ status: "UNAVAILABLE" });
  });

  it("a selected provider without its env vars is inactive and reports the missing NAMES", () => {
    restore = withEnv({ AFFILIATE_PROVIDER: "amazon,skimlinks,bogus" });
    expect(affiliateProviderActive()).toBe(false);
    expect(affiliateConfigIssues()).toEqual({ unknown: ["bogus"], missingEnv: ["AMAZON_ASSOCIATES_TAG", "SKIMLINKS_PUBLISHER_ID", "SKIMLINKS_SITE_ID", "SKIMLINKS_CLIENT_ID", "SKIMLINKS_CLIENT_SECRET"] });
  });
});

describe("amazon", () => {
  beforeEach(() => {
    restore = withEnv({ ...CLEAR, AFFILIATE_PROVIDER: "amazon", AMAZON_ASSOCIATES_TAG: "made4buyerstest-20" });
  });

  it("wraps only amazon.com product URLs that already carry an ASIN", async () => {
    const r = await getAffiliateProvider().wrap("https://www.amazon.com/Some-Product-Name/dp/B0ABCDEF12/ref=sr_1_1?keywords=x&th=1");
    expect(r).toEqual({ status: "AFFILIATED", affiliateUrl: "https://www.amazon.com/dp/B0ABCDEF12?tag=made4buyerstest-20", provider: "amazon" });
    expect(asinFromAmazonUrl("https://amazon.com/gp/product/0306406152")).toBe("0306406152");
  });

  it("never wraps other stores, short links, search pages or URLs without an ASIN", async () => {
    for (const url of ["https://www.amazon.co.uk/dp/B0ABCDEF12", "https://a.co/d/abc123", "https://amzn.to/3xyz", "https://www.amazon.com/s?k=laptop", "https://www.bestbuy.com/site/x/123.p", "https://www.amazon.com.evil.example/dp/B0ABCDEF12"]) {
      expect(amazonProvider.supports(url), url).toBe(false);
      expect((await amazonProvider.wrap(url)).status, url).toBe("NOT_AFFILIATABLE");
    }
  });

  it("requires a US (-20) tracking ID", () => {
    restore = withEnv({ AMAZON_ASSOCIATES_TAG: "mytag-21" });
    expect(amazonProvider.active).toBe(false);
    expect(amazonProvider.missingEnv()).toEqual(["AMAZON_ASSOCIATES_TAG"]);
  });
});

describe("skimlinks (stub Merchant API)", () => {
  beforeEach(() => {
    restore = withEnv({ ...CLEAR, AFFILIATE_PROVIDER: "skimlinks", SKIMLINKS_PUBLISHER_ID: "12345", SKIMLINKS_SITE_ID: "678", SKIMLINKS_CLIENT_ID: "client-id-test", SKIMLINKS_CLIENT_SECRET: "client-secret-test" });
    route = (r) => {
      if (r.path === "/access_token") return JSON.parse(r.body).client_secret === "client-secret-test" ? { body: { access_token: "tok-1", expiry_timestamp: Math.floor(Date.now() / 1000) + 3600 } } : { status: 401 };
      if (r.path === "/v4/publisher/12345/merchants") {
        if (r.query.get("access_token") !== "tok-1") return { status: 401 };
        return { body: { merchants: r.query.get("search") === "bestbuy.com" ? [{ id: 1, name: "Best Buy", domains: ["bestbuy.com"] }] : [] } };
      }
      return { status: 404 };
    };
  });

  it("wraps a merchant the API lists, in Skimlinks' redirect format, and verifies it", async () => {
    const dest = "https://www.bestbuy.com/site/laptop/123.p?skuId=123";
    const r = await getAffiliateProvider().wrap(dest);
    expect(r.status).toBe("AFFILIATED");
    const u = new URL((r as { affiliateUrl: string }).affiliateUrl);
    expect(u.hostname).toBe("go.skimresources.com");
    expect(u.searchParams.get("id")).toBe("12345X678");
    expect(u.searchParams.get("url")).toBe(dest);
    const auth = stub.requests.find((q) => q.path === "/access_token")!;
    expect(JSON.parse(auth.body)).toMatchObject({ client_id: "client-id-test", grant_type: "client_credentials" });
  });

  it("does not wrap a merchant the API does not list", async () => {
    expect(await skimlinksProvider.wrap("https://shop.example.org/p/1")).toMatchObject({ status: "NOT_AFFILIATABLE" });
  });

  it("falls back (UNAVAILABLE) when the API rejects credentials or answers in an unexpected shape", async () => {
    restore = withEnv({ SKIMLINKS_CLIENT_SECRET: "wrong" });
    expect(await skimlinksProvider.wrap("https://www.bestbuy.com/x")).toMatchObject({ status: "UNAVAILABLE", reason: expect.stringMatching(/rejected/) });
    restore = withEnv({ SKIMLINKS_CLIENT_SECRET: "client-secret-test" });
    resetSkimlinksCache();
    route = (r) => (r.path === "/access_token" ? { body: { access_token: "tok-1" } } : { body: { data: "?" } });
    expect(await skimlinksProvider.wrap("https://www.bestbuy.com/x")).toMatchObject({ status: "UNAVAILABLE" });
  });
});

describe("impact (stub Tracking Link API)", () => {
  beforeEach(() => {
    restore = withEnv({ ...CLEAR, AFFILIATE_PROVIDER: "impact", IMPACT_ACCOUNT_SID: "IRabcdef123456", IMPACT_AUTH_TOKEN: "impact-token-test", IMPACT_PROGRAMS: JSON.stringify({ "brand.example.com": "9999" }) });
    route = (r) => {
      if (r.method === "POST" && r.path === "/Mediapartners/IRabcdef123456/Programs/9999/TrackingLinks") {
        if (r.headers.authorization !== `Basic ${Buffer.from("IRabcdef123456:impact-token-test").toString("base64")}`) return { status: 401 };
        return { body: { TrackingURL: `https://brand.sjv.io/c/1/2/9999?u=${encodeURIComponent(r.query.get("DeepLink") ?? "")}` } };
      }
      return { status: 404 };
    };
  });

  it("wraps only mapped program domains with the TrackingURL Impact returns", async () => {
    const r = await getAffiliateProvider().wrap("https://brand.example.com/products/x");
    expect(r).toMatchObject({ status: "AFFILIATED", provider: "impact" });
    expect((r as { affiliateUrl: string }).affiliateUrl.startsWith("https://brand.sjv.io/c/1/2/9999")).toBe(true);
    expect(await impactProvider.wrap("https://other.example.net/p")).toMatchObject({ status: "NOT_AFFILIATABLE" });
  });

  it("falls back on auth failure and on an invalid TrackingURL", async () => {
    restore = withEnv({ IMPACT_AUTH_TOKEN: "wrong" });
    expect(await impactProvider.wrap("https://brand.example.com/p")).toMatchObject({ status: "UNAVAILABLE" });
    restore = withEnv({ IMPACT_AUTH_TOKEN: "impact-token-test" });
    route = () => ({ body: { TrackingURL: "javascript:alert(1)" } });
    expect(await impactProvider.wrap("https://brand.example.com/p")).toMatchObject({ status: "UNAVAILABLE" });
  });

  it("treats malformed IMPACT_PROGRAMS as missing", () => {
    restore = withEnv({ IMPACT_PROGRAMS: "{not json" });
    expect(impactProvider.active).toBe(false);
    expect(impactProvider.missingEnv()).toEqual(["IMPACT_PROGRAMS"]);
  });
});

describe("chain", () => {
  it("tries providers in order and only those that support the URL", async () => {
    restore = withEnv({ ...CLEAR, AFFILIATE_PROVIDER: "amazon,impact", AMAZON_ASSOCIATES_TAG: "made4buyerstest-20", IMPACT_ACCOUNT_SID: "IRabcdef123456", IMPACT_AUTH_TOKEN: "impact-token-test", IMPACT_PROGRAMS: JSON.stringify({ "brand.example.com": "9999" }) });
    route = () => ({ status: 500 });
    const p = getAffiliateProvider();
    expect(p.name).toBe("amazon+impact");
    expect(await p.wrap("https://www.amazon.com/dp/B0ABCDEF12")).toMatchObject({ status: "AFFILIATED", provider: "amazon" });
    expect(await p.wrap("https://brand.example.com/p")).toMatchObject({ status: "UNAVAILABLE" });
    expect(await p.wrap("https://nobody.example.org/p")).toMatchObject({ status: "NOT_AFFILIATABLE" });
  });
});
