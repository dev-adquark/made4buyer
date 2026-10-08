import { describe, expect, it } from "vitest";
import { COMMONS_WIDTHS, commonsThumbUrl, parseCommons, pexelsUrl, responsiveImage } from "@/lib/util/image-url";

const PEXELS = "https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&h=627&fit=crop&w=1200";
const entries = (srcSet?: string) => (srcSet ?? "").split(", ").map((e) => e.split(" "));

describe("pexelsUrl", () => {
  it("resizes keeping the crop's aspect ratio and every other parameter", () => {
    const u = new URL(pexelsUrl(PEXELS, 640));
    expect(u.searchParams.get("w")).toBe("640");
    expect(u.searchParams.get("h")).toBe("334");
    expect(u.searchParams.get("fit")).toBe("crop");
    expect(u.searchParams.get("auto")).toBe("compress");
    expect(u.searchParams.get("cs")).toBe("tinysrgb");
    expect(u.pathname).toBe("/photos/2014422/pexels-photo-2014422.jpeg");
  });
  it("drops dpr and a lone h, and adds compression when missing", () => {
    const u = new URL(pexelsUrl("https://images.pexels.com/photos/1/x.jpeg?h=650&dpr=2&fm=jpg", 480));
    expect(u.searchParams.get("w")).toBe("480");
    expect(u.searchParams.has("h")).toBe(false);
    expect(u.searchParams.has("dpr")).toBe(false);
    expect(u.searchParams.get("fm")).toBe("jpg");
    expect(u.searchParams.get("auto")).toBe("compress");
    expect(new URL(pexelsUrl("https://images.pexels.com/photos/1/x.jpeg", 320)).search).toBe("?w=320&auto=compress&cs=tinysrgb");
  });
  it("keeps a portrait crop's ratio", () => {
    const u = new URL(pexelsUrl("https://images.pexels.com/photos/5/p.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800", 400));
    expect([u.searchParams.get("w"), u.searchParams.get("h")]).toEqual(["400", "600"]);
  });
  it("leaves other hosts alone", () => {
    expect(pexelsUrl("https://www.pexels.com/photo/1/", 320)).toBe("https://www.pexels.com/photo/1/");
    expect(pexelsUrl("/placeholders/audio.svg", 320)).toBe("/placeholders/audio.svg");
  });
});

describe("Wikimedia thumbnails", () => {
  const ORIG = "https://upload.wikimedia.org/wikipedia/commons/4/44/Caf_3000_en_la_Estaci%C3%B3n_de_Trinitat_Nova.jpg";
  it("builds the thumb path from an original, keeping the encoded name", () => {
    expect(commonsThumbUrl(ORIG, 500)).toBe("https://upload.wikimedia.org/wikipedia/commons/thumb/4/44/Caf_3000_en_la_Estaci%C3%B3n_de_Trinitat_Nova.jpg/500px-Caf_3000_en_la_Estaci%C3%B3n_de_Trinitat_Nova.jpg");
  });
  it("re-sizes an existing thumb and ignores tracking query strings", () => {
    const thumb = "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Foo_(bar)%2C_baz.png/1280px-Foo_(bar)%2C_baz.png?utm_source=commons.wikimedia.org";
    expect(parseCommons(thumb)?.thumbWidth).toBe(1280);
    expect(commonsThumbUrl(thumb, 330)).toBe("https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Foo_(bar)%2C_baz.png/330px-Foo_(bar)%2C_baz.png");
  });
  it("renders TIFFs as lossy JPEG thumbnails", () => {
    expect(commonsThumbUrl("https://upload.wikimedia.org/wikipedia/commons/1/12/Scan.tif", 960)).toBe("https://upload.wikimedia.org/wikipedia/commons/thumb/1/12/Scan.tif/lossy-page1-960px-Scan.tif.jpg");
    expect(parseCommons("https://upload.wikimedia.org/wikipedia/commons/thumb/1/12/Scan.tif/lossy-page1-960px-Scan.tif.jpg")?.thumbWidth).toBe(960);
  });
  it("abbreviates very long names to thumbnail.<ext>, as MediaWiki does", () => {
    const long = `${"Steel_bridge_structure_".repeat(8)}Amsterdam%2C_2005.TIF`;
    expect(commonsThumbUrl(`https://upload.wikimedia.org/wikipedia/commons/f/fd/${long}`, 500)).toBe(`https://upload.wikimedia.org/wikipedia/commons/thumb/f/fd/${long}/lossy-page1-500px-thumbnail.tif.jpg`);
  });
  it("does not thumbnail SVG, PDF or malformed paths", () => {
    expect(commonsThumbUrl("https://upload.wikimedia.org/wikipedia/commons/f/f2/UAAR_logo_2012.svg", 500)).toBeNull();
    expect(commonsThumbUrl("https://upload.wikimedia.org/wikipedia/commons/f/f2/Doc.pdf", 500)).toBeNull();
    expect(commonsThumbUrl("https://upload.wikimedia.org/wikipedia/commons/f/a2/Mismatch.jpg", 500)).toBeNull();
    expect(commonsThumbUrl("https://example.org/wikipedia/commons/f/f2/X.jpg", 500)).toBeNull();
  });
});

