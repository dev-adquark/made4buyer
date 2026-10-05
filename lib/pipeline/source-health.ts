import { db } from "@/lib/db";
import { log } from "@/lib/log";

/**
 * Automatic source health. A source that keeps producing nothing fresh (or keeps failing) is
 * lowered in priority and paused with exponential backoff; when the pause ends the scheduler
 * tries it again, and one fresh result restores it fully. A source is never deleted or disabled
 * here: `enabled` stays the owner's decision.
 */
export const UNHEALTHY_AFTER = 3;
export const BASE_PRIORITY = 100;
const DAY_MS = 86_400_000;
const MAX_PAUSE_MS = 7 * DAY_MS;

/** Pause length after `n` consecutive bad runs: none below the threshold, then 1, 2, 4 … days (max 7). */
export function pauseFor(n: number): number {
  return n < UNHEALTHY_AFTER ? 0 : Math.min(MAX_PAUSE_MS, DAY_MS * 2 ** (n - UNHEALTHY_AFTER));
}

function lowered(n: number): number {
  return Math.max(10, BASE_PRIORITY - 20 * n);
}

export type FreshnessTally = { fresh: number; stale: number; unknown: number; invalidDate: number };

/** After a collected run. Runs whose items were all unchanged say nothing about health. */
export async function recordSourceRun(sourceId: string, t: FreshnessTally | undefined, now = new Date()) {
  const notFresh = t ? t.stale + t.unknown + t.invalidDate : 0;
  if (t && t.fresh > 0) {
    await db.reviewSource.update({
      where: { id: sourceId },
      data: { consecutiveStale: 0, consecutiveFailures: 0, priority: BASE_PRIORITY, pausedUntil: null, lastFreshAt: now, freshCount: { increment: t.fresh }, ...(notFresh ? { staleCount: { increment: notFresh }, lastStaleAt: now } : {}), healthNote: `Healthy: ${t.fresh} fresh item(s) on ${now.toISOString().slice(0, 10)}` },
    });
    return;
  }
  if (!notFresh) {
    await db.reviewSource.update({ where: { id: sourceId }, data: { consecutiveFailures: 0 } });
    return;
  }
  const s = await db.reviewSource.update({ where: { id: sourceId }, data: { consecutiveStale: { increment: 1 }, consecutiveFailures: 0, staleCount: { increment: notFresh }, lastStaleAt: now } });
  await applyBackoff(sourceId, s.consecutiveStale, `${s.consecutiveStale} run(s) in a row with nothing fresh`, now);
}

/** After a failed run or collection. */
export async function recordSourceFailure(sourceId: string, reason: string, now = new Date()) {
  const s = await db.reviewSource.update({ where: { id: sourceId }, data: { consecutiveFailures: { increment: 1 } } });
  await applyBackoff(sourceId, s.consecutiveFailures, `${s.consecutiveFailures} failed run(s) in a row: ${reason.slice(0, 200)}`, now);
}

async function applyBackoff(sourceId: string, n: number, why: string, now: Date) {
  const ms = pauseFor(n);
  const pausedUntil = ms ? new Date(now.getTime() + ms) : null;
  await db.reviewSource.update({ where: { id: sourceId }, data: { priority: lowered(n), pausedUntil, healthNote: pausedUntil ? `Paused until ${pausedUntil.toISOString().slice(0, 16)}Z: ${why}. Retried automatically then.` : `Degraded: ${why}` } });
  if (pausedUntil) log.warn("source paused automatically", { stage: "CONTENT_FETCH", sourceId, pausedUntil: pausedUntil.toISOString(), why });
}
