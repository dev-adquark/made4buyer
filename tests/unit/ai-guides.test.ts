import { describe, expect, it } from "vitest";
import { guideToContentItem, idempotencyKeyFor, markdownToPlain } from "@/lib/pipeline/ai-guides";
import { validateContentItem } from "@/lib/pipeline/validate";

const res = {
  requestId: "req_1",
  post: {
    title: "MacBook Air buying guide for students",
    meta: { description: "What to check before buying a MacBook Air as a student, and who should skip it." },
    sections: [
      { type: "introduction", contentMarkdown: "Most **students** want a [light laptop](https://x.example) that lasts all day." },
      { type: "body", heading: "Battery", contentMarkdown: "- All-day battery\n- Fast charging\n\nPlan for your heaviest day, not your average day." },
      { type: "faq", heading: "Frequently asked questions", contentMarkdown: "" },
    ],
    faqs: [{ question: "Is 8GB enough?", answer: "For notes and browsing, *usually*." }],
  },
  debug: { generationModel: "model-x" },
  quality: { status: "pass", score: 91 },
};

describe("Keyword-to-Blog mapping", () => {
  it("strips markdown to plain text paragraphs", () => {
    expect(markdownToPlain("**Bold** and [link](https://a.b) with `code`\n\n- one\n- two")).toBe("Bold and link with code\n\n• one\n• two");
  });

  it("maps a generated post onto a valid AI_GUIDE content item", () => {
    const item = guideToContentItem(res, { productName: "MacBook Air 13 (M4)", brand: "Apple", keywords: ["macbook air", "student laptop"] }, new Date("2026-09-29T00:00:00Z"));
    expect(item).toMatchObject({ id: "ktb:req_1", contentKind: "AI_GUIDE", productName: "MacBook Air 13 (M4)", publisher: "Made4Buyers (AI-assisted)" });
    expect(item.body).toContain("## Battery");
    expect(item.body).toContain("## Frequently asked questions\n\nIs 8GB enough?\nFor notes and browsing, usually.");
    expect(item.body).not.toMatch(/\*\*|\]\(/);
    const v = validateContentItem({ ...item, rating: 9 });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.contentKind).toBe("AI_GUIDE");
      expect(v.value.rating).toBeUndefined(); // generated guides never carry ratings
      expect(v.value.generation).toMatchObject({ model: "model-x", qualityScore: 91 });
    }
  });

  it("derives a stable UUID idempotency key per body and day", () => {
    const a = idempotencyKeyFor({ keywords: ["x"], topic: "t" }, "2026-09-29");
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(idempotencyKeyFor({ topic: "t", keywords: ["x"] }, "2026-09-29")).toBe(a);
    expect(idempotencyKeyFor({ keywords: ["x"], topic: "t" }, "2026-09-30")).not.toBe(a);
  });

  it("rejects responses without a post", () => {
    expect(() => guideToContentItem({}, { productName: "X", keywords: ["x"] })).toThrow(/no title or no text/);
  });
});
