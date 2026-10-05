import { describe, expect, it } from "vitest";
import { guideToContentItem, markdownToPlain } from "@/lib/pipeline/ai-guides";
import { validateContentItem } from "@/lib/pipeline/validate";
import { normalizeContent } from "@/lib/pipeline/normalize";

const req = { productName: "Laptops", keywords: ["laptops"] };

describe("Keyword-to-Blog content is kept as returned", () => {
  it("keeps every word: code, snake_case, '<$500', intro/conclusion headings, conclusion and FAQ text", () => {
    const item = guideToContentItem(
      {
        requestId: "r1",
        post: {
          title: "Best laptops under <$500 — 2026",
          meta: { description: "A short meta description." },
          sections: [
            { type: "introduction", heading: "Why this matters", contentMarkdown: "Use **bold** words, keep_snake_case and `inline code`." },
            { type: "body", heading: "Specs", contentMarkdown: "```\nRAM >= 16GB\n```" },
            { type: "faq", heading: "FAQ", contentMarkdown: "Q: Is 8GB enough? A: Barely." },
          ],
          conclusion: "Buy the one that fits.",
        },
      },
      req,
    );
    expect(item.title).toBe("Best laptops under <$500 — 2026");
    for (const text of ["## Why this matters", "keep_snake_case", "inline code", "RAM >= 16GB", "## FAQ", "Is 8GB enough?", "Buy the one that fits."]) expect(item.body).toContain(text);
    const v = validateContentItem(item);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.title).toBe("Best laptops under <$500 — 2026");
      const n = normalizeContent(v.value, { source: "keyword-to-blog", fetchedAt: new Date() });
      expect(n.canonicalTitle).toBe("Best laptops under <$500 — 2026"); // no product-name prefix
      expect(n.summary).toBe("A short meta description.");
    }
  });

  it("accepts a response with no sections when it has other text, and refuses only an empty one", () => {
    expect(guideToContentItem({ post: { title: "Tiny", conclusion: "Just this." } }, req).body).toBe("Just this.");
    expect(() => guideToContentItem({ post: { title: "", sections: [] } }, req)).toThrow(/no title or no text/);
  });

  it("only strips markup, not words", () => {
    expect(markdownToPlain("a_b_c and *emph* and **strong** [link](https://x.test)")).toBe("a_b_c and emph and strong link");
  });
});
