import { Badge, pct, Stat, when } from "@/components/admin-ui";
import { requireAdminPage } from "@/lib/admin/guard";
import { NOT_AVAILABLE_IN_ENVIRONMENT } from "@/lib/config";
import { db } from "@/lib/db";
import { checkGscAccess, gscConfigured, querySearchConsole } from "@/lib/gsc";

export const dynamic = "force-dynamic";
export const metadata = { title: "Search Console" };

export default async function GscPage() {
  await requireAdminPage();
  if (!gscConfigured()) {
    return (
      <>
        <h1>Google Search Console</h1>
        <p className="notice warn">
          {NOT_AVAILABLE_IN_ENVIRONMENT}: Search Console is not connected. No search or indexing numbers are shown until it is, and publishing does not depend on it.
        </p>
        <h2>What the site owner needs to do</h2>
        <ol>
          <li>In Search Console, add and verify the property (URL prefix <code>https://made4buyers.vercel.app/</code> by HTML tag or file, or a domain property by DNS TXT once a custom domain is used).</li>
          <li>In Google Cloud, enable the &ldquo;Google Search Console API&rdquo;, create a service account and download its JSON key.</li>
          <li>In Search Console → Settings → Users and permissions, add the service account&apos;s <code>client_email</code> as a user.</li>
          <li>In Vercel (production), set <code>GSC_SITE_URL</code> to the exact property string and <code>GSC_SERVICE_ACCOUNT_JSON</code> to the whole JSON key (Sensitive), then redeploy.</li>
          <li>Come back here: the access check below runs on every visit.</li>
        </ol>
      </>
    );
  }
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 29);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const access = await checkGscAccess().catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : "access check failed" }));
  let error = "";
  let data: Awaited<ReturnType<typeof querySearchConsole>> | null = null;
  try {
    data = await querySearchConsole(iso(start), iso(end));
  } catch (e) {
    error = e instanceof Error ? e.message : "Search Console unavailable";
  }
  const checks = await db.searchIndexCheck.findMany({ orderBy: { checkedAt: "desc" }, distinct: ["url"], take: 200 });
  const indexed = checks.filter((c) => c.verdict === "INDEXED").length;
  return (
    <>
      <h1>Google Search Console</h1>
      <p className={`notice ${access.ok ? "ok" : "error"}`} role="status">
        Access check: {access.ok ? "connected (the service account can read this property)" : `not working: ${"reason" in access ? access.reason : "unknown"}`}
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {data && (
        <div className="stats">
          <Stat label="Clicks (30d)" value={Math.round(data.clicks)} />
          <Stat label="Impressions (30d)" value={Math.round(data.impressions)} />
          <Stat label="CTR" value={pct(data.ctr)} />
          <Stat label="Avg position" value={data.position.toFixed(1)} />
        </div>
      )}
      <h2>URL inspection</h2>
      <p className="muted">
        {checks.length ? `${indexed}/${checks.length} inspected URLs indexed (${pct(indexed / checks.length)}).` : "No URL inspections yet — run the inspect-index job."}
      </p>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">URL</th>
              <th scope="col">Verdict</th>
              <th scope="col">Coverage</th>
              <th scope="col">Last crawl</th>
              <th scope="col">Checked</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => (
              <tr key={c.id}>
                <td data-label="URL" className="small" style={{ wordBreak: "break-all" }}>{c.url}</td>
                <td data-label="Verdict">
                  <Badge value={c.verdict} tone={c.verdict === "INDEXED" ? "ok" : c.verdict === "ERROR" ? "error" : "warn"} />
                </td>
                <td data-label="Coverage" className="small">{c.coverageState ?? c.error ?? "—"}</td>
                <td data-label="Last crawl">{when(c.lastCrawlTime)}</td>
                <td data-label="Checked">{when(c.checkedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
