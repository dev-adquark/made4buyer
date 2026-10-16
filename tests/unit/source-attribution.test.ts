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

  it("uses the Made4Buyers name and canonical link for third-party reviews by default", () => {
    expect(resolveSourceAttribution({
      kind: "REVIEW",
      sourceName: "Pack Hacker",
      sourceUrl: "https://packhacker.com/reviews/item",
      author: "Alex Doe",
      sourcePublishedAt: "2026-01-02T00:00:00Z",
      publishedAt: "2026-01-03T00:00:00Z",
      canonicalPath: "/review/item",
    })).toEqual({
      name: "Made4Buyers",
      url: "https://made4buyers.com/review/item",
      author: null,
      publishedAt: "2026-01-03T00:00:00.000Z",
      isMade4Buyers: false,
    });
  });

  it("preserves third-party attribution only when explicitly required for an excerpt citation", () => {
    expect(resolveSourceAttribution({
      kind: "REVIEW",
      sourceName: "Pack Hacker",
      sourceUrl: "https://packhacker.com/reviews/item",
      author: "Eric Hergenreder",
      sourcePublishedAt: "2026-01-02T00:00:00Z",
      preserveExternalAttribution: true,
      canonicalPath: "/review/high-coast-pro-foldsack-26",
    })).toEqual({
      name: "Pack Hacker",
      url: "https://packhacker.com/reviews/item",
      author: "Eric Hergenreder",
      publishedAt: "2026-01-02T00:00:00.000Z",
      isMade4Buyers: false,
    });
  });

  it("uses Made4Buyers for provider and unknown source records", () => {
    expect(resolveSourceAttribution({
      kind: "REVIEW",
      sourceName: "apify:packhacker",
      sourceUrl: "https://packhacker.com/reviews/item",
      canonicalPath: "/review/item",
    }).name).toBe("Made4Buyers");
    expect(resolveSourceAttribution({
      kind: "REVIEW",
      sourceName: "apify:unknown",
      canonicalPath: "/review/item",
    }).name).toBe("Made4Buyers");
  });

  it("suppresses Content API source names from public attribution", () => {
    expect(resolveSourceAttribution({
      kind: "REVIEW",
      sourceName: "Custom feed import",
      sourceKey: "Custom feed import",
      sourceUrl: "https://packhacker.com/reviews/item",
      canonicalPath: "/review/item",
    }).name).toBe("Made4Buyers");
  });

  it("does not allow content to change the Made4Buyers canonical origin", () => {
    expect(made4buyersCanonicalUrl("//outside.example/review/item")).toBe("https://made4buyers.com/");
    expect(made4buyersCanonicalUrl("/review/item")).toBe("https://made4buyers.com/review/item");
  });
});
