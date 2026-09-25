import { CATEGORIES, INTENTS, PLATFORMS, PRICE_TIERS, type CategoryDef, type Signal } from "./definitions";

/**
 * Deterministic taxonomy classifier. Same input → same output, no randomness, no network.
 * Each field is weighted; confidence combines absolute evidence strength with the margin
 * over the runner-up so ambiguous items fall below the auto-accept threshold and go to QA.
 */

export type ClassificationInput = {
  title: string;
  productName: string;
  summary: string;
  body: string;
  sourceCategory?: string | null;
  sourceTags?: string[];
  deviceType?: string | null;
  price?: number | null;
};

export type TagDecision = {
  slug: string;
  confidence: number;
  reason: string;
  source: "RULES" | "SOURCE_FIELD";
};

export type Classification = {
  category?: TagDecision & { runnerUp?: { slug: string; score: number } };
  subcategory?: TagDecision;
  intents: TagDecision[];
  platforms: TagDecision[];
  priceTier?: TagDecision;
  scores: Record<string, number>;
};

const FIELD_WEIGHTS = { productName: 4, title: 3, deviceType: 3, sourceCategory: 3, summary: 1.5, body: 0.5 } as const;
type Field = keyof typeof FIELD_WEIGHTS;
const BODY_OCCURRENCE_CAP = 3;
const SOURCE_ALIAS_BONUS = 8;

const regexCache = new Map<string, RegExp>();
function patternRegex(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    const escaped = pattern.toLowerCase().replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const start = /^[a-z0-9]/.test(pattern) ? "(?<![a-z0-9])" : "";
    const end = /[a-z0-9]$/.test(pattern) ? "(?![a-z0-9])" : "";
    re = new RegExp(start + escaped + end, "g");
    regexCache.set(pattern, re);
  }
  re.lastIndex = 0;
  return re;
}

function occurrences(text: string, pattern: string): number {
  if (!text) return 0;
  return text.match(patternRegex(pattern))?.length ?? 0;
}

type Contribution = { field: Field; pattern: string; points: number };

function scoreSignals(signals: Signal[], fields: Partial<Record<Field, string>>, fieldSet: Field[]): { score: number; contributions: Contribution[] } {
  let score = 0;
  const contributions: Contribution[] = [];
  for (const [pattern, weight] of signals) {
    for (const field of fieldSet) {
      const text = fields[field];
      if (!text) continue;
      const count = occurrences(text, pattern);
      if (!count) continue;
      const hits = field === "body" ? Math.min(count, BODY_OCCURRENCE_CAP) : 1;
      const points = weight * FIELD_WEIGHTS[field] * hits;
      score += points;
      contributions.push({ field, pattern, points });
    }
  }
  return { score, contributions };
}

