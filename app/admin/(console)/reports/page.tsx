import Flash from "@/components/flash";
import { ActionForm, when } from "@/components/admin-ui";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "Day-30 report" };

export default async function ReportsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const reports = await db.day30Report.findMany({ orderBy: { generatedAt: "desc" }, take: 20, select: { id: true, generatedAt: true, generatedBy: true, periodStart: true, periodEnd: true } });
  const selected = param(sp, "id");
  return (
    <>
      <h1>Day-30 success report</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p className="muted">Generates a JSON and HTML report for the last 30 days from persisted data: ingestion, deal coverage, link health, categorization, images, SEO indexing, CTR, success metrics, failure reasons and shipped fixes. Unconfigured integrations are reported as NOT_AVAILABLE_IN_ENVIRONMENT / BLOCKED_BY_ENVIRONMENT.</p>
      <div className="btnrow">
        <ActionForm action="/api/admin/reports" fields={{}} label="Generate report now" returnTo="/admin/reports" className="btn primary" />
      </div>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Generated</th>
              <th scope="col">Period</th>
              <th scope="col">By</th>
              <th scope="col">Download</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((r) => (
              <tr key={r.id} style={r.id === selected ? { background: "var(--accent-soft)" } : undefined}>
                <td data-label="Generated">{when(r.generatedAt)}</td>
                <td data-label="Period">
                  {when(r.periodStart)} → {when(r.periodEnd)}
                </td>
                <td data-label="By">{r.generatedBy}</td>
                <td data-label="Download">
                  <div className="btnrow" style={{ margin: 0 }}>
                    <a className="btn small" href={`/api/admin/reports/${r.id}?format=html`} target="_blank" rel="noopener">
                      HTML
                    </a>
                    <a className="btn small" href={`/api/admin/reports/${r.id}?format=json`}>
                      JSON
                    </a>
                  </div>
                </td>
              </tr>
            ))}
            {!reports.length && (
              <tr>
                <td colSpan={4}>No reports generated yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
