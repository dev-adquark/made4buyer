import Link from "next/link";
import Flash from "@/components/flash";
import { ActionForm, Badge, pct, Stat } from "@/components/admin-ui";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { integrationStatus } from "@/lib/config";
import { db } from "@/lib/db";
import { successMetrics, reviewsWithVerifiedDeal } from "@/lib/analytics/metrics";
import { categoryName } from "@/lib/taxonomy/definitions";

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
  const content = (s: string) => contentByStatus.find((c) => c.processingStatus === s)?._count._all ?? 0;
  const reviews = (s: string) => reviewsByStatus.find((c) => c.status === s)?._count._all ?? 0;
  const totalContent = contentByStatus.reduce((n, c) => n + c._count._all, 0);
  const linksTotal = linkGroups.reduce((n, g) => n + g._count._all, 0);
  const linksOk = linkGroups.find((g) => g.verificationStatus === "VERIFIED_OK")?._count._all ?? 0;
  const integrations = integrationStatus();

  return (
    <>
      <h1>Overview</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <div className="btnrow">
        <ActionForm action="/api/admin/jobs" fields={{ job: "ingest" }} label="Run ingestion now" returnTo="/admin" className="btn primary" disabledReason={integrations.contentApi !== "READY" ? "CONTENT_API_URL not configured (BLOCKED_BY_ENVIRONMENT)" : undefined} />
        <ActionForm action="/api/admin/jobs" fields={{ job: "verify-links" }} label="Verify due links" returnTo="/admin" />
        <ActionForm action="/api/admin/jobs" fields={{ job: "revalidate-offers" }} label="Refresh stale offers" returnTo="/admin" />
        <Link className="btn" href="/admin/qa?status=QUEUED">
          Review publish queue ({reviews("QUEUED")})
        </Link>
      </div>
      <div className="stats">
        <Stat label="Content items ingested" value={totalContent} note={lastRun ? `last run ${lastRun.status}` : "no runs yet"} />
        <Stat label="Published reviews" value={published} />
        <Stat label="Needs review" value={reviews("NEEDS_REVIEW")} />
        <Stat label="Failed items" value={content("FAILED")} />
        <Stat label="Duplicates" value={content("DUPLICATE")} />
        <Stat label="Deal coverage" value={pct(published ? withDeal / published : null)} note={`${withDeal}/${published} published with verified deal`} />
        <Stat label="Link health" value={pct(linksTotal ? linksOk / linksTotal : null)} note={`${linksOk}/${linksTotal} active links verified`} />
        <Stat label="Image coverage" value={pct(images ? (images - fallbackImages) / images : null)} note={`${fallbackImages} fallback placeholders`} />
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
