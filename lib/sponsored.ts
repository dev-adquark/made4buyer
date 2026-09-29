import type { SponsoredPlacement, SponsoredPosition } from "@prisma/client";
import { cache } from "react";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { trafficSummary, defaultWindow } from "@/lib/analytics/metrics";

/**
 * Sponsored placements are inert unless ALL hold: FEATURE_SPONSORED_PLACEMENTS=true, the
 * placement is enabled, the current time is within its window, the category target matches,
 * and real 30-day first-party traffic meets its thresholds. Rendered placements are always
 * labelled and carry their disclosure.
 */

export type PlacementEvaluation = { active: boolean; reasons: string[]; traffic: { pageViews: number; sessions: number } };

const traffic = cache(() => trafficSummary(defaultWindow(30)));

export async function evaluatePlacement(p: SponsoredPlacement, now = new Date()): Promise<PlacementEvaluation> {
  const t = await traffic();
  const reasons: string[] = [];
  if (!config.sponsored.enabled()) reasons.push("FEATURE_SPONSORED_PLACEMENTS is off");
  if (!p.enabled) reasons.push("placement is disabled");
  if (p.startAt && p.startAt > now) reasons.push(`starts ${p.startAt.toISOString()}`);
  if (p.endAt && p.endAt < now) reasons.push(`ended ${p.endAt.toISOString()}`);
  if (t.pageViews < p.minMonthlyPageViews) reasons.push(`traffic threshold not met: ${t.pageViews}/${p.minMonthlyPageViews} page views (30d)`);
  if (t.sessions < p.minMonthlySessions) reasons.push(`traffic threshold not met: ${t.sessions}/${p.minMonthlySessions} sessions (30d)`);
  return { active: reasons.length === 0, reasons, traffic: t };
}

export async function activePlacement(position: SponsoredPosition, categorySlug?: string | null): Promise<SponsoredPlacement | null> {
  if (!config.sponsored.enabled()) return null;
  const now = new Date();
  const candidates = await db.sponsoredPlacement.findMany({
    where: {
      enabled: true,
      position,
      OR: [{ categorySlug: null }, ...(categorySlug ? [{ categorySlug }] : [])],
      AND: [{ OR: [{ startAt: null }, { startAt: { lte: now } }] }, { OR: [{ endAt: null }, { endAt: { gte: now } }] }],
    },
    orderBy: [{ categorySlug: { sort: "desc", nulls: "last" } }, { createdAt: "asc" }],
    take: 5,
  });
  for (const p of candidates) {
    if ((await evaluatePlacement(p, now)).active) return p;
  }
  return null;
}
