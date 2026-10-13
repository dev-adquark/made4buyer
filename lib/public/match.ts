import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { cardSelect, facetCounts, LATEST_FIRST, type ReviewCard } from "@/lib/public/queries";
import type { MatchPicks, MatchStep } from "@/lib/public/listing-routes";

/**
 * Find my match: the data side of the flow (app/match/match-view.tsx renders it).
 *
 * Matching is the existing rule, unchanged: a product matches when it is a published review in the
 * chosen category carrying every chosen tag (intent, platform, price tier; "any" = no preference),
 * latest first. When nothing matches every answer, the latest answers are relaxed one by one
 * (budget, then platform, then intent) and the page says which ones were ignored.
 *
 * The options of a step are the real tag values among published reviews that fit the earlier
 * answers. A step with no options (no data for that category) is skipped: links into it carry
 * "any" so nobody has to click "skip" on a question that cannot narrow anything.
 */

export type TagStep = Exclude<MatchStep, "category">;
export const TAG_STEPS: readonly TagStep[] = ["intent", "platform", "tier"];
export const MATCH_TAG: Record<TagStep, "INTENT" | "PLATFORM" | "PRICE_TIER"> = { intent: "INTENT", platform: "PLATFORM", tier: "PRICE_TIER" };

export type MatchOption = { slug: string; name: string; count: number };
export type MatchFacets = Record<TagStep, MatchOption[]>;

/** Reviews in `category` that carry every chosen tag (minus the `drop`ped answers). */
export function matchWhere(category: string, picks: MatchPicks, drop: readonly TagStep[] = []): Prisma.NormalizedReviewWhereInput {
  return {
    categorySlug: category,
    AND: TAG_STEPS.filter((k) => picks[k] && picks[k] !== "any" && !drop.includes(k)).map((k) => ({ assignments: { some: { active: true, tagType: MATCH_TAG[k], categoryTag: { slug: picks[k]! } } } })),
  };
}

/** Facet counts per set of answers, memoized for one render (several steps share a where clause). */
export function facetLoader(category: string) {
  const memo = new Map<string, Promise<MatchFacets>>();
  return (picks: MatchPicks): Promise<MatchFacets> => {
    const chosen = TAG_STEPS.filter((k) => picks[k] && picks[k] !== "any").map((k) => `${k}=${picks[k]}`).join("&");
    let hit = memo.get(chosen);
    if (!hit) {
      hit = facetCounts(matchWhere(category, picks)).then((f) => ({ intent: f.intent, platform: f.platform, tier: f.tier }));
      memo.set(chosen, hit);
    }
    return hit;
  };
}

/** The first unanswered step, or null when every question is answered. */
export function currentStep(picks: MatchPicks): MatchStep | null {
  if (!picks.category) return "category";
  return TAG_STEPS.find((k) => !picks[k]) ?? null;
}

/**
 * Answers `picks` and then skips every following step that has no options (no data for it): those
 * become "any". "any" adds no condition, so the facets of `picks` decide every skipped step.
 */
export async function advance(picks: MatchPicks, facets: (p: MatchPicks) => Promise<MatchFacets>): Promise<MatchPicks> {
  if (!picks.category) return picks;
  const next: MatchPicks = { category: picks.category };
  for (const k of TAG_STEPS) {
    if (picks[k]) next[k] = picks[k];
    else break;
  }
  const step = currentStep(next);
  if (!step || step === "category") return next;
  const f = await facets(next);
  for (const k of TAG_STEPS.slice(TAG_STEPS.indexOf(step))) {
    if (f[k].length) break;
    next[k] = "any";
  }
  return next;
}

/** Results for a complete set of answers: strict match first, then the latest answers relaxed one by one. */
export async function matchResults(category: string, picks: MatchPicks, take = 12): Promise<{ results: ReviewCard[]; relaxed: TagStep[] }> {
  for (const drop of [[], ["tier"], ["tier", "platform"], ["tier", "platform", "intent"]] as TagStep[][]) {
    const results = await db.normalizedReview.findMany({ where: { status: "PUBLISHED", ...matchWhere(category, picks, drop) }, orderBy: LATEST_FIRST, take, select: cardSelect });
    if (results.length) return { results, relaxed: drop.filter((d) => picks[d] && picks[d] !== "any") };
  }
  return { results: [], relaxed: [] };
}
