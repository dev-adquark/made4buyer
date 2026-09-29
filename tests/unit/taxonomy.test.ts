import { describe, expect, it } from "vitest";
import { classify, confidenceFromScores } from "@/lib/taxonomy/classify";
import { CATEGORIES } from "@/lib/taxonomy/definitions";

const base = { summary: "", body: "" };

describe("taxonomy classifier", () => {
  it("covers the required buyer categories", () => {
    for (const slug of ["laptops", "phones", "ai-tools", "developer-software", "accessories"]) expect(CATEGORIES.some((c) => c.slug === slug)).toBe(true);
  });

  it.each([
    ["Dell XPS 14 review: a premium laptop", "Dell XPS 14", "laptops"],
    ["Google Pixel 10 review", "Pixel 10", "phones"],
    ["ChatGPT Plus review: is the AI assistant worth it?", "ChatGPT Plus", "ai-tools"],
    ["Visual Studio Code review: the code editor", "Visual Studio Code", "developer-software"],
    ["Logitech MX Master 4 wireless mouse review", "MX Master 4", "accessories"],
    ["Sony WH-1000XM6 noise cancelling headphones review", "WH-1000XM6", "audio"],
  ])("classifies %s", (title, productName, expected) => {
    const c = classify({ ...base, title, productName });
    expect(c.category?.slug).toBe(expected);
  });

  it("treats accessories for a device as accessories (negative signals)", () => {
    const c = classify({ ...base, title: "Best laptop stand review", productName: "Rain Design laptop stand" });
    expect(c.category?.slug).toBe("accessories");
  });

  it("uses the source category field as strong evidence", () => {
    const c = classify({ ...base, title: "Gizmo Pro review", productName: "Gizmo Pro", sourceCategory: "Phones" });
    expect(c.category?.slug).toBe("phones");
    expect(c.category?.source).toBe("SOURCE_FIELD");
  });

  it("returns no category when there is no evidence", () => {
    const c = classify({ ...base, title: "A day at the seaside", productName: "Seaside" });
    expect(c.category).toBeUndefined();
  });

  it("gives ambiguous items lower confidence than clear ones", () => {
    const clear = classify({ ...base, title: "MacBook Air laptop review", productName: "MacBook Air", body: "laptop laptop laptop" });
    const mixed = classify({ ...base, title: "Laptop and phone accessories we like", productName: "Gear", body: "laptop phone keyboard" });
    expect(clear.category!.confidence).toBeGreaterThan(mixed.category!.confidence);
    expect(clear.category!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("assigns subcategory, intents, platforms and price tier", () => {
    const c = classify({ title: "Razer Blade 16 gaming laptop review", productName: "Razer Blade 16 gaming laptop", summary: "A gaming laptop running Windows 11 for gamers.", body: "gaming gaming windows 11 rtx", price: 2999 });
    expect(c.category?.slug).toBe("laptops");
    expect(c.subcategory?.slug).toBe("gaming-laptops");
    expect(c.intents.map((i) => i.slug)).toContain("gaming");
    expect(c.platforms.map((p) => p.slug)).toContain("windows");
    expect(c.priceTier).toMatchObject({ slug: "premium", confidence: 0.9 });
  });

  it("is deterministic across runs", () => {
    const input = { title: "Docker Desktop review", productName: "Docker Desktop", summary: "containers", body: "docker kubernetes devops" };
    expect(classify(input)).toEqual(classify(input));
  });
});

describe("confidence scoring", () => {
  it("combines strength and margin within [0, 0.99]", () => {
    expect(confidenceFromScores(0, 0, 40)).toBe(0);
    expect(confidenceFromScores(100, 0, 40)).toBe(0.99);
    expect(confidenceFromScores(20, 20, 40)).toBeLessThan(confidenceFromScores(20, 5, 40));
    expect(confidenceFromScores(10, 0, 40)).toBeLessThan(confidenceFromScores(40, 0, 40));
  });
});
