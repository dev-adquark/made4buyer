import Link from "next/link";
import { Badge, when } from "@/components/admin-ui";
import { requireAdminPage } from "@/lib/admin/guard";
import { businessTimezone, formatInZone } from "@/lib/ops/cron-schedule";
import { loadRecentFailures, loadScheduleRows, type RateView } from "@/lib/ops/schedules";

export const dynamic = "force-dynamic";
export const metadata = { title: "Schedules" };

const STATUS_TONE: Record<string, "ok" | "warn" | "error" | "info" | "neutral"> = {
  SUCCEEDED: "ok",
  SKIPPED: "neutral",
  PAUSED: "warn",
  LOCK_HELD: "warn",
  FAILED: "error",
  RUNNING: "info",
};

function rateText(r: RateView): string {
  if (r.rate === null) return r.other ? `— (${r.other} skipped/paused)` : "—";
  return `${Math.round(r.rate * 100)}% (${r.succeeded}/${r.succeeded + r.failed})${r.other ? ` +${r.other} skipped/paused` : ""}`;
}

function duration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 120_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

export default async function SchedulesPage() {
  await requireAdminPage();
  const now = new Date();
  const tz = businessTimezone();
  const [rows, failures] = await Promise.all([loadScheduleRows(now), loadRecentFailures(60)]);
  const scheduled = rows.filter((r) => r.schedules.length).sort((a, b) => (a.next?.getTime() ?? Infinity) - (b.next?.getTime() ?? Infinity));
  const unscheduled = rows.filter((r) => !r.schedules.length);
  return (
    <>
      <h1>Schedules</h1>
      <p className="muted">
        Cron runs in UTC (Vercel Cron from vercel.json; GitHub Actions from .github/workflows/scheduled-jobs.yml, which only runs when its SITE_URL and CRON_SECRET repository secrets are set). Times are also shown in the business timezone <strong>{tz}</strong> (BUSINESS_TIMEZONE). Last run, status, duration, success rate and failures come from the job run records written for every execution; success rate counts succeeded ÷ (succeeded + failed) and lists skipped, paused and overlapping runs separately. Vercel Hobby cron may fire any time within the scheduled hour.
      </p>
      <p className="small muted">Now: {when(now)} · {formatInZone(now, tz)} {tz}</p>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Job</th>
              <th scope="col">Schedule (UTC)</th>
              <th scope="col">Last run</th>
              <th scope="col">Next run</th>
              <th scope="col">Duration</th>
              <th scope="col">Success rate</th>
              <th scope="col">Failures (7 d)</th>
              <th scope="col">Lock</th>
              <th scope="col">Switch</th>
            </tr>
          </thead>
          <tbody>
            {[...scheduled, ...unscheduled].map((r) => (
              <tr key={r.job}>
                <td data-label="Job">
                  <code>{r.job}</code>
                  {!r.registered && <div className="small error">Not a registered job: the endpoint returns 404</div>}
                </td>
                <td data-label="Schedule (UTC)" className="small">
                  {r.schedules.length ? (
                    r.schedules.map((s, i) => (
                      <div key={i} style={{ marginBottom: 4 }}>
                        <code>{s.cron}</code> {s.query && <code>?{s.query}</code>} <Badge value={s.origin === "vercel" ? "Vercel" : "GitHub Actions"} tone={s.origin === "vercel" ? "info" : "neutral"} />
                        <div className="muted">{s.english}</div>
                      </div>
                    ))
                  ) : (
                    <span className="muted">Not scheduled (manual “Run now” in Jobs &amp; runs)</span>
                  )}
                </td>
                <td data-label="Last run" className="small">
                  {r.lastRun ? (
                    <>
                      <Badge value={r.lastRun.status} tone={STATUS_TONE[r.lastRun.status]} /> {when(r.lastRun.startedAt)}
                      <div className="muted">
                        {formatInZone(r.lastRun.startedAt, tz)} {tz} · {r.lastRun.trigger}
                        {r.lastRun.outcome && r.lastRun.outcome !== "OK" ? ` · ${r.lastRun.outcome}` : ""}
                      </div>
                      {r.lastRun.status === "RUNNING" && !r.lastRun.finishedAt && <div className="muted">No finish recorded yet</div>}
                      {(r.lastRun.reason || r.lastRun.error) && <div className="muted">{r.lastRun.error ?? r.lastRun.reason}</div>}
                    </>
                  ) : r.lastAudit ? (
                    <>
                      <Badge value={r.lastAudit.status} /> {when(r.lastAudit.at)}
                      <div className="muted">From the audit log (before run recording) · {r.lastAudit.actor}</div>
                    </>
                  ) : (
                    "No runs recorded"
                  )}
                </td>
                <td data-label="Next run" className="small">
                  {r.next ? (
                    <>
                      {when(r.next)}
                      <div className="muted">
                        {formatInZone(r.next, tz)} {tz}
                        {r.schedules.length > 1 && r.nextVia ? ` · via ${r.nextVia.origin === "vercel" ? "Vercel" : "GitHub Actions"}` : ""}
                      </div>
                      {r.paused && <div className="muted">Will return PAUSED (switch off)</div>}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td data-label="Duration" className="small">{r.lastRun ? duration(r.lastRun.durationMs) : "—"}</td>
                <td data-label="Success rate" className="small">
                  {r.last30.succeeded + r.last30.failed + r.last30.other ? (
                    <>
                      <div>Last 30: {rateText(r.last30)}</div>
                      <div className="muted">7 days: {rateText(r.last7d)}</div>
                    </>
                  ) : (
                    "No runs recorded"
                  )}
                </td>
                <td data-label="Failures (7 d)" className="small">
                  {r.failures7d ? <Badge value={String(r.failures7d)} tone="error" /> : "0"}
                  {r.lastFailure && (
                    <div className="muted">
                      Last: {when(r.lastFailure.startedAt)} — {r.lastFailure.error ?? r.lastFailure.reason ?? r.lastFailure.outcome ?? "no message recorded"}
                    </div>
                  )}
                </td>
                <td data-label="Lock" className="small">
                  {r.lock.state === "free" ? "free" : <Badge value={r.lock.state === "held" ? `held until ${when(r.lock.until)}` : "stale (will be recovered)"} tone="warn" />}
                </td>
                <td data-label="Switch" className="small">
                  {r.paused ? <Badge value="PAUSED" tone="warn" /> : <Badge value="ON" tone="ok" />}
                  {r.switches
                    .filter((s) => !s.on)
                    .map((s) => (
                      <div key={s.key} className="muted">
                        {s.label} is off
                      </div>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Switches: <Link href="/admin/automation">Automation</Link>. Manual runs: <Link href="/admin/jobs">Jobs &amp; runs</Link> (manual runs ignore switches).
      </p>

      <h2 id="failures">Recent failures</h2>
      <p className="muted small">
        Newest first, from job runs (FAILED), open pipeline failures, commerce runs (FAILED, ABORTED, TIMED-OUT, COLLECT_FAILED, START_FAILED), daily-article slots (BLOCKED, RETRYING) and Apify review-source runs (FAILED, ABORTED, TIMED-OUT, COLLECT_FAILED). Attempts: pipeline retry count, slot attempts, or the brand/source&apos;s consecutive failures for commerce runs.
      </p>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Record</th>
              <th scope="col">Job / stage</th>
              <th scope="col">Subject</th>
              <th scope="col">Error</th>
              <th scope="col" className="num">Attempts</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {failures.map((f, i) => (
              <tr key={i}>
                <td data-label="When" className="small">{when(f.at)}</td>
                <td data-label="Record" className="small">{f.href ? <Link href={f.href}>{f.origin}</Link> : f.origin}</td>
                <td data-label="Job / stage" className="small">
                  <code>{f.job}</code>
                </td>
                <td data-label="Subject" className="small">{f.subject ?? "—"}</td>
                <td data-label="Error" className="small">{f.error.slice(0, 300)}</td>
                <td data-label="Attempts" className="num">{f.retries ?? "—"}</td>
                <td data-label="Status">
                  <Badge value={f.status} tone="error" />
                </td>
              </tr>
            ))}
            {!failures.length && (
              <tr>
                <td colSpan={7}>No failures recorded.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
