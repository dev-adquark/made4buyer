import type { PipelineStage } from "@prisma/client";
import Link from "next/link";
import { Badge, when } from "@/components/admin-ui";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "Failures" };

export default async function FailuresPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const showResolved = param(sp, "resolved") === "1";
  const stage = param(sp, "stage") as PipelineStage | undefined;
  const [summary, rows] = await Promise.all([
    db.pipelineFailure.groupBy({ by: ["stage", "errorCode"], where: { resolvedAt: null }, _count: { _all: true }, _sum: { occurrences: true }, _max: { lastOccurredAt: true } }),
    db.pipelineFailure.findMany({ where: { ...(showResolved ? {} : { resolvedAt: null }), ...(stage ? { stage } : {}) }, orderBy: { lastOccurredAt: "desc" }, take: 150 }),
  ]);
  return (
    <>
      <h1>Pipeline failures</h1>
      <p className="muted">Every failed stage is persisted with an error code, reason, retry count and next retry time. Retryable failures are retried by the retry-failed job with exponential backoff.</p>
      <h2>Open failures by reason</h2>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">Error code</th>
              <th scope="col" className="num">Entities</th>
              <th scope="col" className="num">Occurrences</th>
              <th scope="col">Latest</th>
            </tr>
          </thead>
          <tbody>
            {summary
              .sort((a, b) => (b._sum.occurrences ?? 0) - (a._sum.occurrences ?? 0))
              .map((s) => (
                <tr key={`${s.stage}-${s.errorCode}`}>
                  <td data-label="Stage">
                    <Link href={`/admin/failures?stage=${s.stage}`}>{s.stage}</Link>
                  </td>
                  <td data-label="Error code">{s.errorCode}</td>
                  <td data-label="Entities" className="num">{s._count._all}</td>
                  <td data-label="Occurrences" className="num">{s._sum.occurrences ?? 0}</td>
                  <td data-label="Latest">{when(s._max.lastOccurredAt)}</td>
                </tr>
              ))}
            {!summary.length && (
              <tr>
                <td colSpan={5}>No open failures.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <h2>{showResolved ? "All failures" : "Open failures"}{stage ? ` — ${stage}` : ""}</h2>
      <div className="btnrow">
        <Link className="btn small" href={showResolved ? "/admin/failures" : "/admin/failures?resolved=1"}>
          {showResolved ? "Hide resolved" : "Include resolved"}
        </Link>
        {stage && (
          <Link className="btn small" href="/admin/failures">
            All stages
          </Link>
        )}
      </div>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Stage / code</th>
              <th scope="col">Entity</th>
              <th scope="col">Reason</th>
              <th scope="col">Kind</th>
              <th scope="col" className="num">Retries</th>
              <th scope="col">Next retry</th>
              <th scope="col">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.id} className={f.resolvedAt ? "row-inactive" : undefined}>
                <td data-label="Stage / code">
                  {f.stage}
                  <div className="small">
                    <Badge value={f.errorCode} tone="warn" />
                  </div>
                </td>
                <td data-label="Entity" className="small" style={{ wordBreak: "break-all" }}>
                  {f.normalizedReviewId ? <Link href={`/admin/reviews/${f.normalizedReviewId}`}>{f.entityType}</Link> : f.entityType} {f.entityId}
                </td>
                <td data-label="Reason" className="small">{f.message}</td>
                <td data-label="Kind">
                  <Badge value={f.resolvedAt ? "RESOLVED" : f.kind} tone={f.resolvedAt ? "ok" : undefined} />
                </td>
                <td data-label="Retries" className="num">
                  {f.retryCount}/{f.maxRetries}
                </td>
                <td data-label="Next retry">{when(f.nextRetryAt)}</td>
                <td data-label="Last seen">
                  {when(f.lastOccurredAt)} ({f.occurrences}×)
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={7}>Nothing to show.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
