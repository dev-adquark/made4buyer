import { describe, expect, it } from "vitest";
import { composeRenderModel, type RenderInputs } from "@/lib/pipeline/render-model";

const baseReview: RenderInputs["review"] = {
  id: "r1",
  slug: "westbreeze-packing-cubes",
  canonicalTitle: "Westbreeze Packing Cubes review",
  summary: "A short original summary.",
  body: "Paragraph one of the body.\n\nParagraph two of the body.",
  productName: "Westbreeze Packing Cubes",
  brand: "Westbreeze",
  brandSlug: "westbreeze",
  categorySlug: "travel",
  subcategorySlug: null,
  source: "apify:packhacker",
  kind: "REVIEW",
  sourceUrl: "https://packhacker.com/reviews/westbreeze",
  author: "Kristyne Defever",
  sourcePublishedAt: new Date("2026-09-23T00:00:00Z"),
  publishedAt: new Date("2026-09-24T00:00:00Z"),
  updatedAt: new Date("2026-09-24T00:00:00Z"),
};

const minimalInputs: Omit<RenderInputs, "textRights" | "contentRewritten"> = {
  review: baseReview,
  entities: null,
  assignments: [],
  image: null,
  offers: [],
};

describe("composeRenderModel: content rewrite (lib/pipeline/rewrite.ts) overrides EXCERPT rights", () => {
  it("shows no body and the original publisher as the source when EXCERPT and not rewritten", () => {
    const m = composeRenderModel({ ...minimalInputs, textRights: "EXCERPT", contentRewritten: false });
    expect(m.textRights).toBe("EXCERPT");
    expect(m.bodyParagraphs).toEqual([]);
    expect(m.contentRewritten).toBe(false);
    expect(m.source).toEqual({ name: "apify:packhacker", url: "https://packhacker.com/reviews/westbreeze", author: "Kristyne Defever", publishedAt: "2026-09-23T00:00:00.000Z" });
  });

  it("shows the full (rewritten) body and attributes it to Made4Buyers once contentRewritten, even though textRights was EXCERPT", () => {
    const m = composeRenderModel({ ...minimalInputs, textRights: "EXCERPT", contentRewritten: true });
    expect(m.textRights).toBe("FULL");
    expect(m.contentRewritten).toBe(true);
    expect(m.bodyParagraphs).toEqual(["Paragraph one of the body.", "Paragraph two of the body."]);
    expect(m.source).toEqual({ name: "Made4Buyers", url: null, author: null, publishedAt: "2026-09-23T00:00:00.000Z" });
  });
});
