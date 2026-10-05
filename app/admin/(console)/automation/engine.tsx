import { Badge, Stat, when } from "@/components/admin-ui";
import { db } from "@/lib/db";
import { freshnessMaxDays } from "@/lib/pipeline/freshness";

const DAY_MS = 86_400_000;

/** External-content freshness, source health and the run timeline (Admin → Automation). */
export default async function EngineSections({ now }: { now: Date }) {
  const since7 = new Date(now.getTime() - 7 * DAY_MS);
  const since1 = new Date(now.getTime() - DAY_MS);
  const checked = { freshnessCheckedAt: { gte: since7 } };
  const [byStatus, freshToday, bySource, sources, ingests, apify, jobs, slots, autoPublished] = await Promise.all([
    db.contentItem.groupBy({ by: ["freshnessStatus"], where: checked, _count: { _all: true } }),
    db.contentItem.count({ where: { freshnessStatus: "FRESH", freshnessCheckedAt: { gte: since1 } } }),
    db.contentItem.groupBy({ by: ["source", "freshnessStatus"], where: checked, _count: { _all: true } }),
    db.reviewSource.findMany({ orderBy: [{ enabled: "desc" }, { priority: "desc" }, { name: "asc" }] }),
    db.ingestionRun.findMany({ orderBy: { startedAt: "desc" }, take: 10, select: { id: true, source: true, trigger: true, status: true, startedAt: true, normalizedCount: true, failureCount: true } }),
    db.apifyRun.findMany({ orderBy: { startedAt: "desc" }, take: 10, select: { id: true, status: true, startedAt: true, itemCount: true, accepted: true, freshCount: true, staleCount: true, source: { select: { name: true } } } }),
    db.revalidationRun.findMany({ orderBy: { startedAt: "desc" }, take: 10, select: { id: true, type: true, trigger: true, status: true, startedAt: true, successCount: true, failureCount: true } }),
    db.automationSlot.findMany({ orderBy: { updatedAt: "desc" }, take: 6, select: { id: true, day: true, slot: true, status: true, updatedAt: true, lastError: true } }),
    db.normalizedReview.count({ where: { status: "PUBLISHED", publishedAt: { gte: since7 } } }),
  ]);
  const n = (s: string) => byStatus.find((r) => r.freshnessStatus === s)?._count._all ?? 0;
  const sourceKeyOf = (slug: string) => `apify:${slug}`;
  const srcCount = (key: string, s: string) => bySource.find((r) => r.source === key && r.freshnessStatus === s)?._count._all ?? 0;

  const timeline = [
    ...ingests.map((r) => ({ id: `i${r.id}`, at: r.startedAt, what: `Ingestion (${r.source})`, status: r.status, detail: `${r.normalizedCount} new, ${r.failureCount} failures · ${r.trigger}` })),
    ...apify.map((r) => ({ id: `a${r.id}`, at: r.startedAt, what: `Crawl: ${r.source.name}`, status: r.status, detail: r.itemCount != null ? `${r.itemCount} pages, ${r.accepted ?? 0} accepted, ${r.freshCount ?? 0} fresh, ${r.staleCount ?? 0} stale` : "in progress" })),
    ...jobs.map((r) => ({ id: `j${r.id}`, at: r.startedAt, what: `Job: ${r.type.toLowerCase().replace(/_/g, " ")}`, status: r.status, detail: `${r.successCount} ok, ${r.failureCount} failed · ${r.trigger}` })),
    ...slots.map((r) => ({ id: `s${r.id}`, at: r.updatedAt, what: `Daily ${r.slot.toLowerCase()} post (${r.day})`, status: r.status, detail: r.lastError ?? "" })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 25);

  return (
    <>
      <h2>External content freshness</h2>
      <p className="small muted">
        Crawled and Content API items are published automatically only when the source&apos;s own published or updated date is at most {freshnessMaxDays()} days old. Crawl and ingest dates never count. Keyword-to-Blog posts are exempt. Last 7 days of checks:
      </p>
      <div className="stats">
        <Stat label="Fresh today" value={freshToday} />
        <Stat label="Fresh (7 days)" value={n("FRESH")} />
        <Stat label="Stale, held" value={n("STALE")} />
        <Stat label="No source date, held" value={n("UNKNOWN")} />
        <Stat label="Invalid date, held" value={n("INVALID_DATE")} />
        <Stat label="Published automatically (7 days)" value={autoPublished} note="all pipelines" />
      </div>

      <h2>Source health</h2>
      <p className="small muted">A source with three runs in a row that bring nothing fresh, or three failures, is lowered and paused with backoff (1, 2, 4 … days, at most 7). It is retried automatically and restored on its first fresh result. Sources are never disabled or deleted automatically.</p>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">State</th>
              <th scope="col">Priority</th>
              <th scope="col">Last run</th>
              <th scope="col">Last fresh</th>
              <th scope="col">Fresh share (7 days)</th>
              <th scope="col">Note</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => {
              const paused = s.pausedUntil && s.pausedUntil > now;
              const fresh = srcCount(sourceKeyOf(s.slug), "FRESH");
              const total = fresh + srcCount(sourceKeyOf(s.slug), "STALE") + srcCount(sourceKeyOf(s.slug), "UNKNOWN") + srcCount(sourceKeyOf(s.slug), "INVALID_DATE");
              return (
                <tr key={s.id}>
                  <td data-label="Source">{s.name}</td>
                  <td data-label="State">
                    <Badge value={!s.enabled ? "DISABLED" : paused ? "PAUSED" : s.consecutiveStale || s.consecutiveFailures ? "DEGRADED" : "HEALTHY"} tone={!s.enabled ? "neutral" : paused ? "warn" : s.consecutiveStale || s.consecutiveFailures ? "warn" : "ok"} />
                  </td>
                  <td data-label="Priority">{s.priority}</td>
                  <td data-label="Last run">{when(s.lastRunAt)}</td>
                  <td data-label="Last fresh">{when(s.lastFreshAt)}</td>
                  <td data-label="Fresh share">{total ? `${Math.round((fresh / total) * 100)}% of ${total}` : "—"}</td>
                  <td data-label="Note" className="small">{s.healthNote ?? (s.enabled ? "" : "Disabled by the owner")}</td>
                </tr>
              );
            })}
            {!sources.length && (
              <tr>
                <td colSpan={7}>No sources configured.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2>Run timeline</h2>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Run</th>
              <th scope="col">Status</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {timeline.map((t) => (
              <tr key={t.id}>
                <td data-label="When">{when(t.at)}</td>
                <td data-label="Run">{t.what}</td>
                <td data-label="Status">
                  <Badge value={t.status} />
                </td>
                <td data-label="Detail" className="small">{t.detail}</td>
              </tr>
            ))}
            {!timeline.length && (
              <tr>
                <td colSpan={4}>No runs yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
