import { describe, expect, it } from "vitest";
import { parseRewriteResponse, shingleSimilarity } from "@/lib/pipeline/rewrite";

describe("shingleSimilarity", () => {
  it("is near 1 for the same text, and 0 for unrelated text", () => {
    const text = "The packing cubes hang for easy access, but they take up a lot of space in the main compartment.";
    expect(shingleSimilarity(text, text)).toBeCloseTo(1, 5);
    expect(shingleSimilarity(text, "A completely different sentence about something else entirely, with no shared phrasing at all.")).toBe(0);
  });

  it("is high for a light paraphrase of the same sentences (word-swap only)", () => {
    const original = "To live out of your packing cubes on a trip instead of unpacking, try Westbreeze Packing Cubes. They hang for easy access, but take up a lot of space.";
    const thinParaphrase = "To live out of your packing cubes while traveling instead of unpacking, try Westbreeze Packing Cubes. They hang for easy access, but take up a lot of room.";
    expect(shingleSimilarity(thinParaphrase, original)).toBeGreaterThan(0.5);
  });

  it("is low for a genuine rewrite that preserves the same facts in new wording", () => {
    const original = "To live out of your packing cubes on a trip instead of unpacking, try Westbreeze Packing Cubes. They hang for easy access, but take up a lot of space.";
    const genuineRewrite = "Westbreeze's packing cubes let travelers skip unpacking entirely, hanging in a closet for quick access to clothes. The tradeoff is bulk: they occupy more luggage room than flatter alternatives.";
    expect(shingleSimilarity(genuineRewrite, original)).toBeLessThan(0.2);
  });
});

describe("parseRewriteResponse", () => {
  it("parses the documented {summary, body} JSON", () => {
    const text = '{"summary": "A quick take.", "body": "Paragraph one.\\n\\nParagraph two."}';
    expect(parseRewriteResponse(text)).toEqual({ summary: "A quick take.", body: "Paragraph one.\n\nParagraph two." });
  });

  it("strips a markdown code fence around the JSON", () => {
    const text = '```json\n{"summary": "S", "body": "B"}\n```';
    expect(parseRewriteResponse(text)).toEqual({ summary: "S", body: "B" });
  });

  it("returns null for prose, missing fields, or broken JSON", () => {
    expect(parseRewriteResponse("Sorry, I can't do that.")).toBeNull();
    expect(parseRewriteResponse('{"summary": "only a summary"}')).toBeNull();
    expect(parseRewriteResponse('{"summary": "", "body": "x"}')).toBeNull();
    expect(parseRewriteResponse("{not json")).toBeNull();
  });
});
