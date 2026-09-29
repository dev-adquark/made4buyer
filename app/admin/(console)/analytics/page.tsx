import { Badge, pct, Stat } from "@/components/admin-ui";
import { requireAdminPage } from "@/lib/admin/guard";
import { config, integrationStatus } from "@/lib/config";
import { db } from "@/lib/db";
import { ctrByCategory, defaultWindow, trafficSummary } from "@/lib/analytics/metrics";
import { EVENT_NAMES } from "@/lib/analytics/events";
import { categoryName } from "@/lib/taxonomy/definitions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Analytics" };

export default async function AnalyticsPage() {
  await requireAdminPage();
  const w = defaultWindow(30);
  const [events, ctr, traffic, searches] = await Promise.all([
    db.analyticsEvent.groupBy({ by: ["event"], where: { createdAt: { gte: w.start, lte: w.end } }, _count: { _all: true } }),
    ctrByCategory(w),
    trafficSummary(w),
    db.analyticsEvent.findMany({ where: { event: "search", createdAt: { gte: w.start } }, orderBy: { createdAt: "desc" }, take: 20, select: { metadata: true, createdAt: true } }),
  ]);
  const count = (e: string) => events.find((x) => x.event === e)?._count._all ?? 0;
  return (
    <>
      <h1>Analytics (last 30 days)</h1>
      <p className="muted">
        First-party events only. External analytics: {integrationStatus().externalAnalytics}. CTR = affiliate clicks ÷ eligible deal impressions; categories with fewer than {config.analytics.minImpressionsForCtr()} impressions report INSUFFICIENT_DATA.
      </p>
      <div className="stats">
        <Stat label="Sessions" value={traffic.sessions} />
        {EVENT_NAMES.map((e) => (
          <Stat key={e} label={e} value={count(e)} />
        ))}
      </div>
      <h2>Affiliate CTR by category</h2>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col" className="num">Eligible impressions</th>
              <th scope="col" className="num">Clicks</th>
              <th scope="col" className="num">CTR</th>
              <th scope="col">Data</th>
            </tr>
          </thead>
          <tbody>
            {ctr.map((c) => (
              <tr key={c.categorySlug}>
                <td data-label="Category">{categoryName(c.categorySlug) ?? c.categorySlug}</td>
                <td data-label="Eligible impressions" className="num">{c.eligibleImpressions}</td>
                <td data-label="Clicks" className="num">{c.clicks}</td>
                <td data-label="CTR" className="num">{c.ctr === null ? "INSUFFICIENT_DATA" : pct(c.ctr)}</td>
                <td data-label="Data">
                  <Badge value={c.dataSufficiency} />
                </td>
              </tr>
            ))}
            {!ctr.length && (
              <tr>
                <td colSpan={5}>INSUFFICIENT_DATA — no deal impressions recorded yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <h2>Recent searches</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Query</th>
              <th scope="col" className="num">Results</th>
            </tr>
          </thead>
          <tbody>
            {searches.map((s, i) => {
              const m = (s.metadata ?? {}) as { q?: string; results?: number };
              return (
                <tr key={i}>
                  <td>{m.q ?? "—"}</td>
                  <td className="num">{m.results ?? "—"}</td>
                </tr>
              );
            })}
            {!searches.length && (
              <tr>
                <td colSpan={2}>No searches recorded.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
