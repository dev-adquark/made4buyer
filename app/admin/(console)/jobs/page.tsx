import Flash from "@/components/flash";
import { ActionForm, Badge, when } from "@/components/admin-ui";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { integrationStatus } from "@/lib/config";
import { db } from "@/lib/db";
import { JOBS } from "@/lib/jobs/registry";

export const dynamic = "force-dynamic";
export const metadata = { title: "Jobs & runs" };

const DESCRIPTIONS: Record<keyof typeof JOBS, string> = {
  ingest: "Fetch the Content API, snapshot raw items, normalize, dedupe and run all review stages.",
  "verify-links": "Re-verify affiliate links that are due (or pending).",
  "revalidate-offers": "Re-query Sovrn for reviews with stale or failed deal data.",
  "retry-failed": "Retry due retryable failures with bounded attempts.",
  "cleanup-cache": "Delete expired Sovrn cache rows, sessions, rate-limit buckets and stale locks.",
  "publish-cycle": "Publish QA-passing queued reviews (only when AUTO_PUBLISH_ENABLED=true).",
  "inspect-index": "Inspect published URLs with the Search Console URL Inspection API.",
};

export default async function JobsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const [locks, runs] = await Promise.all([db.jobLock.findMany(), db.revalidationRun.findMany({ orderBy: { startedAt: "desc" }, take: 30 })]);
  const integrations = integrationStatus();
  const blocked: Partial<Record<keyof typeof JOBS, string | undefined>> = {
    ingest: integrations.contentApi !== "READY" ? "CONTENT_API_URL not configured" : undefined,
    "revalidate-offers": integrations.sovrn !== "READY" ? "Sovrn not configured" : undefined,
    "inspect-index": integrations.gsc !== "READY" ? "Search Console not configured" : undefined,
  };
  return (
    <>
      <h1>Jobs &amp; runs</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p className="muted">Scheduled via Vercel Cron at /api/cron/&lt;job&gt; (Bearer CRON_SECRET — {integrations.cron}). Every job holds a DB lock; stale locks expire automatically.</p>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Job</th>
              <th scope="col">What it does</th>
              <th scope="col">Lock</th>
              <th scope="col">Run</th>
            </tr>
          </thead>
          <tbody>
            {(Object.keys(JOBS) as Array<keyof typeof JOBS>).map((name) => {
              const lock = locks.find((l) => l.name === (name === "ingest" ? "ingestion" : `job:${name}`));
              return (
                <tr key={name}>
                  <td data-label="Job">
                    <code>{name}</code>
                  </td>
                  <td data-label="What it does" className="small">{DESCRIPTIONS[name]}</td>
                  <td data-label="Lock">{lock ? <Badge value={lock.expiresAt > new Date() ? `held until ${when(lock.expiresAt)}` : "stale (will be recovered)"} tone="warn" /> : "free"}</td>
                  <td data-label="Run">
                    <ActionForm action="/api/admin/jobs" fields={{ job: name }} label="Run now" returnTo="/admin/jobs" disabledReason={blocked[name]} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <h2>Recent runs</h2>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Type</th>
              <th scope="col">Trigger</th>
              <th scope="col" className="num">Checked</th>
              <th scope="col" className="num">OK</th>
              <th scope="col" className="num">Failed</th>
              <th scope="col">Reasons</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td data-label="Started">{when(r.startedAt)}</td>
                <td data-label="Type">{r.type}</td>
                <td data-label="Trigger">{r.trigger}</td>
                <td data-label="Checked" className="num">{r.checkedCount}</td>
                <td data-label="OK" className="num">{r.successCount}</td>
                <td data-label="Failed" className="num">{r.failureCount}</td>
                <td data-label="Reasons" className="small">
                  {r.reasonBreakdown ? Object.entries(r.reasonBreakdown as Record<string, number>).map(([k, v]) => `${k}: ${v}`).join(", ") : "—"}
                  {r.errorMessage && <div className="muted">{r.errorMessage}</div>}
                </td>
                <td data-label="Status">
                  <Badge value={r.status} />
                </td>
              </tr>
            ))}
            {!runs.length && (
              <tr>
                <td colSpan={8}>No runs yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
