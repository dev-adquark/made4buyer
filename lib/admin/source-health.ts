import { db } from "@/lib/db";

/**
 * Per-source crawl health for Admin → Sources, derived only from recorded runs and failures:
 * nothing here is estimated. "Discovered" counts review pages Apify extracted across all
 * collected runs, not pages that passed validation.
 */
export type SourceHealth = {
  lastSuccessAt: Date | null;
  lastFailure: { code: string; message: string; at: Date } | null;
  discovered: number;
  accepted: number;
  robots: "ALLOWED" | "DISALLOWED" | "NOT_CHECKED";
};

const FAILED_RUN = ["FAILED", "ABORTED", "TIMED-OUT", "COLLECT_FAILED"];

export async function sourceHealth(sourceIds: string[]): Promise<Map<string, SourceHealth>> {
  const out = new Map<string, SourceHealth>();
  if (!sourceIds.length) return out;
  const [totals, failedRuns, failures, started] = await Promise.all([
    db.apifyRun.groupBy({ by: ["sourceId"], where: { sourceId: { in: sourceIds }, status: "COLLECTED" }, _sum: { itemCount: true, accepted: true }, _max: { collectedAt: true } }),
    db.apifyRun.findMany({ where: { sourceId: { in: sourceIds }, status: { in: FAILED_RUN } }, orderBy: { startedAt: "desc" }, distinct: ["sourceId"], select: { sourceId: true, status: true, error: true, finishedAt: true, startedAt: true } }),
    db.pipelineFailure.findMany({ where: { entityType: "review_source", entityId: { in: sourceIds }, resolvedAt: null }, orderBy: { lastOccurredAt: "desc" }, select: { entityId: true, errorCode: true, message: true, lastOccurredAt: true } }),
    db.apifyRun.groupBy({ by: ["sourceId"], where: { sourceId: { in: sourceIds } }, _count: { _all: true } }),
  ]);
  for (const id of sourceIds) {
    const total = totals.find((t) => t.sourceId === id);
    const success = total?._max.collectedAt ?? null;
    const run = failedRuns.find((r) => r.sourceId === id);
    const open = failures.filter((f) => f.entityId === id);
    // The newest of: an unresolved start failure (robots, auth, approval) or a failed run.
    const candidates = [
      ...(open[0] ? [{ code: open[0].errorCode, message: open[0].message, at: open[0].lastOccurredAt }] : []),
      ...(run ? [{ code: run.status, message: run.error ?? `Apify run ${run.status.toLowerCase()}`, at: run.finishedAt ?? run.startedAt }] : []),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());
    const lastFailure = candidates[0] && (!success || candidates[0].at > success) ? candidates[0] : null;
    out.set(id, {
      lastSuccessAt: success,
      lastFailure,
      discovered: total?._sum.itemCount ?? 0,
      accepted: total?._sum.accepted ?? 0,
      robots: open.some((f) => f.errorCode === "ROBOTS_DISALLOWED") ? "DISALLOWED" : started.some((s) => s.sourceId === id) ? "ALLOWED" : "NOT_CHECKED",
    });
  }
  return out;
}