describe("responsiveImage", () => {
  it("builds a Pexels srcset capped at the URL's own width", () => {
    const r = responsiveImage(PEXELS, { maxWidth: 1280 });
    expect(r.src).toBe(PEXELS);
    const e = entries(r.srcSet);
    expect(e.map(([, d]) => d)).toEqual(["160w", "320w", "480w", "640w", "960w", "1200w"]);
    expect(e.at(-1)?.[0]).toContain("w=1200");
  });
  it("stops at the first candidate that covers maxWidth", () => {
    expect(entries(responsiveImage(PEXELS, { maxWidth: 600 }).srcSet).map(([, d]) => d)).toEqual(["160w", "320w", "480w", "640w"]);
  });
  it("shrinks descriptors when a wide crop is covered into a narrower box", () => {
    // 1200x627 (1.91:1) into a square 84px slot: the visible part is ~1.91x narrower.
    const e = entries(responsiveImage(PEXELS, { maxWidth: 168, boxAspect: 1 }).srcSet);
    expect(e.map(([, d]) => d)).toEqual(["84w", "167w", "251w"]);
    expect(e[2][0]).toContain("w=480");
  });
  it("uses only Wikimedia's standard steps, capped by the known source width", () => {
    const src = "https://upload.wikimedia.org/wikipedia/commons/4/44/Cafe.jpg";
    const e = entries(responsiveImage(src, { sourceWidth: 1100, maxWidth: 4000 }).srcSet);
    expect(e.map(([, d]) => Number(d.slice(0, -1)))).toEqual([120, 250, 330, 500, 960, 1100]);
    expect(e.slice(0, -1).every(([, d]) => (COMMONS_WIDTHS as readonly number[]).includes(Number(d.slice(0, -1))))).toBe(true);
    expect(e.at(-1)?.[0]).toBe(src);
  });
  it("caps a Wikimedia thumb at its own width", () => {
    const r = responsiveImage("https://upload.wikimedia.org/wikipedia/commons/thumb/4/44/Cafe.jpg/960px-Cafe.jpg");
    expect(entries(r.srcSet).at(-1)).toEqual(["https://upload.wikimedia.org/wikipedia/commons/thumb/4/44/Cafe.jpg/960px-Cafe.jpg", "960w"]);
  });
  it("gives a TIFF a displayable JPEG src", () => {
    const r = responsiveImage("https://upload.wikimedia.org/wikipedia/commons/1/12/Scan.tif", { maxWidth: 900 });
    expect(r.src).toBe("https://upload.wikimedia.org/wikipedia/commons/thumb/1/12/Scan.tif/lossy-page1-960px-Scan.tif.jpg");
    expect(r.srcSet).toContain("lossy-page1-500px-Scan.tif.jpg 500w");
  });
  it("percent-encodes raw commas so srcset entries don't split", () => {
    const r = responsiveImage("https://upload.wikimedia.org/wikipedia/commons/a/ab/A,_b.jpg", { maxWidth: 300 });
    expect(r.srcSet).toBe("https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/A%2C_b.jpg/120px-A%2C_b.jpg 120w, https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/A%2C_b.jpg/250px-A%2C_b.jpg 250w, https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/A%2C_b.jpg/330px-A%2C_b.jpg 330w");
    expect(r.src).toBe("https://upload.wikimedia.org/wikipedia/commons/a/ab/A,_b.jpg");
  });
  it("passes local, unknown-host, SVG and tiny images through untouched", () => {
    for (const src of ["/placeholders/audio.svg", "https://cdn.example.com/p.jpg?w=1200", "https://upload.wikimedia.org/wikipedia/commons/f/f2/Logo.svg", "http://images.pexels.com/photos/1/x.jpeg", "not a url"]) {
      expect(responsiveImage(src, { maxWidth: 1280 })).toEqual({ src });
    }
    const tiny = "https://images.pexels.com/photos/1/x.jpeg?w=100&h=50";
    expect(responsiveImage(tiny)).toEqual({ src: tiny });
  });
});

describe("Shopify CDN images (brand stores)", () => {
  it("builds a width-based srcset for /cdn/shop/ and cdn.shopify.com URLs, keeping existing params", async () => {
    const { responsiveImage } = await import("@/lib/util/image-url");
    const r = responsiveImage("https://us.sennheiser-hearing.com/cdn/shop/files/HD_560_S.jpg?v=1759792454", { maxWidth: 600 });
    expect(r.srcSet).toContain("width=240");
    expect(r.srcSet).toContain("v=1759792454");
    expect(r.srcSet).toMatch(/width=600 600w/);
    expect(r.srcSet).not.toContain("width=800");
    expect(responsiveImage("https://cdn.shopify.com/s/files/1/0001/products/a.jpg", { maxWidth: 300 }).srcSet).toContain("width=360");
  });
  it("leaves other brand hosts alone", async () => {
    const { responsiveImage } = await import("@/lib/util/image-url");
    expect(responsiveImage("https://www.example-brand.com/images/a.jpg").srcSet).toBeUndefined();
  });
});
