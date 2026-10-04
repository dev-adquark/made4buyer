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
  /** Pages rejected at validation (bad date, too short, off-domain...). */
  rejected: number;
  /** Items recognised as already ingested. */
  duplicates: number;
  /** Articles from this source by state. */
  inQa: number;
  published: number;
  unpublishedOrRejected: number;
};

const FAILED_RUN = ["FAILED", "ABORTED", "TIMED-OUT", "COLLECT_FAILED"];

export async function sourceHealth(sourceIds: string[]): Promise<Map<string, SourceHealth>> {
  const out = new Map<string, SourceHealth>();
  if (!sourceIds.length) return out;
  const sources = await db.reviewSource.findMany({ where: { id: { in: sourceIds } }, select: { id: true, slug: true } });
  const keyOf = new Map(sources.map((s) => [s.id, `apify:${s.slug}`]));
  const keys = [...keyOf.values()];
  const [reviewStates, dupes] = await Promise.all([
    db.normalizedReview.groupBy({ by: ["source", "status"], where: { source: { in: keys } }, _count: { _all: true } }),
    db.contentItem.groupBy({ by: ["source"], where: { source: { in: keys }, processingStatus: "DUPLICATE" }, _count: { _all: true } }),
  ]);
  const [totals, failedRuns, failures, started] = await Promise.all([
    db.apifyRun.groupBy({ by: ["sourceId"], where: { sourceId: { in: sourceIds }, status: "COLLECTED" }, _sum: { itemCount: true, accepted: true, rejected: true }, _max: { collectedAt: true } }),
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
    const key = keyOf.get(id);
    const state = (statuses: string[]) => reviewStates.filter((r) => r.source === key && statuses.includes(r.status)).reduce((n, r) => n + r._count._all, 0);
    out.set(id, {
      rejected: total?._sum.rejected ?? 0,
      duplicates: dupes.find((d) => d.source === key)?._count._all ?? 0,
      inQa: state(["NEEDS_REVIEW", "QUEUED"]),
      published: state(["PUBLISHED"]),
      unpublishedOrRejected: state(["UNPUBLISHED", "REJECTED"]),
      lastSuccessAt: success,
      lastFailure,
      discovered: total?._sum.itemCount ?? 0,
      accepted: total?._sum.accepted ?? 0,
      robots: open.some((f) => f.errorCode === "ROBOTS_DISALLOWED") ? "DISALLOWED" : started.some((s) => s.sourceId === id) ? "ALLOWED" : "NOT_CHECKED",
    });
  }
  return out;
}
