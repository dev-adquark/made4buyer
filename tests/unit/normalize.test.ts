import { describe, expect, it } from "vitest";
import { canonicalTitle, contentHash, dateBucket, dedupeKey, normalizeContent, productFromTitle } from "@/lib/pipeline/normalize";
import { validateContentItem } from "@/lib/pipeline/validate";
import { htmlToPlainText, slugify, stableStringify } from "@/lib/util/text";

const body = "A long enough body for the validator. ".repeat(6);

function valid(raw: Record<string, unknown>) {
  const v = validateContentItem({ id: "x1", body, ...raw });
  if (!v.ok) throw new Error(v.issues.join("; "));
  return v.value;
}

describe("canonicalization", () => {
  it("derives the product from common headline shapes", () => {
    expect(productFromTitle("Apple MacBook Air M3 review: the best laptop")).toBe("Apple MacBook Air M3");
    expect(productFromTitle("Review: Sony WH-1000XM6")).toBe("Sony WH-1000XM6");
    expect(productFromTitle("Dell XPS 14 review — a premium Windows laptop")).toBe("Dell XPS 14");
    expect(productFromTitle("The best laptops of 2026")).toBeUndefined();
  });

  it("strips a trailing publisher suffix only when it names the publisher", () => {
    expect(canonicalTitle({ title: "Pixel 10 review | TechSite", productName: undefined, publisher: "TechSite" })).toBe("Pixel 10 review");
    expect(canonicalTitle({ title: "Pixel 10 vs iPhone | the verdict", productName: undefined, publisher: "TechSite" })).toBe("Pixel 10 vs iPhone | the verdict");
  });

  it("prefixes the product name when the headline does not mention it", () => {
    expect(canonicalTitle({ title: "Our long-term verdict after six months", productName: "Pixel 10", publisher: undefined })).toBe("Pixel 10: Our long-term verdict after six months");
  });

  it("truncates long titles on a word boundary", () => {
    const t = canonicalTitle({ title: "Word ".repeat(60), productName: undefined, publisher: undefined });
    expect(t.length).toBeLessThanOrEqual(111);
    expect(t.endsWith("…")).toBe(true);
  });

  it("slugifies deterministically", () => {
    expect(slugify("Crème Brûlée & Café: Review!")).toBe("creme-brulee-and-cafe-review");
  });

  it("converts HTML to plain text and drops scripts", () => {
    const text = htmlToPlainText("<p>Hello <b>world</b></p><script>alert(1)</script><p>Second &amp; last</p>");
    expect(text).toBe("Hello world\n\nSecond & last");
    expect(text).not.toContain("alert");
  });
});

describe("deterministic dedupe", () => {
  it("builds product|publisher|month keys and ignores a leading brand", () => {
    const d = new Date("2026-09-04T10:00:00Z");
    const a = dedupeKey({ productIdentity: "Apple MacBook Air 13", brand: "Apple", publisherKey: "reviews.example.com", date: d });
    const b = dedupeKey({ productIdentity: "MacBook Air 13", brand: undefined, publisherKey: "reviews.example.com", date: new Date("2026-09-28T00:00:00Z") });
    expect(a).toBe("macbook-air-13|reviews-example-com|2026-09");
    expect(b).toBe(a);
    expect(dedupeKey({ productIdentity: "MacBook Air 13", publisherKey: "reviews.example.com", date: new Date("2026-10-01T00:00:00Z") })).not.toBe(a);
    expect(dateBucket(d)).toBe("2026-09");
  });

  it("content hash is independent of key order and changes with content", () => {
    const one = valid({ title: "Pixel 10 review title", productName: "Pixel 10" });
    const two = valid({ productName: "Pixel 10", title: "Pixel 10 review title" });
    expect(contentHash(one)).toBe(contentHash(two));
    expect(contentHash(valid({ title: "Pixel 10 review title!", productName: "Pixel 10" }))).not.toBe(contentHash(one));
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it("normalizes a validated item into a candidate with a summary fallback", () => {
    const n = normalizeContent(valid({ title: "Google Pixel 10 review: great camera", url: "https://www.reviews.example.com/p", publishedAt: "2026-09-06T00:00:00Z" }), { source: "feed", fetchedAt: new Date() });
    expect(n.productIdentity).toBe("Google Pixel 10");
    expect(n.dedupeKey).toBe("pixel-10|reviews-example-com|2026-09");
    expect(n.summary.length).toBeGreaterThan(20);
    expect(n.canonicalUrl).toBe("https://www.reviews.example.com/p");
  });
});

describe("content validation", () => {
  it("accepts common field aliases", () => {
    const v = validateContentItem({ guid: 42, headline: "Galaxy S26 review headline", content: `<p>${body}</p>`, link: "https://x.example.com/a", pubDate: "2026-09-01", price: "$1,299.00", tags: "phones, android" });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.sourceId).toBe("42");
      expect(v.value.price).toBe(1299);
      expect(v.value.currency).toBe("USD");
      expect(v.value.tags).toEqual(["phones", "android"]);
    }
  });

  it("isolates malformed items with precise issues", () => {
    const v = validateContentItem({ title: "short", body: "tiny", url: "javascript:alert(1)" });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.issues.join(" ")).toMatch(/sourceId/);
      expect(v.issues.join(" ")).toMatch(/title/);
      expect(v.issues.join(" ")).toMatch(/body/);
      expect(v.issues.join(" ")).toMatch(/url/);
    }
    expect(validateContentItem(null).ok).toBe(false);
    expect(validateContentItem([1, 2]).ok).toBe(false);
  });
});
