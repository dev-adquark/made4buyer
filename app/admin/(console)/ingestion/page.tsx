import type { ContentProcessingStatus } from "@prisma/client";
import Link from "next/link";
import Flash from "@/components/flash";
import { ActionForm, Badge, Pager, when } from "@/components/admin-ui";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { integrationStatus } from "@/lib/config";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ingestion" };

const STATUSES: ContentProcessingStatus[] = ["INGESTED", "NORMALIZED", "DUPLICATE", "FAILED", "QUEUED", "PUBLISHED", "REJECTED"];

export default async function IngestionPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const status = STATUSES.includes(param(sp, "status") as ContentProcessingStatus) ? (param(sp, "status") as ContentProcessingStatus) : undefined;
  const page = Math.max(1, Number(param(sp, "page")) || 1);
  const [runs, counts, itemsTotal, items] = await Promise.all([
    db.ingestionRun.findMany({ orderBy: { startedAt: "desc" }, take: 25 }),
    db.contentItem.groupBy({ by: ["processingStatus"], _count: { _all: true } }),
    db.contentItem.count({ where: status ? { processingStatus: status } : {} }),
    db.contentItem.findMany({ where: status ? { processingStatus: status } : {}, orderBy: { updatedAt: "desc" }, skip: (page - 1) * 50, take: 50, select: { id: true, source: true, sourceId: true, processingStatus: true, errorCode: true, statusReason: true, fetchedAt: true, normalizedReviewId: true, dedupeKey: true } }),
  ]);
  const count = (s: string) => counts.find((c) => c.processingStatus === s)?._count._all ?? 0;
  const contentReady = integrationStatus().contentApi === "READY";

  return (
    <>
      <h1>Ingestion</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      {!contentReady && <p className="notice warn">Content API is BLOCKED_BY_ENVIRONMENT: set CONTENT_API_URL (and CONTENT_API_KEY) to enable ingestion.</p>}
      <div className="btnrow">
        <ActionForm action="/api/admin/jobs" fields={{ job: "ingest" }} label="Run ingestion now" returnTo="/admin/ingestion" className="btn primary" disabledReason={contentReady ? undefined : "CONTENT_API_URL not configured"} />
        <ActionForm action="/api/admin/jobs" fields={{ job: "retry-failed" }} label="Retry failed items" returnTo="/admin/ingestion" />
      </div>
      <h2>Runs</h2>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Source</th>
              <th scope="col">Trigger</th>
              <th scope="col" className="num">Fetched</th>
              <th scope="col" className="num">Normalized</th>
              <th scope="col" className="num">Duplicates</th>
              <th scope="col" className="num">Unchanged</th>
              <th scope="col" className="num">Failed</th>
              <th scope="col" className="num">Queued</th>
              <th scope="col">Status</th>
              <th scope="col">Failure reasons</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td data-label="Started">{when(r.startedAt)}</td>
                <td data-label="Source">{r.source}</td>
                <td data-label="Trigger">{r.trigger}</td>
                <td data-label="Fetched" className="num">{r.totalFetched}</td>
                <td data-label="Normalized" className="num">{r.normalizedCount}</td>
                <td data-label="Duplicates" className="num">{r.duplicateCount}</td>
                <td data-label="Unchanged" className="num">{r.unchangedCount}</td>
                <td data-label="Failed" className="num">{r.failedNormalizationCount + r.failureCount}</td>
                <td data-label="Queued" className="num">{r.queuedCount}</td>
                <td data-label="Status">
                  <Badge value={r.status} />
                </td>
                <td data-label="Failure reasons" className="small">
                  {r.failureReasonSummary ? Object.entries(r.failureReasonSummary as Record<string, unknown>).map(([k, v]) => `${k}: ${String(v)}`).join("; ") : "—"}
                </td>
              </tr>
            ))}
            {!runs.length && (
              <tr>
                <td colSpan={11}>No ingestion runs yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2>Content items</h2>
      <nav aria-label="Status filter">
        <ul className="chips">
          <li>
            <Link className="chip neutral" href="/admin/ingestion" aria-current={!status ? "true" : undefined}>
              All
            </Link>
          </li>
          {STATUSES.map((s) => (
            <li key={s}>
              <Link className="chip neutral" href={`/admin/ingestion?status=${s}`} aria-current={status === s ? "true" : undefined}>
                {s} ({count(s)})
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Source item</th>
              <th scope="col">Status</th>
              <th scope="col">Reason</th>
              <th scope="col">Fetched</th>
              <th scope="col">Review</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td data-label="Source item" style={{ wordBreak: "break-all" }}>
                  {i.source}/{i.sourceId}
                  {i.dedupeKey && <div className="small muted">{i.dedupeKey}</div>}
                </td>
                <td data-label="Status">
                  <Badge value={i.processingStatus} />
                </td>
                <td data-label="Reason" className="small">
                  {i.errorCode && <Badge value={i.errorCode} tone="warn" />} {i.statusReason ?? ""}
                </td>
                <td data-label="Fetched">{when(i.fetchedAt)}</td>
                <td data-label="Review">{i.normalizedReviewId ? <Link href={`/admin/reviews/${i.normalizedReviewId}`}>open</Link> : "—"}</td>
              </tr>
            ))}
            {!items.length && (
              <tr>
                <td colSpan={5}>No content items.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={page} pages={Math.ceil(itemsTotal / 50)} base={`/admin/ingestion${status ? `?status=${status}` : ""}`} />
    </>
  );
}
