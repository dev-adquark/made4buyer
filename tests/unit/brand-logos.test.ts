import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LogoChip, { chipBox } from "@/components/brand-logo-chip";
import { publicLogo } from "@/lib/commerce/brand-logo-public";
import {
  brandNameMatch,
  checkLogoFile,
  commonsFileName,
  declaredIconPx,
  extractIconCandidates,
  extractJsonLdLogos,
  logoFileOf,
  logoHostCheck,
  pickWikidataItem,
  platformDefaultReason,
  sniffImage,
  svgDimensions,
  svgUnsafeReason,
  type WdEntity,
} from "@/lib/commerce/brand-logos";

const brand = { name: "Acme", officialDomain: "www.acme.com" };
const page = "https://www.acme.com/";
const ld = (obj: unknown) => `<html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head></html>`;

function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function jpeg(w: number, h: number): Buffer {
  // SOI, APP0 (len 16), SOF0 (len 17)
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}
function webpVp8x(w: number, h: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1");
  b.write("WEBP", 8, "latin1");
  b.write("VP8X", 12, "latin1");
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}
const svg = (body = "<path d='M0 0h10v10z'/>", root = "viewBox='0 0 120 40'") => Buffer.from(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" ${root}>${body}</svg>`);

describe("JSON-LD logo parsing", () => {
  it("reads a string logo of the brand's Organization", () => {
    const r = extractJsonLdLogos(ld({ "@context": "https://schema.org", "@type": "Organization", name: "Acme Inc.", url: "https://www.acme.com", logo: "/img/logo.svg" }), page, brand);
    expect(r.candidates.map((c) => c.url)).toEqual(["https://www.acme.com/img/logo.svg"]);
    expect(r.rejected).toEqual([]);
  });

  it("reads ImageObject.url and resolves @id references inside @graph", () => {
    const html = ld({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", "@id": "https://www.acme.com/#website", publisher: { "@id": "https://www.acme.com/#org" } },
        { "@type": ["Organization"], "@id": "https://www.acme.com/#org", name: "Acme", logo: { "@id": "https://www.acme.com/#logo" } },
        { "@type": "ImageObject", "@id": "https://www.acme.com/#logo", url: "https://images.acme.com/brand/acme.png", width: 600, height: 200 },
      ],
    });
    expect(extractJsonLdLogos(html, page, brand).candidates.map((c) => c.url)).toEqual(["https://images.acme.com/brand/acme.png"]);
    const obj = ld({ "@type": "Brand", name: "ACME", logo: { "@type": "ImageObject", url: "https://www.acme.com/a.png" } });
    expect(extractJsonLdLogos(obj, page, brand).candidates[0].url).toBe("https://www.acme.com/a.png");
  });

  it("rejects a parent company, a retailer and an off-domain organization url", () => {
    const parent = extractJsonLdLogos(ld({ "@type": "Organization", name: "Widget Parent Holdings of Acme", logo: "https://www.acme.com/p.png" }), page, brand);
    expect(parent.candidates).toEqual([]);
    expect(parent.rejected[0].reason).toMatch(/is not Acme/);
    const off = extractJsonLdLogos(ld({ "@type": "Organization", name: "Acme", url: "https://www.other.com", logo: "https://www.acme.com/l.png" }), page, brand);
    expect(off.candidates).toEqual([]);
    expect(off.rejected[0].reason).toMatch(/not the brand's domain/);
  });

  it("ignores logos of non-organization nodes and malformed blocks", () => {
    const html = `<script type="application/ld+json">{not json</script>${ld({ "@type": "Product", name: "Acme", logo: "https://www.acme.com/x.png" })}`;
    expect(extractJsonLdLogos(html, page, brand)).toEqual({ candidates: [], rejected: [] });
  });
});

describe("brand name matching", () => {
  it("matches exactly after removing corporate suffixes", () => {
    expect(brandNameMatch("Apple", "Apple Inc.")).toBe("exact");
    expect(brandNameMatch("Wix", "Wix.com")).toBe("exact");
    expect(brandNameMatch("TP-Link", "TP-LINK")).toBe("exact");
    expect(brandNameMatch("Philips Hue", "Philips")).toBeNull();
    expect(brandNameMatch("Philips", "Signify")).toBeNull();
  });
  it("lets a store brand match its company, never the reverse", () => {
    expect(brandNameMatch("Google Store", "Google")).toBe("store");
    expect(brandNameMatch("Apple", "Apple Store")).toBeNull();
  });
});

describe("icon size rules", () => {
  it("ranks SVG, apple-touch-icon and ≥ 96 px icons and skips .ico and small icons", () => {
    const html = `<head>
      <link rel="icon" href="/favicon.ico">
      <link rel="icon" type="image/png" sizes="32x32" href="/f32.png">
      <link rel="icon" type="image/png" sizes="192x192" href="/f192.png">
      <link rel="apple-touch-icon" sizes="180x180" href="/apple.png">
      <link rel="mask-icon" href="/mask.svg" color="#000">
      <link rel="icon" type="image/svg+xml" href="/icon.svg">
    </head>`;
    const r = extractIconCandidates(html, page);
    expect(r.candidates.map((c) => new URL(c.url).pathname)).toEqual(["/icon.svg", "/apple.png", "/f192.png", "/mask.svg"]);
    expect(r.rejected.map((x) => x.reason)).toEqual([expect.stringMatching(/\.ico/), expect.stringMatching(/32 px/)]);
    expect(declaredIconPx("16x16 180x180")).toBe(180);
    expect(declaredIconPx("any")).toBeNull();
  });

  it("rejects a decoded raster icon under 96 px and accepts 96 px", () => {
    const base = { url: "https://www.acme.com/i.png", contentType: "image/png", kind: "icon" as const, officialDomain: "www.acme.com", source: "official-icon" as const };
    expect(checkLogoFile({ ...base, bytes: png(64, 64) })).toMatchObject({ ok: false, reason: expect.stringMatching(/under 96/) });
    expect(checkLogoFile({ ...base, bytes: png(96, 96) })).toMatchObject({ ok: true });
  });
});

describe("on-domain / CDN rules", () => {
  it("accepts the brand's registrable domain and its own subdomains only", () => {
    expect(logoHostCheck("https://www.acme.com/l.svg", "www.acme.com").ok).toBe(true);
    expect(logoHostCheck("https://images.acme.com/l.svg", "www.acme.com").ok).toBe(true);
    expect(logoHostCheck("https://cdn.acme.com/l.svg", "shop.acme.com").ok).toBe(true);
    expect(logoHostCheck("http://www.acme.com/l.svg", "www.acme.com")).toMatchObject({ ok: false, reason: expect.stringMatching(/not https/) });
    expect(logoHostCheck("https://cdn.shopify.com/s/files/l.png", "www.acme.com")).toMatchObject({ ok: false, reason: expect.stringMatching(/third-party CDN/) });
    expect(logoHostCheck("https://d1234.cloudfront.net/l.png", "www.acme.com")).toMatchObject({ ok: false, reason: expect.stringMatching(/third-party CDN/) });
    expect(logoHostCheck("https://acme.com.evil.net/l.png", "www.acme.com")).toMatchObject({ ok: false });
    expect(logoHostCheck("https://www.acme.co.uk/l.png", "www.acme.com")).toMatchObject({ ok: false });
  });
  it("reads Commons file names (originals and thumbnails)", () => {
    expect(commonsFileName("https://upload.wikimedia.org/wikipedia/commons/f/fa/Apple_logo_black.svg")).toBe("Apple_logo_black.svg");
    expect(commonsFileName("https://upload.wikimedia.org/wikipedia/commons/thumb/f/fa/Apple_logo_black.svg/512px-Apple_logo_black.svg.png")).toBe("Apple_logo_black.svg");
  });
});

describe("image decoding and checks", () => {
  it("decodes PNG, JPEG, WebP and SVG dimensions", () => {
    expect(sniffImage(png(300, 100))).toEqual({ mime: "image/png", width: 300, height: 100 });
    expect(sniffImage(jpeg(640, 320))).toEqual({ mime: "image/jpeg", width: 640, height: 320 });
    expect(sniffImage(webpVp8x(200, 80))).toEqual({ mime: "image/webp", width: 200, height: 80 });
    expect(sniffImage(svg())).toEqual({ mime: "image/svg+xml", width: 120, height: 40 });
    expect(svgDimensions("<svg width='50px' height='20'></svg>")).toEqual({ width: 50, height: 20 });
    expect(svgDimensions("<svg width='100%'></svg>")).toBeNull();
  });

  const base = { url: "https://www.acme.com/logo.png", kind: "logo" as const, officialDomain: "www.acme.com", source: "official-jsonld" as const };
  it("rejects a tracking pixel, a mismatched content type and an SVG without size", () => {
    expect(checkLogoFile({ ...base, contentType: "image/png", bytes: png(1, 1) })).toMatchObject({ ok: false, reason: expect.stringMatching(/tracking pixel/) });
    expect(checkLogoFile({ ...base, contentType: "image/jpeg", bytes: png(300, 100) })).toMatchObject({ ok: false, reason: expect.stringMatching(/does not match/) });
    expect(checkLogoFile({ ...base, contentType: "text/html", bytes: png(300, 100) })).toMatchObject({ ok: false, reason: expect.stringMatching(/not an accepted image type/) });
    expect(checkLogoFile({ ...base, url: "https://www.acme.com/l.svg", contentType: "image/svg+xml", bytes: svg("<path/>", "") })).toMatchObject({ ok: false, reason: expect.stringMatching(/viewBox/) });
  });

  it("rejects hero/banner photos and accepts a normal logo", () => {
    expect(checkLogoFile({ ...base, contentType: "image/jpeg", bytes: jpeg(1600, 900) })).toMatchObject({ ok: false, reason: expect.stringMatching(/hero|photo/) });
    expect(checkLogoFile({ ...base, url: "https://www.acme.com/img/hero-banner.png", contentType: "image/png", bytes: png(400, 120) })).toMatchObject({ ok: false, reason: expect.stringMatching(/hero/) });
    expect(checkLogoFile({ ...base, contentType: "image/png", bytes: png(400, 120) })).toMatchObject({ ok: true, format: { width: 400, height: 120 } });
  });

  it("rejects unsafe SVG: script, event handlers, external references", () => {
    expect(svgUnsafeReason("<svg><script>alert(1)</script></svg>")).toMatch(/script/);
    expect(svgUnsafeReason("<svg onload='x()'></svg>")).toMatch(/on\* event/);
    expect(svgUnsafeReason("<svg><image href='https://evil.example/x.png'/></svg>")).toMatch(/external/);
    expect(svgUnsafeReason("<svg><use xlink:href='http://x/y.svg#a'/></svg>")).toMatch(/external/);
    expect(svgUnsafeReason("<svg><rect style='fill:url(https://x/y)'/></svg>")).toMatch(/external/);
    expect(svgUnsafeReason("<svg><use href='#a'/><rect fill='url(#g)'/></svg>")).toBeNull();
    expect(checkLogoFile({ ...base, url: "https://www.acme.com/l.svg", contentType: "image/svg+xml", bytes: svg("<script>x</script>") })).toMatchObject({ ok: false, reason: expect.stringMatching(/script/) });
    expect(checkLogoFile({ ...base, url: "https://www.acme.com/l.svg", contentType: "image/svg+xml; charset=utf-8", bytes: svg() })).toMatchObject({ ok: true });
  });

  it("rejects platform default favicons except on the platform's own site", () => {
    expect(platformDefaultReason("https://assets.squarespace.com/universal/default-favicon.ico", "www.acme.com")).toMatch(/squarespace/);
    expect(platformDefaultReason("https://www.acme.com/cdn/shop/t/3/assets/default-favicon.png", "www.acme.com")).toMatch(/platform default/);
    expect(platformDefaultReason("https://www.acme.com/static/default-favicon.png", "www.acme.com")).toMatch(/platform default/);
    expect(platformDefaultReason("https://www.acme.com/static/favicon-192.png", "www.acme.com")).toBeNull();
    expect(checkLogoFile({ ...base, url: "https://www.acme.com/default_favicon.png", kind: "icon", contentType: "image/png", bytes: png(192, 192), source: "official-icon" })).toMatchObject({ ok: false, reason: expect.stringMatching(/platform default/) });
  });
});

describe("Wikidata item choice", () => {
  const item = (id: string, label: string, site: string | null, logo: string | null): WdEntity => ({
    id,
    labels: { en: { value: label } },
    claims: { ...(site ? { P856: [{ mainsnak: { datavalue: { value: site } } }] } : {}), ...(logo ? { P154: [{ mainsnak: { datavalue: { value: logo } } }] } : {}) },
  });

  it("requires the official website on the brand's registrable domain AND the label", () => {
    const ok = pickWikidataItem([item("Q1", "Acme", "https://acme.com/", "Acme logo.svg")], brand);
    expect(ok).toMatchObject({ file: "Acme logo.svg", match: "exact" });
    expect(pickWikidataItem([item("Q2", "Acme", "https://acme.org/", "x.svg")], brand)).toMatchObject({ item: null, reason: expect.stringMatching(/not acme\.com/) });
    expect(pickWikidataItem([item("Q3", "Widget Parent of Acme", "https://www.acme.com/", "x.svg")], brand)).toMatchObject({ item: null, reason: expect.stringMatching(/label is not Acme/) });
    expect(pickWikidataItem([item("Q4", "Acme", null, "x.svg")], brand)).toMatchObject({ item: null });
  });

  it("prefers an exact label, refuses ambiguity, and needs a P154", () => {
    const store = { name: "Acme Store", officialDomain: "store.acme.com" };
    expect(pickWikidataItem([item("Q5", "Acme", "https://acme.com", "company.svg"), item("Q6", "Acme Store", "https://store.acme.com", "store.svg")], store)).toMatchObject({ file: "store.svg", match: "exact" });
    expect(pickWikidataItem([item("Q7", "Acme", "https://acme.com", "a.svg"), item("Q8", "ACME", "https://www.acme.com", "b.svg")], brand)).toMatchObject({ item: null, reason: expect.stringMatching(/ambiguous/) });
    expect(pickWikidataItem([item("Q9", "Acme", "https://acme.com", null)], brand)).toMatchObject({ item: null, reason: expect.stringMatching(/P154/) });
  });

  it("uses the current logo (preferred rank, no end time)", () => {
    const e: WdEntity = { id: "Q1", claims: { P154: [{ mainsnak: { datavalue: { value: "old.svg" } }, qualifiers: { P582: [{}] } }, { mainsnak: { datavalue: { value: "new.svg" } } }, { mainsnak: { datavalue: { value: "dep.svg" } }, rank: "deprecated" }] } };
    expect(logoFileOf(e)).toBe("new.svg");
  });
});

describe("logo chip render", () => {
  const row = { logoStatus: "VERIFIED", logoUrl: "https://www.acme.com/logo.svg", logoWidth: 120, logoHeight: 40, logoMime: "image/svg+xml", logoSource: "official-jsonld", logoLicense: null };

  it("shows the logo img with alt and explicit dimensions only when VERIFIED", () => {
    const html = renderToStaticMarkup(createElement(LogoChip, { logo: publicLogo(row), name: "Acme", height: 18 }));
    expect(html).toContain('alt="Acme logo"');
    expect(html).toContain('src="https://www.acme.com/logo.svg"');
    expect(html).toMatch(/width="54"/);
    expect(html).toMatch(/height="18"/);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain("object-fit:contain");
    for (const status of ["NOT_FOUND", "FAILED", "REJECTED", null]) {
      expect(publicLogo({ ...row, logoStatus: status })).toBeNull();
      expect(renderToStaticMarkup(createElement(LogoChip, { logo: publicLogo({ ...row, logoStatus: status }), name: "Acme" }))).toBe("");
      expect(renderToStaticMarkup(createElement(LogoChip, { logo: publicLogo({ ...row, logoStatus: status }), name: "Acme", monogram: true }))).not.toContain("<img");
    }
  });

  it("never shows a non-https or dimensionless logo, and clamps the box", () => {
    expect(publicLogo({ ...row, logoUrl: "http://www.acme.com/logo.svg" })).toBeNull();
    expect(publicLogo({ ...row, logoWidth: null })).toBeNull();
    expect(chipBox({ width: 1000, height: 10 }, 20)).toEqual({ width: 80, height: 20 });
    expect(chipBox({ width: 10, height: 100 }, 20)).toEqual({ width: 20, height: 20 });
  });
});