function describe(contributions: Contribution[], limit = 4): string {
  return [...contributions]
    .sort((a, b) => b.points - a.points || a.pattern.localeCompare(b.pattern))
    .slice(0, limit)
    .map((c) => `${c.field}:"${c.pattern}"(+${round(c.points)})`)
    .join(", ");
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function confidenceFromScores(top: number, second: number, strengthDivisor: number): number {
  if (top <= 0) return 0;
  const strength = Math.min(1, top / strengthDivisor);
  const margin = second > 0 ? Math.max(0, (top - second) / top) : 1;
  return round(Math.min(0.99, Math.max(0, 0.2 + 0.45 * strength + 0.35 * margin)));
}

function lowerFields(input: ClassificationInput): Partial<Record<Field, string>> {
  const tags = (input.sourceTags ?? []).join(" ");
  return {
    productName: input.productName.toLowerCase(),
    title: input.title.toLowerCase(),
    deviceType: (input.deviceType ?? "").toLowerCase(),
    sourceCategory: [input.sourceCategory ?? "", tags].join(" ").toLowerCase(),
    summary: input.summary.toLowerCase(),
    body: input.body.toLowerCase(),
  };
}

function aliasMatch(def: CategoryDef, input: ClassificationInput): string | undefined {
  const values = [input.sourceCategory ?? "", ...(input.sourceTags ?? [])].map((v) => v.trim().toLowerCase()).filter(Boolean);
  return values.find((v) => v === def.slug || v === def.name.toLowerCase() || def.aliases.includes(v));
}

export function classify(input: ClassificationInput): Classification {
  const fields = lowerFields(input);
  const allFields: Field[] = ["productName", "title", "deviceType", "sourceCategory", "summary", "body"];
  const scores: Record<string, number> = {};
  const detail = new Map<string, { contributions: Contribution[]; alias?: string }>();

  for (const def of CATEGORIES) {
    const { score, contributions } = scoreSignals(def.signals, fields, allFields);
    let total = score;
    const negative = def.negativeSignals ? scoreSignals(def.negativeSignals, fields, ["productName", "title"]) : undefined;
    if (negative?.score) total -= negative.score;
    const alias = aliasMatch(def, input);
    if (alias) total += SOURCE_ALIAS_BONUS * FIELD_WEIGHTS.sourceCategory;
    scores[def.slug] = round(Math.max(0, total));
    detail.set(def.slug, { contributions, alias });
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [topSlug, topScore] = ranked[0];
  const [secondSlug, secondScore] = ranked[1] ?? ["", 0];
  const result: Classification = { intents: [], platforms: [], scores };

  if (topScore > 0) {
    const d = detail.get(topSlug)!;
    const confidence = confidenceFromScores(topScore, secondScore, 40);
    const reasonParts = [d.alias ? `source category "${d.alias}"` : "", describe(d.contributions)].filter(Boolean);
    result.category = {
      slug: topSlug,
      confidence,
      reason: `score ${topScore}${secondScore ? ` vs ${secondSlug} ${secondScore}` : ""}; ${reasonParts.join("; ")}`,
      source: d.alias ? "SOURCE_FIELD" : "RULES",
      runnerUp: secondScore > 0 ? { slug: secondSlug, score: secondScore } : undefined,
    };

    const def = CATEGORIES.find((c) => c.slug === topSlug)!;
    const subFields: Field[] = ["productName", "title", "summary", "body"];
    const subRanked = def.subcategories
      .map((s) => ({ s, ...scoreSignals(s.signals, fields, subFields) }))
      .sort((a, b) => b.score - a.score || a.s.slug.localeCompare(b.s.slug));
    const bestSub = subRanked[0];
    if (bestSub && bestSub.score >= 10) {
      result.subcategory = {
        slug: bestSub.s.slug,
        confidence: confidenceFromScores(bestSub.score, subRanked[1]?.score ?? 0, 30),
        reason: `score ${round(bestSub.score)}; ${describe(bestSub.contributions)}`,
        source: "RULES",
      };
    }

    const priceTier = decidePriceTier(def, input.price ?? null, fields);
    if (priceTier) result.priceTier = priceTier;
  }

  const multiFields: Field[] = ["productName", "title", "summary", "body"];
  for (const intent of INTENTS) {
    const { score, contributions } = scoreSignals(intent.signals, fields, multiFields);
    if (score >= 6) {
      result.intents.push({ slug: intent.slug, confidence: round(Math.min(0.95, 0.4 + score / 40)), reason: describe(contributions, 3), source: "RULES" });
    }
  }
  for (const platform of PLATFORMS) {
    const { score, contributions } = scoreSignals(platform.signals, fields, multiFields);
    if (score >= 6) {
      result.platforms.push({ slug: platform.slug, confidence: round(Math.min(0.95, 0.4 + score / 40)), reason: describe(contributions, 3), source: "RULES" });
    }
  }
  result.intents.sort((a, b) => b.confidence - a.confidence || a.slug.localeCompare(b.slug));
  result.platforms.sort((a, b) => b.confidence - a.confidence || a.slug.localeCompare(b.slug));
  return result;
}

function decidePriceTier(def: CategoryDef, price: number | null, fields: Partial<Record<Field, string>>): TagDecision | undefined {
  if (price !== null && Number.isFinite(price) && price >= 0) {
    if (def.software) {
      if (price === 0) return { slug: "free", confidence: 0.9, reason: "extracted price is 0", source: "RULES" };
    } else if (def.priceBands) {
      const [budgetMax, midMax] = def.priceBands;
      const slug = price <= budgetMax ? "budget" : price <= midMax ? "mid-range" : "premium";
      return { slug, confidence: 0.9, reason: `extracted price ${price} vs ${def.slug} bands ≤${budgetMax} / ≤${midMax}`, source: "RULES" };
    }
  }
  const candidates = PRICE_TIERS.filter((t) => (def.software ? true : t.slug !== "free" && t.slug !== "subscription"))
    .map((t) => ({ t, ...scoreSignals(t.signals, fields, ["productName", "title", "summary"]) }))
    .filter((c) => c.score >= 6)
    .sort((a, b) => b.score - a.score || a.t.slug.localeCompare(b.t.slug));
  if (!candidates.length) return undefined;
  return { slug: candidates[0].t.slug, confidence: 0.6, reason: `keyword evidence: ${describe(candidates[0].contributions, 2)}`, source: "RULES" };
}
