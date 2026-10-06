import Flash from "@/components/flash";
import { ActionForm, Badge, when } from "@/components/admin-ui";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { integrationStatus } from "@/lib/config";
import { couponsConfigured } from "@/lib/sovrn/coupons";
import { db } from "@/lib/db";
import { jobOutcome, JOBS } from "@/lib/jobs/registry";
import { apifyConfigured } from "@/lib/pipeline/apify";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";
export const metadata = { title: "Jobs & runs" };

const DESCRIPTIONS: Record<keyof typeof JOBS, string> = {
  ingest: "Fetch the legacy Content API (skipped when not configured) and run all review stages.",
  "scrape-sources": "Start Apify Web Scraper runs for enabled review sources whose crawl interval has elapsed (robots.txt checked first).",
  "collect-scrapes": "Poll running Apify runs; fetch finished datasets, reject invalid pages with a reason, and ingest the rest; fresh items are published automatically.",
  "verify-links": "Re-verify affiliate links that are due (or pending).",
  "revalidate-offers": "Re-query Sovrn for reviews with stale or failed deal data.",
  "retry-failed": "Retry due retryable failures with bounded attempts.",
  "cleanup-cache": "Delete expired Sovrn cache rows, sessions, rate-limit buckets and stale locks.",
  "publish-cycle": "Publish QA-passing reviews automatically (pause it in Admin → Automation).",
  "refresh-coupons": "Look up Sovrn promo codes for published products with a real retailer URL; retire codes Sovrn no longer returns.",
  "daily-article": "Publish the scheduled article for the due slot (MORNING 08:00, EVENING 19:00 Asia/Kolkata): next topic from the queue, duplicate checks, Keyword-to-Blog, content and SEO QA, unique image, then publish. Does nothing when no slot is due or it is already published. See Admin → Daily articles.",
  "reclassify-content": "Re-run entity extraction, content-kind detection (review / comparison / buying guide), product linking and categorization for existing content after rule or taxonomy changes. Never changes publish state; rebuilds live pages.",
  "enrich-images": "Give published and QA reviews a real Pexels image: a photo of the product if one exists, otherwise a labelled illustrative photo of its topic. Replaces broken images, never downgrades a good one, stops on a Pexels rate limit.",
  "detect-stale": "Flag published reviews whose source article is older than STALE_REVIEW_MONTHS (default 18) and AI guides older than STALE_GUIDE_MONTHS (default 12) as CONTENT_STALE in Failures. Nothing is unpublished automatically.",
  "inspect-index": "Inspect published URLs with the Search Console URL Inspection API.",
};

export default async function JobsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const [locks, runs, lastRuns] = await Promise.all([
    db.jobLock.findMany(),
    db.revalidationRun.findMany({ orderBy: { startedAt: "desc" }, take: 30 }),
    db.auditLog.findMany({ where: { entityType: "job", action: { startsWith: "job.run." } }, orderBy: { createdAt: "desc" }, distinct: ["entityId"], select: { entityId: true, actor: true, createdAt: true, metadata: true } }),
  ]);
  const integrations = integrationStatus();
  const blocked: Partial<Record<keyof typeof JOBS, string | undefined>> = {
    ingest: integrations.contentApi !== "READY" ? "CONTENT_API_URL not configured" : undefined,
    "revalidate-offers": integrations.sovrn !== "READY" ? "Sovrn not configured" : undefined,
    "inspect-index": integrations.gsc !== "READY" ? "Search Console not configured" : undefined,
    "refresh-coupons": couponsConfigured() ? undefined : "SOVRN_COUPONS_ENABLED is off (needs Sovrn Promo Codes registration)",
    "scrape-sources": apifyConfigured() ? undefined : "APIFY_API_TOKEN not configured",
    "collect-scrapes": apifyConfigured() ? undefined : "APIFY_API_TOKEN not configured",
  };
  return (
    <>
      <h1>Jobs &amp; runs</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p className="muted">Scheduled daily via Vercel Cron (vercel.json) and hourly or six-hourly via the GitHub Actions workflow, both at /api/cron/&lt;job&gt; (Bearer CRON_SECRET — {integrations.cron}). Every job holds a DB lock; stale locks expire automatically.</p>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Job</th>
              <th scope="col">What it does</th>
              <th scope="col">Last run</th>
              <th scope="col">Lock</th>
              <th scope="col">Run</th>
            </tr>
          </thead>
          <tbody>
            {(Object.keys(JOBS) as Array<keyof typeof JOBS>).map((name) => {
              const last = lastRuns.find((r) => r.entityId === name);
              const outcome = last ? jobOutcome(last.metadata) : undefined;
              const lock = locks.find((l) => l.name === (name === "ingest" ? "ingestion" : `job:${name}`));
              return (
                <tr key={name}>
                  <td data-label="Job">
                    <code>{name}</code>
                  </td>
                  <td data-label="What it does" className="small">{DESCRIPTIONS[name]}</td>
                  <td data-label="Last run" className="small">
                    {last && outcome ? (
                      <>
                        <Badge value={outcome.status} tone={outcome.ran ? "ok" : "warn"} /> {when(last.createdAt)} by {last.actor}
                        {outcome.reason && <div className="muted">{outcome.reason}</div>}
                      </>
                    ) : (
                      "No run recorded"
                    )}
                  </td>
                  <td data-label="Lock">{lock ? <Badge value={lock.expiresAt > new Date() ? `held until ${when(lock.expiresAt)}` : "stale (will be recovered)"} tone="warn" /> : "free"}</td>
                  <td data-label="Run">
                    <ActionForm action="/api/admin/jobs" fields={{ job: name }} label="Run now" returnTo="/admin/jobs" disabledReason={blocked[name]} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <h2>Recent runs</h2>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Type</th>
              <th scope="col">Trigger</th>
              <th scope="col" className="num">Checked</th>
              <th scope="col" className="num">OK</th>
              <th scope="col" className="num">Failed</th>
              <th scope="col">Reasons</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td data-label="Started">{when(r.startedAt)}</td>
                <td data-label="Type">{r.type}</td>
                <td data-label="Trigger">{r.trigger}</td>
                <td data-label="Checked" className="num">{r.checkedCount}</td>
                <td data-label="OK" className="num">{r.successCount}</td>
                <td data-label="Failed" className="num">{r.failureCount}</td>
                <td data-label="Reasons" className="small">
                  {r.reasonBreakdown ? Object.entries(r.reasonBreakdown as Record<string, number>).map(([k, v]) => `${k}: ${v}`).join(", ") : "—"}
                  {r.errorMessage && <div className="muted">{r.errorMessage}</div>}
                </td>
                <td data-label="Status">
                  <Badge value={r.status} />
                </td>
              </tr>
            ))}
            {!runs.length && (
              <tr>
                <td colSpan={8}>No runs yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
