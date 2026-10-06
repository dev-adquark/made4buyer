import Link from "next/link";
import { BarList, Meter } from "@/components/charts";
import Flash from "@/components/flash";
import { ActionForm, Badge, pct, Stat } from "@/components/admin-ui";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { integrationStatus } from "@/lib/config";
import { db } from "@/lib/db";
import { successMetrics, reviewsWithVerifiedDeal } from "@/lib/analytics/metrics";
import { categoryName } from "@/lib/taxonomy/definitions";
import SovrnStatusNotice from "@/components/sovrn-status-notice";

export const dynamic = "force-dynamic";
export const metadata = { title: "Overview" };

export default async function Overview({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const [contentByStatus, reviewsByStatus, published, withDeal, linkGroups, images, fallbackImages, categories, metrics, lastRun] = await Promise.all([
    db.contentItem.groupBy({ by: ["processingStatus"], _count: { _all: true } }),
    db.normalizedReview.groupBy({ by: ["status"], _count: { _all: true } }),
    db.normalizedReview.count({ where: { status: "PUBLISHED" } }),
    reviewsWithVerifiedDeal({ status: "PUBLISHED" }),
    db.affiliateLink.groupBy({ by: ["verificationStatus"], where: { isActive: true }, _count: { _all: true } }),
    db.imageAsset.count({ where: { isPrimary: true } }),
    db.imageAsset.count({ where: { isPrimary: true, isFallback: true } }),
    db.normalizedReview.groupBy({ by: ["categorySlug"], _count: { _all: true }, orderBy: { _count: { categorySlug: "desc" } } }),
    successMetrics(),
    db.ingestionRun.findFirst({ orderBy: { startedAt: "desc" } }),
  ]);
  const day = new Date(Date.now() - 86_400_000);
  const week = new Date(Date.now() - 7 * 86_400_000);
  const [publishedToday, freshToday, heldWeek, ktbWeek, apifyDay, failedRuns, withCoupon, sources] = await Promise.all([
    db.normalizedReview.count({ where: { status: "PUBLISHED", publishedAt: { gte: day } } }),
    db.contentItem.count({ where: { freshnessStatus: "FRESH", freshnessCheckedAt: { gte: day } } }),
    db.contentItem.count({ where: { freshnessStatus: { in: ["STALE", "UNKNOWN", "INVALID_DATE"] }, freshnessCheckedAt: { gte: week } } }),
    db.automationSlot.groupBy({ by: ["status"], where: { updatedAt: { gte: week } }, _count: { _all: true } }),
    db.apifyRun.groupBy({ by: ["status"], where: { startedAt: { gte: day } }, _count: { _all: true } }),
    Promise.all([db.revalidationRun.count({ where: { startedAt: { gte: day }, status: { in: ["FAILED", "COMPLETED_WITH_ERRORS"] } } }), db.ingestionRun.count({ where: { startedAt: { gte: day }, status: "FAILED" } })]).then(([a, b]) => a + b),
    db.normalizedReview.count({ where: { status: "PUBLISHED", coupons: { some: { isActive: true, verified: true } } } }),
    db.reviewSource.findMany({ where: { enabled: true }, select: { pausedUntil: true, consecutiveStale: true, consecutiveFailures: true } }),
  ]);
  const ktb = (st: string) => ktbWeek.find((r) => r.status === st)?._count._all ?? 0;
  const apifyTotal = apifyDay.reduce((n, r) => n + r._count._all, 0);
  const apifyFailed = apifyDay.filter((r) => ["FAILED", "ABORTED", "TIMED-OUT", "COLLECT_FAILED"].includes(r.status)).reduce((n, r) => n + r._count._all, 0);
  const pausedSources = sources.filter((x) => x.pausedUntil && x.pausedUntil > new Date()).length;
  const degradedSources = sources.filter((x) => !(x.pausedUntil && x.pausedUntil > new Date()) && (x.consecutiveStale || x.consecutiveFailures)).length;
  const content = (s: string) => contentByStatus.find((c) => c.processingStatus === s)?._count._all ?? 0;
  const reviews = (s: string) => reviewsByStatus.find((c) => c.status === s)?._count._all ?? 0;
  const totalContent = contentByStatus.reduce((n, c) => n + c._count._all, 0);
  const linksTotal = linkGroups.reduce((n, g) => n + g._count._all, 0);
  const linksOk = linkGroups.find((g) => g.verificationStatus === "VERIFIED_OK")?._count._all ?? 0;
  const integrations = integrationStatus();

  return (
    <>
      <h1>Overview</h1>
      <SovrnStatusNotice />
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <div className="btnrow">
        <ActionForm action="/api/admin/jobs" fields={{ job: "ingest" }} label="Run ingestion now" returnTo="/admin" className="btn primary" disabledReason={integrations.contentApi !== "READY" ? "CONTENT_API_URL not configured (BLOCKED_BY_ENVIRONMENT)" : undefined} />
        <ActionForm action="/api/admin/jobs" fields={{ job: "verify-links" }} label="Verify due links" returnTo="/admin" />
        <ActionForm action="/api/admin/jobs" fields={{ job: "revalidate-offers" }} label="Refresh stale offers" returnTo="/admin" disabledReason={integrations.sovrn === "READY" ? undefined : "Sovrn not configured"} />
        <Link className="btn" href="/admin/automation">
          Automation control centre
        </Link>
      </div>
      <h2>Autonomous engine</h2>
      <div className="stats">
        <Stat label="Published (24 h)" value={publishedToday} note="all pipelines, no approval step" />
        <Stat label="Fresh external items (24 h)" value={freshToday} />
        <Stat label="Held: stale / undated (7 d)" value={heldWeek} note="never published automatically" />
        <Stat label="Keyword-to-Blog slots (7 d)" value={`${ktb("PUBLISHED")} published`} note={`${ktb("BLOCKED")} blocked, ${ktb("FAILED") + ktb("RETRYING")} failed/retrying`} />
        <Stat label="Apify runs (24 h)" value={apifyTotal} note={`${apifyFailed} failed`} />
        <Stat label="Failed job runs (24 h)" value={failedRuns} />
        <Stat label="Coupon coverage" value={pct(published ? withCoupon / published : null)} note={`${withCoupon}/${published} published with a verified Sovrn code`} />
        <Stat label="Sources" value={`${sources.length - pausedSources - degradedSources} healthy`} note={`${degradedSources} degraded, ${pausedSources} paused`} />
      </div>
      <div className="stats">
        <Stat label="Content items ingested" value={totalContent} note={lastRun ? `last run ${lastRun.status}` : "no runs yet"} />
        <Stat label="Published reviews" value={published} />
        <Stat label="Held by a rule" value={reviews("NEEDS_REVIEW")} note="stale, undated or incomplete; rechecked automatically" />
        <Stat label="Failed items" value={content("FAILED")} />
        <Stat label="Duplicates" value={content("DUPLICATE")} />
        <Stat label="Deal coverage" value={pct(published ? withDeal / published : null)} note={`${withDeal}/${published} published with verified deal`} />
        <Stat label="Link health" value={pct(linksTotal ? linksOk / linksTotal : null)} note={`${linksOk}/${linksTotal} active links verified`} />
        <Stat label="Image coverage" value={pct(images ? (images - fallbackImages) / images : null)} note={`${fallbackImages} fallback placeholders`} />
      </div>

      <div className="chart-grid">
        <section className="chart-card" aria-labelledby="ch-coverage">
          <h2 id="ch-coverage">Coverage</h2>
          <p className="small muted">Share of published reviews / primary images.</p>
          <Meter label="Verified deal coverage" value={published ? withDeal / published : null} note={`${withDeal} of ${published} published reviews have a verified offer (target ≥ 90%)`} />
          <div style={{ height: 12 }} />
          <Meter label="Image coverage (non-fallback)" value={images ? (images - fallbackImages) / images : null} note={`${images - fallbackImages} of ${images} primary images are real product images`} />
        </section>
        <section className="chart-card" aria-labelledby="ch-links">
          <h2 id="ch-links">Link health</h2>
          <p className="small muted">Active affiliate links by verification status.</p>
          <BarList
            label="Active links by status"
            data={linkGroups
              .map((g) => ({ label: g.verificationStatus, value: g._count._all, tone: (g.verificationStatus === "VERIFIED_OK" ? "ok" : g.verificationStatus === "PENDING" ? "neutral" : ["TIMEOUT", "PROVIDER_ERROR"].includes(g.verificationStatus) ? "warn" : "error") as "ok" | "warn" | "error" | "neutral" }))
              .sort((a, b) => b.value - a.value)}
          />
        </section>
        <section className="chart-card" aria-labelledby="ch-cats">
          <h2 id="ch-cats">Reviews by category</h2>
          <p className="small muted">All non-deleted reviews, any status.</p>
          <BarList label="Reviews by category" data={categories.map((c) => ({ label: c.categorySlug ? categoryName(c.categorySlug) ?? c.categorySlug : "No category", value: c._count._all }))} />
        </section>
      </div>

      <h2>Integrations</h2>
      <div className="table-wrap">
        <table className="table">
          <caption className="visually-hidden">Integration status</caption>
          <thead>
            <tr>
              <th scope="col">Integration</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(integrations).map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td>
                  <Badge value={v} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Success metrics (30 days)</h2>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Metric</th>
              <th scope="col">Formula</th>
              <th scope="col" className="num">Value</th>
              <th scope="col">Target</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m.key}>
                <td data-label="Metric">{m.label}</td>
                <td data-label="Formula" className="small muted">
                  {m.formula} ({m.numerator}/{m.denominator})
                </td>
                <td data-label="Value" className="num">
                  {pct(m.value)}
                </td>
                <td data-label="Target">
                  {m.comparator} {(m.target * 100).toFixed(0)}%
                </td>
                <td data-label="Status">
                  <Badge value={m.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Category distribution</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col" className="num">Reviews</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c.categorySlug ?? "none"}>
                <td>{c.categorySlug ? categoryName(c.categorySlug) : <Badge value="NO CATEGORY" tone="warn" />}</td>
                <td className="num">{c._count._all}</td>
              </tr>
            ))}
            {!categories.length && (
              <tr>
                <td colSpan={2}>No reviews yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
