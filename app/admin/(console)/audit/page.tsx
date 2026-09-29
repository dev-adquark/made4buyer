import Flash from "@/components/flash";
import { ActionForm, when } from "@/components/admin-ui";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { config } from "@/lib/config";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "Audit log" };

export default async function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const action = (param(sp, "action") ?? "").slice(0, 80);
  const rows = await db.auditLog.findMany({ where: action ? { action: { startsWith: action } } : {}, orderBy: { createdAt: "desc" }, take: 200 });
  return (
    <>
      <h1>Audit log</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <section className="card card-body" aria-labelledby="site-audit-h">
        <h2 id="site-audit-h" style={{ marginTop: 0 }}>
          Live site audit
        </h2>
        <p className="small muted">Checks core routes, the sitemap and every sitemap URL on {config.siteUrl()}. Private/loopback addresses are refused by the SSRF guard, so this runs against deployed environments.</p>
        <ActionForm action="/api/admin/site-audit" fields={{}} label="Run site audit" returnTo="/admin/audit" />
      </section>
      <form className="toolbar" action="/admin/audit">
        <div className="field">
          <label htmlFor="audit-action">Action prefix</label>
          <input id="audit-action" name="action" defaultValue={action} placeholder="e.g. review., csv., category." />
        </div>
        <button className="btn" type="submit">
          Filter
        </button>
      </form>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Actor</th>
              <th scope="col">Action</th>
              <th scope="col">Entity</th>
              <th scope="col">Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td data-label="When">{when(r.createdAt)}</td>
                <td data-label="Actor">{r.actor}</td>
                <td data-label="Action">
                  <code>{r.action}</code>
                </td>
                <td data-label="Entity" className="small" style={{ wordBreak: "break-all" }}>
                  {r.entityType} {r.entityId}
                </td>
                <td data-label="Change">
                  {r.before || r.after || r.metadata ? (
                    <details>
                      <summary className="small">Details</summary>
                      <pre className="code">{JSON.stringify({ before: r.before, after: r.after, metadata: r.metadata }, null, 2).slice(0, 8000)}</pre>
                    </details>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={5}>No audit entries.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
