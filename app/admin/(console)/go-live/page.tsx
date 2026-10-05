import { Badge, when } from "@/components/admin-ui";
import { requireAdminPage } from "@/lib/admin/guard";
import { db } from "@/lib/db";
import type { LiveCheckResult } from "@/lib/ops/live-check";

export const dynamic = "force-dynamic";
export const metadata = { title: "Go-live checks" };

const TONE: Record<string, "ok" | "warn" | "error"> = { OK: "ok", EMPTY: "warn", BLOCKED_BY_ENVIRONMENT: "warn" };

const STEPS = [
  "Run these checks. Every configured integration must be OK (EMPTY means the provider answered with nothing for that product).",
  "Publishing is automatic: fresh, QA-passing content goes live with no approval step. Pause it any time in Admin → Automation.",
  "Open a few recently published pages after the first runs.",
  "Check Link health and Deals: every shown offer must be VERIFIED_OK.",
  "Watch Admin → Automation for freshness, source health and the run timeline.",
];

export default async function GoLivePage() {
  await requireAdminPage();
  const last = await db.auditLog.findFirst({ where: { action: "integrations.live_check" }, orderBy: { createdAt: "desc" } });
  const report = last?.metadata as { checkedAt: string; results: LiveCheckResult[] } | null;
  return (
    <>
      <h1>Go-live checks</h1>
      <p className="muted">
        One read-only request to each real provider, using this deployment’s credentials. Nothing is written to the database or cached, no affiliate link is followed, and no secret value is shown.
      </p>
      <form className="toolbar" action="/api/admin/live-check" method="post">
        <input type="hidden" name="returnTo" value="/admin/go-live" />
        <div className="field">
          <label htmlFor="lc-product">Product to test offers and images with</label>
          <input id="lc-product" name="product" maxLength={120} placeholder="Defaults to the first valid Content API item" />
        </div>
        <div className="field">
          <label htmlFor="lc-brand">Brand (optional)</label>
          <input id="lc-brand" name="brand" maxLength={60} />
        </div>
        <button className="btn primary" type="submit">
          Run checks
        </button>
      </form>
      {report ? (
        <>
          <h2>
            Last run {when(report.checkedAt)} by {last!.actor}
          </h2>
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  <th>Integration</th>
                  <th>Status</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {report.results.map((r) => (
                  <tr key={r.integration}>
                    <td data-label="Integration">{r.integration}</td>
                    <td data-label="Status">
                      <Badge value={r.status} tone={TONE[r.status] ?? "error"} />
                    </td>
                    <td data-label="Details">
                      <pre className="code" style={{ margin: 0, maxHeight: 260 }}>
                        {JSON.stringify(r.detail, null, 2)}
                      </pre>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="notice">No checks have been run yet.</p>
      )}
      <h2>Go-live order</h2>
      <ol>
        {STEPS.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
    </>
  );
}
