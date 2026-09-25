import { afterEach, describe, expect, it } from "vitest";
import { cdnUrlFor, enrichImage, placeholderPath, publicImageUrl } from "@/lib/pipeline/images";
import { withEnv } from "../support/env";

let restore: (() => void) | undefined;
afterEach(() => restore?.());

describe("image fallback", () => {
  it("uses our own category placeholder when nothing else is available", async () => {
    restore = withEnv({ IMAGE_ENRICHMENT_URL: undefined });
    const d = await enrichImage({ productName: "Pixel 10", categorySlug: "phones" });
    expect(d).toMatchObject({ sourceType: "PLACEHOLDER", sourceUrl: "/placeholders/phones.svg", licenseState: "OWNED_PLACEHOLDER", isFallback: true, enrichmentStatus: "FALLBACK" });
  });

  it("falls back (never blocks) when the Content API image is unusable", async () => {
    restore = withEnv({ IMAGE_ENRICHMENT_URL: undefined, UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: undefined });
    const d = await enrichImage({ productName: "Pixel 10", categorySlug: "unknown-cat", imageUrl: "http://10.1.2.3/image.png" });
    expect(d.isFallback).toBe(true);
    expect(d.enrichmentStatus).toBe("FAILED");
    expect(d.sourceUrl).toBe("/placeholders/general.svg");
    expect(d.issues[0].code).toBe("IMAGE_ENRICHMENT_FAILED");
  });

  it("withholds unverified-license images publicly unless configured otherwise", () => {
    const asset = { sourceType: "CONTENT_API" as const, sourceUrl: "https://img.example.com/a.jpg", cdnUrl: null, licenseState: "UNVERIFIED" as const };
    restore = withEnv({ IMAGE_REQUIRE_LICENSE: undefined });
    expect(publicImageUrl(asset, "laptops")).toEqual({ url: "/placeholders/laptops.svg", isFallback: true });
    restore();
    restore = withEnv({ IMAGE_REQUIRE_LICENSE: "false" });
    expect(publicImageUrl(asset, "laptops")).toEqual({ url: "https://img.example.com/a.jpg", isFallback: false });
    expect(publicImageUrl({ ...asset, licenseState: "PROVIDER_ASSERTED", cdnUrl: "https://cdn.example.com/x" }, "laptops").url).toBe("https://cdn.example.com/x");
  });

  it("builds CDN URLs only when configured", () => {
    restore = withEnv({ IMAGE_CDN_URL_TEMPLATE: undefined });
    expect(cdnUrlFor("https://img.example.com/a.jpg")).toBeUndefined();
    restore();
    restore = withEnv({ IMAGE_CDN_URL_TEMPLATE: "https://cdn.example.com/fetch?src={url}" });
    expect(cdnUrlFor("https://img.example.com/a b.jpg")).toBe("https://cdn.example.com/fetch?src=https%3A%2F%2Fimg.example.com%2Fa%20b.jpg");
    expect(placeholderPath(null)).toBe("/placeholders/general.svg");
  });
});
