import { describe, expect, it } from "vitest";
import { dealImage, extractOfficialProductImages } from "@/lib/images/deal-image";
import { onOfficialImageCdn } from "@/lib/images/remote-patterns";

const PAGE = "https://www.nikonusa.com/p/nikkor-z-50mm/1234";
const CDN_IMG = "https://images.cdn.us-central1.gcp.commercetools.com/abc/Front-1234-50mm-large.png";

describe("official product photos on the brand's commerce CDN", () => {
  it("recognises listed commerce CDNs and nothing generic", () => {
    expect(onOfficialImageCdn(CDN_IMG)).toBe(true);
    expect(onOfficialImageCdn("https://cdn.shopify.com/s/files/1/0001/products/a.jpg")).toBe(true);
    expect(onOfficialImageCdn("https://images.ctfassets.net/x/y/z.png")).toBe(true);
    expect(onOfficialImageCdn("https://d34u8crftukxnk.cloudfront.net/a.png")).toBe(false);
    expect(onOfficialImageCdn("https://lh3.googleusercontent.com/a.png")).toBe(false);
    expect(onOfficialImageCdn("http://cdn.shopify.com/a.jpg")).toBe(false);
  });

  it("keeps a CDN photo named by the brand page's own JSON-LD Product", () => {
    const raw = { url: PAGE, jsonLd: [{ "@type": "Product", name: "NIKKOR Z 50mm", image: CDN_IMG }] };
    expect(extractOfficialProductImages(raw, PAGE).map((i) => i.src)).toEqual([CDN_IMG]);
  });

  it("never keeps a photo from an unlisted host, even in JSON-LD", () => {
    const raw = { url: PAGE, jsonLd: [{ "@type": "Product", name: "NIKKOR Z 50mm", image: "https://d34u8crftukxnk.cloudfront.net/x.png" }] };
    expect(extractOfficialProductImages(raw, PAGE)).toEqual([]);
  });

  it("shows the CDN photo on the deal card of the brand's own page", () => {
    const product = { canonicalUrl: PAGE, brand: { officialDomain: "www.nikonusa.com" }, data: { productImages: [{ src: CDN_IMG, alt: null, source: "json-ld" }] } };
    expect(dealImage(product)?.src).toBe(CDN_IMG);
  });

  it("never shows it for a retailer's page (not the brand's own photo)", () => {
    const product = { canonicalUrl: "https://www.bestbuy.com/site/nikkor/1.p", brand: { officialDomain: "www.nikonusa.com" }, data: { productImages: [{ src: CDN_IMG, alt: null, source: "json-ld" }] } };
    expect(dealImage(product)).toBeNull();
  });
});
