import { ActionForm, Badge, Stat, when } from "@/components/admin-ui";
import { type SweepCounters, type SweepError, weeklyRefreshStatus } from "@/lib/commerce/weekly-refresh";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function Counters({ c, id }: { c: SweepCounters; id: string }) {
  return (
    <div className="stats" aria-labelledby={id}>
      <Stat label="Brands processed" value={c.brandsProcessed} note={`${c.brandsTargeted} targeted · ${c.runsStarted} runs started · ${c.runsSkipped} skipped · ${c.runsFailed} failed`} />
      <Stat label="Records" value={`${c.recordsDiscovered} discovered`} note={`${c.recordsAccepted} accepted · ${c.recordsRejected} rejected · ${c.offersUpdated} offers updated`} />
      <Stat label="Deals" value={`+${c.dealsCreated} created`} note={`${c.dealsExpired} expired · ${c.dealsHidden} hidden · ${c.dealsNow || c.dealsAtStart} live`} />
      <Stat label="Coupons" value={`${c.couponsVerified} verified`} note={`${c.couponsExpired} expired · ${c.couponRunsStarted} promo-page runs`} />
      <Stat label="Links" value={`${c.linksFailed} failed`} note={`${c.linksChecked} checked`} />
      <Stat label="Verification" value={`${c.verificationFailures} failures`} note={`${c.verificationChecked} products checked · audit: ${c.auditFlagged} flagged, ${c.auditFixed} fixed`} />
      <Stat label="Errors" value={`${c.apiErrors} API errors`} note={`${c.retries} retries${c.durationMs ? ` · ${duration(c.durationMs)}` : ""}`} />
    </div>
  );
}

function Errors({ errors }: { errors: SweepError[] }) {
  if (!errors.length) return null;
  return (
    <details>
      <summary className="small">
        {errors.length} recorded issue{errors.length === 1 ? "" : "s"} (the sweep continued)
      </summary>
      <ul className="small">
        {errors.slice(-10).map((e, i) => (
          <li key={`${e.at}-${i}`}>
            <code>{e.stage}</code>
            {e.target ? <> · {e.target}</> : null}
            {e.code ? <> · {e.code}</> : null}: {e.reason}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Admin → Commerce: the weekly deals refresh (job "deals-weekly-refresh"). Shows the configured slot
 * (UTC), the sweep in progress, the last completed sweep with its counters, and lets an admin change
 * the slot or run/continue a sweep now. Posts to /api/admin/commerce/weekly (audited).
 */
export default async function WeeklyRefreshPanel({ returnTo = "/admin/commerce" }: { returnTo?: string }) {
  const s = await weeklyRefreshStatus();
  const last = s.lastSweep;
  return (
    <section aria-labelledby="weekly-h">
      <h2 id="weekly-h">
        Weekly deals refresh{" "}
        {s.paused ? <Badge value="PAUSED" tone="warn" /> : s.current ? <Badge value="IN PROGRESS" tone="info" /> : s.dueNow ? <Badge value="DUE" tone="info" /> : <Badge value="SCHEDULED" tone="ok" />}
      </h2>
      <p className="small">
        Every <strong>{s.schedule.label}</strong> ({s.schedule.source === "admin" ? "set in Admin" : s.schedule.source === "env" ? "DEALS_WEEKLY_DAY / DEALS_WEEKLY_HOUR_UTC" : "default"}). Next slot: <strong>{when(s.nextSlot)}</strong>
        {s.dueNow && !s.current ? " — this week's sweep has not run yet; the next daily invocation starts it." : "."} Times are {s.timezone}.
      </p>
      {s.paused && <p className="notice warn">The commerce engine (or automation) is paused: scheduled sweeps do not run. “Run now” still runs; Apify runs are still refused while the engine is off.</p>}

      {s.current && (
        <>
          <h3 id="weekly-current-h">Sweep in progress</h3>
          <p className="small">
            {s.current.progress}. Started {when(s.current.startedAt)} ({s.current.trigger}), {s.current.invocations} invocation{s.current.invocations === 1 ? "" : "s"} so far; the daily job and the hourly discovery passes continue it.
          </p>
          <Counters c={s.current.counters} id="weekly-current-h" />
          <Errors errors={s.current.errors} />
        </>
      )}

      <h3 id="weekly-last-h">Last sweep</h3>
      {last ? (
        <>
          <p className="small">
            <Badge value={last.status} tone={last.status === "COMPLETED" ? "ok" : last.status === "INCOMPLETE" ? "error" : "warn"} /> {when(last.startedAt)} → {when(last.finishedAt)} ({last.trigger})
          </p>
          <Counters c={last.counters} id="weekly-last-h" />
          <Errors errors={last.errors} />
        </>
      ) : (
        <p className="small muted">No sweep has completed yet.</p>
      )}

      <form className="toolbar" action="/api/admin/commerce/weekly" method="post">
        <input type="hidden" name="action" value="set-schedule" />
        <input type="hidden" name="returnTo" value={returnTo} />
        <div className="field">
          <label htmlFor="weekly-day">Day</label>
          <select id="weekly-day" name="weekday" defaultValue={String(s.schedule.weekday)}>
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="weekly-hour">Hour (UTC)</label>
          <select id="weekly-hour" name="hourUtc" defaultValue={String(s.schedule.hourUtc)}>
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, "0")}:00
              </option>
            ))}
          </select>
        </div>
        <button className="btn" type="submit">
          Save schedule
        </button>
      </form>
      <div className="btnrow">
        <ActionForm action="/api/admin/commerce/weekly" fields={{ action: "run-now" }} label={s.current ? "Continue sweep now" : "Run sweep now"} returnTo={returnTo} confirm={s.current ? undefined : "Start a full weekly deals refresh now? It uses Apify budget."} />
      </div>
    </section>
  );
}
