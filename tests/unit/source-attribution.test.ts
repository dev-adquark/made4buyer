import { describe, expect, it } from "vitest";
import { made4buyersCanonicalUrl, resolveSourceAttribution } from "@/lib/public/source-attribution";

describe("public source attribution", () => {
  it("uses a Made4Buyers canonical URL and publication date for rewrites", () => {
    expect(resolveSourceAttribution({
      kind: "REVIEW",
      contentRewritten: true,
      sourceName: "apify:publisher",
      sourceUrl: "https://publisher.example.org/review",
      author: "External author",
      sourcePublishedAt: new Date("2026-01-02T00:00:00Z"),
      publishedAt: new Date("2026-01-03T00:00:00Z"),
      canonicalPath: "/review/review-1",
    })).toEqual({
      name: "Made4Buyers",
      url: "https://made4buyers.com/review/review-1",
      author: null,
      publishedAt: "2026-01-03T00:00:00.000Z",
      isMade4Buyers: true,
    });
  });

  it("applies Made4Buyers attribution to generated guides regardless of generation provider", () => {
    expect(resolveSourceAttribution({
      kind: "AI_GUIDE",
      sourceName: "keyword-to-blog",
      canonicalPath: "/review/a-guide",
      publishedAt: "2026-01-03T00:00:00Z",
    })).toMatchObject({
      name: "Made4Buyers",
      url: "https://made4buyers.com/review/a-guide",
      isMade4Buyers: true,
    });
  });

  it("recognizes explicitly Made4Buyers-published content", () => {
    expect(resolveSourceAttribution({
      kind: "REVIEW",
      sourceName: "Made4Buyers",
      sourceUrl: "https://made4buyers.com/review/item",
      canonicalPath: "/review/item",
      publishedAt: "2026-01-03T00:00:00Z",
    })).toMatchObject({
      name: "Made4Buyers",
      url: "https://made4buyers.com/review/item",
      isMade4Buyers: true,
    });
  });

  it("retains legitimate external publisher attribution and citation URL", () => {
    expect(resolveSourceAttribution({
      kind: "REVIEW",
      sourceName: "Pack Hacker",
      sourceUrl: "https://packhacker.com/reviews/item",
      author: "Alex Doe",
      sourcePublishedAt: "2026-01-02T00:00:00Z",
      canonicalPath: "/review/item",
    })).toEqual({
      name: "Pack Hacker",
      url: "https://packhacker.com/reviews/item",
      author: "Alex Doe",
      publishedAt: "2026-01-02T00:00:00.000Z",
      isMade4Buyers: false,
    });
  });

  it("omits attribution for the specified Pack Hacker article across public surfaces", () => {
    expect(resolveSourceAttribution({
      kind: "REVIEW",
      sourceName: "Pack Hacker",
      sourceUrl: "https://www.packhacker.com/travel-gear/fjallraven/high-coast-pro-foldsack-26/",
      author: "Eric Hergenreder",
      sourcePublishedAt: "2026-01-02T00:00:00Z",
      canonicalPath: "/review/high-coast-pro-foldsack-26",
    })).toEqual({
      name: null,
      url: null,
      author: null,
      publishedAt: null,
      isMade4Buyers: false,
    });
  });

  it("uses the external source host instead of an ingestion key and omits unknown providers", () => {
    expect(resolveSourceAttribution({
      kind: "REVIEW",
      sourceName: "apify:packhacker",
      sourceUrl: "https://packhacker.com/reviews/item",
      canonicalPath: "/review/item",
    }).name).toBe("packhacker.com");
    expect(resolveSourceAttribution({
      kind: "REVIEW",
      sourceName: "apify:unknown",
      canonicalPath: "/review/item",
    }).name).toBeNull();
  });

  it("suppresses custom Content API names when they are only ingestion keys", () => {
    expect(resolveSourceAttribution({
      kind: "REVIEW",
      sourceName: "Custom feed import",
      sourceKey: "Custom feed import",
      sourceUrl: "https://packhacker.com/reviews/item",
      canonicalPath: "/review/item",
    }).name).toBe("packhacker.com");
  });

  it("does not allow content to change the Made4Buyers canonical origin", () => {
    expect(made4buyersCanonicalUrl("//outside.example/review/item")).toBe("https://made4buyers.com/");
    expect(made4buyersCanonicalUrl("/review/item")).toBe("https://made4buyers.com/review/item");
  });
});
