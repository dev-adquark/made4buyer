import { describe, expect, it } from "vitest";
import { shownDate, sourceOf } from "@/components/review-card";

describe("review card attribution", () => {
  it("attributes rewritten reviews to Made4Buyers and uses their publication date", () => {
    const publishedAt = new Date("2026-10-12T00:00:00Z");
    expect(sourceOf({
      kind: "REVIEW",
      contentRewritten: true,
      entities: { source: "Internal provider" },
      author: "External author",
      source: "apify:publisher",
      sourceUrl: "https://publisher.example.org/review",
      slug: "review-1",
    })).toBe("Made4Buyers");
    expect(shownDate({
      kind: "REVIEW",
      contentRewritten: true,
      sourcePublishedAt: new Date("2026-09-23T00:00:00Z"),
      publishedAt,
      source: "apify:publisher",
      sourceUrl: "https://publisher.example.org/review",
      slug: "review-1",
    })).toEqual(publishedAt);
  });

  it("keeps publisher attribution and source publication date for source reviews", () => {
    const sourcePublishedAt = new Date("2026-09-23T00:00:00Z");
    expect(sourceOf({
      kind: "REVIEW",
      contentRewritten: false,
      entities: { source: "Publisher" },
      author: "External author",
      source: "apify:publisher",
      sourceUrl: "https://publisher.example.org/review",
      slug: "review-1",
    })).toBe("Publisher");
    expect(shownDate({
      kind: "REVIEW",
      contentRewritten: false,
      sourcePublishedAt,
      publishedAt: new Date("2026-09-24T00:00:00Z"),
      source: "apify:publisher",
      sourceUrl: "https://publisher.example.org/review",
      slug: "review-1",
    })).toEqual(sourcePublishedAt);
  });

  it("does not publish an ingestion provider as a source name when no real publisher is known", () => {
    expect(sourceOf({
      kind: "REVIEW",
      contentRewritten: false,
      entities: { source: "apify:publisher" },
      source: "apify:publisher",
      sourceUrl: null,
      slug: "review-1",
      author: "External author",
    })).toBeNull();
  });
});
