import { SOURCE_AUTHORITY, type FactField, type ResolvedFact } from "./types";

/**
 * Deterministic product-data health score (0–100). No judgement call, no model: the same facts
 * always give the same score. Components (max points):
 *
 *   identity      30  brand 10, model or an identifier (MPN/GTIN/SKU) 10, product name 10
 *                     (VERIFIED = full, SUPPORTED = 70 %)
 *   verification  20  share of applicable fields that are VERIFIED (1.0) or SUPPORTED (0.6)
 *   source        15  authority of the strongest source behind a shown value
 *                     (manufacturer 15, feed 12, retailer 9, Wikidata 8, review 6, other 3)
 *   freshness     10  10 minus 5 per stale field (min 0)
 *   image         10  licensed exact-product image 10, neutral category image 5, none 0
 *   commerce       5  current price 5; no price 3 (absence is not an error); stale price 0
 *   provenance    10  share of shown values that carry a source URL
 *   conflicts         minus 5 per conflicting field, at most minus 15
 *
 * Bands: 100 fully verified · 90–99 highly verified · 75–89 usable but incomplete ·
 * 50–74 needs enrichment · below 50 insufficient.
 */

export type QualityBand = "FULLY_VERIFIED" | "HIGHLY_VERIFIED" | "USABLE" | "NEEDS_ENRICHMENT" | "INSUFFICIENT";

export function qualityBand(score: number): QualityBand {
  return score >= 100 ? "FULLY_VERIFIED" : score >= 90 ? "HIGHLY_VERIFIED" : score >= 75 ? "USABLE" : score >= 50 ? "NEEDS_ENRICHMENT" : "INSUFFICIENT";
}

const SOURCE_POINTS: Record<string, number> = { MANUFACTURER: 15, STRUCTURED_FEED: 12, RETAILER: 9, WIKIDATA: 8, REVIEW_SOURCE: 6, SOVRN: 6, SECONDARY: 3 };

export function qualityScore(
  resolved: Partial<Record<FactField, ResolvedFact>>,
  opts: { applicable: FactField[]; productNameKnown: boolean; image: "LICENSED_PRODUCT" | "NEUTRAL_CATEGORY" | "NONE" },
): { score: number; band: QualityBand; parts: Record<string, number> } {
  const shown = (f?: ResolvedFact) => Boolean(f && (f.status === "VERIFIED" || f.status === "SUPPORTED") && f.value != null);
  const weight = (f?: ResolvedFact) => (!shown(f) ? 0 : f!.status === "VERIFIED" ? 1 : 0.7);
  const idField = ["model", "mpn", "gtin", "sku"].map((k) => resolved[k as FactField]).reduce<ResolvedFact | undefined>((best, f) => (weight(f) > weight(best) ? f : best), undefined);
  const identity = 10 * weight(resolved.brand) + 10 * weight(idField) + (opts.productNameKnown ? 10 : 0);

  const applicable = opts.applicable.filter((f) => resolved[f]?.status !== "NOT_APPLICABLE");
  const verification = applicable.length ? (20 * applicable.reduce((n, f) => n + (resolved[f]?.status === "VERIFIED" ? 1 : resolved[f]?.status === "SUPPORTED" ? 0.6 : 0), 0)) / applicable.length : 0;

  const all = Object.values(resolved).filter((f): f is ResolvedFact => Boolean(f));
  const visible = all.filter(shown);
  const strongest = visible.reduce((best, f) => (f.chosen && SOURCE_AUTHORITY[f.chosen.source] > SOURCE_AUTHORITY[best] ? f.chosen.source : best), "SECONDARY" as keyof typeof SOURCE_AUTHORITY);
  const source = visible.length ? (SOURCE_POINTS[strongest] ?? 3) : 0;

  const stale = all.filter((f) => f.status === "STALE").length;
  const freshness = Math.max(0, 10 - 5 * stale);
  const image = opts.image === "LICENSED_PRODUCT" ? 10 : opts.image === "NEUTRAL_CATEGORY" ? 5 : 0;
  const price = resolved.price;
  const commerce = !price ? 3 : price.status === "STALE" ? 0 : shown(price) ? 5 : 3;
  const provenance = visible.length ? (10 * visible.filter((f) => f.chosen?.sourceUrl).length) / visible.length : 0;
  const conflicts = -Math.min(15, 5 * all.filter((f) => f.status === "CONFLICTING").length);

  const parts = { identity, verification, source, freshness, image, commerce, provenance, conflicts };
  const score = Math.max(0, Math.min(100, Math.round(Object.values(parts).reduce((a, b) => a + b, 0))));
  return { score, band: qualityBand(score), parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 10) / 10])) };
}
