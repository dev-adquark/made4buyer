import { describe, expect, it } from "vitest";
import { retailerLinksFor, type RetailerLinkInput } from "@/lib/public/retailer-links";

const base = (over: Partial<RetailerLinkInput> = {}): RetailerLinkInput => ({
  status: "PUBLISHED",
  kind: "REVIEW",
  brand: "NordVPN",
  sourceUrl: "https://www.cloudwards.net/nordvpn-review/",
  canonicalUrl: "https://www.cloudwards.net/nordvpn-review/",
  sourceName: "Cloudwards",
  sourceProductUrl: null,
  facts: [],
  ...over,
});
const fact = (field: string, value: unknown, source: string, sourceName = "Example", observedAt = "2026-09-01T00:00:00Z") => ({ field, value, source, sourceName, observedAt });

describe("retailerLinksFor", () => {
  it("labels the maker's site from the source's own product link and strips tracking params", () => {
    const links = retailerLinksFor(base({ sourceProductUrl: "https://nordvpn.com/pricing/?utm_source=cloudwards&aff_id=9&plan=2y#top" }));
    expect(links).toEqual([{ url: "https://nordvpn.com/pricing/?plan=2y", label: "Official site", merchant: "nordvpn.com", kind: "official", source: "linked by Cloudwards" }]);
  });

  it("orders official first, then retailers; dedupes by URL and merchant; at most two", () => {
    const links = retailerLinksFor(
      base({
        brand: "Framework",
        sourceProductUrl: "https://www.bestbuy.com/site/fw13?ref=x",
        facts: [
          fact("retailerUrl", "https://www.bestbuy.com/site/fw13", "RETAILER", "Best Buy"),
          fact("retailerUrl", "https://www.newegg.com/p/fw13", "RETAILER", "Newegg"),
          fact("officialUrl", "https://frame.work/products/laptop13", "MANUFACTURER", "Framework"),
          fact("officialUrl", "https://frame.work/products/laptop13?utm_medium=x", "MANUFACTURER", "Framework"),
        ],
      }),
    );
    expect(links.map((l) => [l.kind, l.label, l.url])).toEqual([
      ["official", "Official site", "https://frame.work/products/laptop13"],
      ["retailer", "View at bestbuy.com", "https://www.bestbuy.com/site/fw13"],
    ]);
    expect(links).toHaveLength(2);
  });

  it("uses retailer facts when there is no official URL, and ignores URL facts from other source types", () => {
    const links = retailerLinksFor(
      base({
        brand: "Acme",
        facts: [fact("retailerUrl", "https://www.newegg.com/p/1", "RETAILER", "Newegg"), fact("retailerUrl", "https://blog.example.com/p", "SECONDARY"), fact("officialUrl", "https://acme.example.org/x", "REVIEW_SOURCE")],
      }),
    );
    expect(links.map((l) => l.merchant)).toEqual(["newegg.com"]);
    expect(links[0]).toMatchObject({ kind: "retailer", label: "View at newegg.com", source: "retailer product page (Newegg)" });
  });

  it("never links the review publisher, Made4Buyers, Sovrn/VigLink redirects or image/CDN hosts", () => {
    const cases = [
      "https://cloudwards.net/go/nordvpn",
      "https://www.made4buyers.com/review/x",
      "https://redirect.viglink.com/?u=https%3A%2F%2Fnordvpn.com",
      "https://sovrn.co/abc",
      "https://images-na.ssl-images-amazon.com/images/I/1.jpg",
      "https://cdn.shop.example.com/p/1",
      "https://shop.example.com/media/product.png",
      "https://d1.cloudfront.net/p",
    ];
    for (const u of cases) expect(retailerLinksFor(base({ sourceProductUrl: u })), u).toEqual([]);
    expect(retailerLinksFor(base({ sourceProductUrl: "https://shop.mysite.example/p" }), { siteUrl: "https://mysite.example" })).toEqual([]);
  });

  it("refuses invalid, non-http, private, internal and non-standard-port URLs", () => {
    for (const u of ["not a url", "javascript:alert(1)", "ftp://shop.example.com/p", "http://10.0.0.1/p", "http://192.168.1.10/p", "http://127.0.0.1/p", "http://localhost/p", "http://metadata/p", "https://shop.internal/p", "https://shop.example.com:2222/p", "https://user:pw@shop.example.com/p", ""]) {
      expect(retailerLinksFor(base({ sourceProductUrl: u })), u).toEqual([]);
    }
    expect(retailerLinksFor(base({ facts: [fact("officialUrl", 42, "MANUFACTURER")] }))).toEqual([]);
  });

  it("shows nothing for unpublished content or non-review kinds", () => {
    for (const status of ["NEEDS_REVIEW", "QUEUED", "UNPUBLISHED", "REJECTED"]) expect(retailerLinksFor(base({ status, sourceProductUrl: "https://nordvpn.com/" }))).toEqual([]);
    expect(retailerLinksFor(base({ kind: "COMPARISON", sourceProductUrl: "https://nordvpn.com/" }))).toEqual([]);
  });

  it("a source product link on another domain than the brand is a retailer", () => {
    const [l] = retailerLinksFor(base({ sourceProductUrl: "https://www.amazon.com/dp/B000?tag=pub-20" }));
    expect(l).toMatchObject({ kind: "retailer", label: "View at amazon.com", url: "https://www.amazon.com/dp/B000", merchant: "amazon.com" });
  });
});
