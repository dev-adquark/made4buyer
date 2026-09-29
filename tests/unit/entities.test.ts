import { describe, expect, it } from "vitest";
import { extractEntities, extractModelNumber, lowConfidenceFields } from "@/lib/pipeline/entities";
import { normalizeContent } from "@/lib/pipeline/normalize";
import { validateContentItem } from "@/lib/pipeline/validate";

const body = "This laptop has a great keyboard and a bright display for productivity. ".repeat(4);

function run(raw: Record<string, unknown>) {
  const v = validateContentItem({ id: "e1", body, ...raw });
  if (!v.ok) throw new Error(v.issues.join("; "));
  const n = normalizeContent(v.value, { source: "feed", fetchedAt: new Date("2026-09-01") });
  return extractEntities(v.value, n);
}

describe("entity extraction", () => {
  it("trusts explicit Content API fields with high confidence", () => {
    const e = run({ title: "XPS 14 review headline", productName: "Dell XPS 14", brand: "dell", price: 1699, modelNumber: "9440", publishedAt: "2026-09-01" });
    expect(e.brand).toBe("Dell");
    expect(e.confidences.brand).toBeGreaterThanOrEqual(0.9);
    expect(e.price).toBe(1699);
    expect(e.modelNumber).toBe("9440");
    expect(e.confidences.publishDate).toBe(0.95);
    expect(e.deviceType).toBe("laptop");
  });

  it("detects brands from product families when not written", () => {
    const e = run({ title: "ThinkPad X1 Carbon review: still the one" });
    expect(e.brand).toBe("Lenovo");
    expect(e.confidences.brand).toBeLessThan(0.95);
  });

  it("flags low-confidence core entities for QA", () => {
    const e = run({ title: "Our favourite gear for working from home" });
    const low = lowConfidenceFields(e, 0.6);
    expect(low).toContain("brand");
    expect(low).toContain("productName");
  });

  it("extracts price from text with lower confidence", () => {
    const e = run({ title: "MX Master 4 review of a productivity mouse", body: `${body} It costs $119.99 at launch.` });
    expect(e.price).toBe(119.99);
    expect(e.confidences.price).toBeLessThan(0.9);
  });

  it("model number regex ignores common false positives", () => {
    expect(extractModelNumber("Sony WH-1000XM5 headphones")).toBe("WH-1000XM5");
    expect(extractModelNumber("USB 2026 laptop with 4K screen")).toBeUndefined();
  });

  it("is deterministic", () => {
    const a = run({ title: "Google Pixel 10 review: the camera phone" });
    const b = run({ title: "Google Pixel 10 review: the camera phone" });
    expect(a).toEqual(b);
  });
});
