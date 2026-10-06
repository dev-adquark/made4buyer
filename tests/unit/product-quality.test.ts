import { describe, expect, it } from "vitest";
import { resolveFacts } from "@/lib/products/facts";
import { qualityBand, qualityScore } from "@/lib/products/quality";
import { wikidataMatch } from "@/lib/products/wikidata";
import type { Fact } from "@/lib/products/types";

const now = new Date("2026-10-06T12:00:00Z");
const f = (field: Fact["field"], value: Fact["value"], source: Fact["source"], url: string, unit: string | null = null): Fact => ({ field, value, unit, source, sourceName: new URL(url).hostname, sourceUrl: url, observedAt: new Date(now.getTime() - 3_600_000), matchBasis: "mpn" });

describe("deterministic quality score", () => {
  it("is the same for the same facts and rewards verified identity, fresh price, licensed image", () => {
    const facts = [f("brand", "Breville", "MANUFACTURER", "https://breville.com/p"), f("mpn", "BES870XL", "MANUFACTURER", "https://breville.com/p"), f("price", 699.95, "MANUFACTURER", "https://breville.com/p", "USD")];
    const resolved = resolveFacts(facts, now);
    const a = qualityScore(resolved, { applicable: ["brand", "productName", "model", "price"], productNameKnown: true, image: "LICENSED_PRODUCT" });
    const b = qualityScore(resolveFacts(facts, now), { applicable: ["brand", "productName", "model", "price"], productNameKnown: true, image: "LICENSED_PRODUCT" });
    expect(a).toEqual(b);
    expect(a.parts.identity).toBe(30);
    expect(a.parts.image).toBe(10);
    const weaker = qualityScore(resolved, { applicable: ["brand", "productName", "model", "price"], productNameKnown: true, image: "NEUTRAL_CATEGORY" });
    expect(weaker.score).toBeLessThan(a.score);
  });

  it("penalises conflicts and stale prices; nothing known scores low", () => {
    const conflicting = resolveFacts([f("brand", "Breville", "RETAILER", "https://a.example/p"), f("brand", "Sage", "RETAILER", "https://b.example/p")], now);
    const c = qualityScore(conflicting, { applicable: ["brand"], productNameKnown: true, image: "NONE" });
    expect(c.parts.conflicts).toBe(-5);
    const stale = resolveFacts([{ ...f("price", 10, "RETAILER", "https://a.example/p", "USD"), observedAt: new Date(now.getTime() - 10 * 86_400_000) }], now);
    expect(qualityScore(stale, { applicable: ["price"], productNameKnown: true, image: "NONE" }).parts.commerce).toBe(0);
    expect(qualityBand(qualityScore({}, { applicable: ["brand"], productNameKnown: false, image: "NONE" }).score)).toBe("INSUFFICIENT");
    expect([100, 95, 80, 60, 10].map(qualityBand)).toEqual(["FULLY_VERIFIED", "HIGHLY_VERIFIED", "USABLE", "NEEDS_ENRICHMENT", "INSUFFICIENT"]);
  });
});

describe("Wikidata exact-item matching", () => {
  const id = { name: "Barista Express", brand: "Breville" };
  it("accepts only an exact label with a matching brand", () => {
    expect(wikidataMatch(id, { label: "Breville Barista Express", aliases: [], brands: ["Breville"], gtin: null }).match).toBe(true);
    expect(wikidataMatch(id, { label: "Breville Barista Pro", aliases: [], brands: ["Breville"], gtin: null }).match).toBe(false);
    expect(wikidataMatch(id, { label: "Barista Express", aliases: [], brands: ["Sage"], gtin: null }).match).toBe(false);
    expect(wikidataMatch({ name: "Barista Express" }, { label: "Barista Express", aliases: [], brands: ["Breville"], gtin: null }).match).toBe(false);
    expect(wikidataMatch({ ...id, gtin: "0021614062130" }, { label: "Anything", aliases: [], brands: ["Breville"], gtin: "021614062130" }).match).toBe(true);
    expect(wikidataMatch({ ...id, gtin: "0021614062130" }, { label: "Breville Barista Express", aliases: [], brands: ["Breville"], gtin: "0021614062888" }).match).toBe(false);
  });
});

describe("Wikidata image facts are accepted by the hero picker", () => {
  it("reads the wikidata: prefix written by lib/products/wikidata.ts", async () => {
    const { matchBasisConfidence } = await import("@/lib/products/commons-image");
    expect(matchBasisConfidence("wikidata:gtin")).toBe(1);
    expect(matchBasisConfidence("wikidata:brand+name")).toBe(0.9);
    expect(matchBasisConfidence("wikidata:none")).toBeNull();
    expect(matchBasisConfidence("review-source")).toBeNull();
  });
});
