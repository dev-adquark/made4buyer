import { describe, expect, it } from "vitest";
import { dueSlot } from "@/lib/automation/daily-article";
import { mapApifyItem, PAGE_FUNCTION, sourceDataOf } from "@/lib/pipeline/apify";
import { validateContentItem } from "@/lib/pipeline/validate";

const source = { slug: "example", name: "Example Reviews", allowedDomains: ["example.test"], categoryHint: null };
const page = (over: Record<string, unknown> = {}) => ({
  m4b: 1,
  url: "https://reviews.example.test/reviews/widget-one",
  canonicalUrl: "https://reviews.example.test/reviews/widget-one",
  title: "Widget One review: a sample product page",
  datePublished: "2026-09-01T10:00:00Z",
  body: "## Verdict\n\nWidget One is a sample product described at length so the body is comfortably longer than the minimum review length.\n\n• Long battery life\n\nSize | 10 cm | 12 cm",
  ...over,
});

describe("Apify: every useful field the page stated, nothing invented", () => {
  it("passes pros/cons, identifiers, tags, breadcrumbs, FAQ, offer URL and availability through to validation", () => {
    const m = mapApifyItem(page({ pros: ["Easy to use", ""], cons: ["Pricey"], sku: "W1", gtin: "0123456789012", tags: ["Widgets"], breadcrumbs: [{ position: 1, name: "Home", url: "https://reviews.example.test/" }], faq: [{ q: "Is it good?", a: "Yes." }], offerUrl: "https://shop.example.com/w1", availability: "InStock", price: "99", currency: "USD", rating: 8, ratingScale: 10, ratingWorst: 0, authorUrl: "https://reviews.example.test/a/jo", lang: "en" }), source);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const v = validateContentItem(m.raw);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value).toMatchObject({ productUrl: "https://shop.example.com/w1", availability: "InStock", price: 99, currency: "USD", tags: ["Widgets"] });
    expect(v.value.sourceData).toMatchObject({ pros: ["Easy to use"], cons: ["Pricey"], identifiers: { sku: "W1", gtin: "0123456789012" }, rating: { value: 8, best: 10, worst: 0 }, authorUrl: "https://reviews.example.test/a/jo", faq: [{ q: "Is it good?", a: "Yes." }] });
    // Structure (headings, bullets, table rows) survives to the stored body.
    expect(v.value.body).toContain("## Verdict");
    expect(v.value.body).toContain("• Long battery life");
    expect(v.value.body).toContain("Size | 10 cm | 12 cm");
  });

  it("keeps the original item (minus body) for replay, and omits absent fields instead of filling them", () => {
    const m = mapApifyItem(page({ lang: "en" }), source);
    if (!m.ok) throw new Error("expected ok");
    expect((m.raw.sourceMeta as { raw: Record<string, unknown> }).raw).toMatchObject({ url: page().url, lang: "en" });
    expect((m.raw.sourceMeta as { raw: Record<string, unknown> }).raw.body).toBeUndefined();
    expect(sourceDataOf(page())).toBeUndefined();
    expect(m.raw.productUrl).toBeUndefined();
    // The review page's own URL is never stored as a product URL.
    const self = mapApifyItem(page({ offerUrl: "https://reviews.example.test/reviews/widget-one" }), source);
    expect(self.ok && self.raw.productUrl).toBeUndefined();
  });

  it("page function reads nested reviews, lowercase types and structured content", () => {
    expect(PAGE_FUNCTION).toContain("walk(JSON.parse");
    expect(PAGE_FUNCTION).toContain('find("review", "criticreview")');
    expect(PAGE_FUNCTION).toContain("positiveNotes");
    expect(PAGE_FUNCTION).toContain("DOMParser");
    expect(PAGE_FUNCTION).not.toContain("innerHTML");
  });
});

describe("daily slots", () => {
  it("after 19:00 IST the evening post goes before a morning retry", () => {
    const evening = new Date("2026-10-06T13:35:00Z"); // 19:05 IST
    expect(dueSlot(evening, [{ slot: "MORNING", status: "RETRYING" }])).toBe("EVENING");
    expect(dueSlot(evening, [{ slot: "MORNING", status: "RETRYING" }, { slot: "EVENING", status: "PUBLISHED" }])).toBe("MORNING");
    expect(dueSlot(new Date("2026-10-06T03:00:00Z"), [])).toBe("MORNING");
  });
});
