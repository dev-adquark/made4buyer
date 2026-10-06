import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { ActionForm, Badge, Pager, Stat, when } from "@/components/admin-ui";
import Flash from "@/components/flash";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { commerceEngineOn, commerceMonthUsage, FAILED_RUN_STATUSES } from "@/lib/commerce/admin-actions";
import { db } from "@/lib/db";
import { isJobName } from "@/lib/jobs/registry";
import vercelConfig from "../../../../vercel.json";

export const dynamic = "force-dynamic";
export const metadata = { title: "Commerce engine" };

const PAGE_SIZE = 25;
const RUN_TONE: Record<string, "ok" | "warn" | "error" | "info" | "neutral"> = {
  SUCCEEDED: "ok", COLLECTED: "ok", COMPLETED: "ok", RUNNING: "info", READY: "info", COLLECTING: "info", RETRY_QUEUED: "warn", SKIPPED: "neutral", BLOCKED: "warn",
  FAILED: "error", ABORTED: "error", "TIMED-OUT": "error", COLLECT_FAILED: "error",
};
const JOBS: Array<[string, string]> = [
  ["commerce-discover", "Run discovery now"],
  ["commerce-collect", "Run collection now"],
  ["commerce-coupons", "Run coupon check now"],
];

/** Commerce crons as deployed (read from vercel.json at build time). */
const COMMERCE_CRONS = ((vercelConfig as { crons?: Array<{ path: string; schedule: string }> }).crons ?? []).filter((c) => c.path.includes("commerce"));

function duration(start: Date, end: Date | null): string {
  if (!end) return "—";
  const s = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function errorSummary(errors: Prisma.JsonValue | null): string {
  if (errors == null) return "—";
  if (Array.isArray(errors)) {
    if (!errors.length) return "—";
    const first = errors[0];
    const text = typeof first === "string" ? first : JSON.stringify(first);
    return `${errors.length} · ${text.slice(0, 140)}`;
  }
  return (typeof errors === "string" ? errors : JSON.stringify(errors)).slice(0, 160);
}

const usd = (v: number | null | undefined) => (v == null ? "—" : `$${v.toFixed(v < 1 ? 4 : 2)}`);

/** Admin → Commerce engine: state, controls, health numbers, budget and every Apify run. */
export default async function CommercePage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const status = param(sp, "status") ?? "";
  const purpose = param(sp, "purpose") ?? "";
  const page = Math.max(1, Number(param(sp, "page")) || 1);
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const where: Prisma.CommerceRunWhereInput = { ...(status ? { status } : {}), ...(purpose ? { purpose } : {}) };

  const [engineOn, usage, brandsTotal, brandsEnabled, productsTotal, matched, rejected, freshOffers, staleOffers, verifiedCoupons, runs24, fails24, failedBrands, failedRuns, nextBrand, statuses, purposes, total, runs] = await Promise.all([
    commerceEngineOn(),
    commerceMonthUsage(now),
    db.commerceBrand.count(),
    db.commerceBrand.count({ where: { enabled: true } }),
    db.commerceProduct.count(),
    db.commerceProduct.count({ where: { identityStatus: "MATCHED" } }),
    db.commerceProduct.count({ where: { identityStatus: "MATCH_REJECTED" } }),
    db.commerceOffer.count({ where: { status: "FRESH" } }),
    db.commerceOffer.count({ where: { status: "STALE" } }),
    db.commerceCoupon.count({ where: { status: "VERIFIED", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } }),
    db.commerceRun.count({ where: { startedAt: { gte: dayAgo } } }),
    db.commerceRun.count({ where: { startedAt: { gte: dayAgo }, status: { in: FAILED_RUN_STATUSES } } }),
    db.commerceBrand.count({ where: { OR: [{ consecutiveFailures: { gt: 0 } }, { crawlStatus: "FAILED" }] } }),
    db.commerceRun.count({ where: { status: "FAILED" } }),
    db.commerceBrand.findFirst({ where: { enabled: true, nextCrawlAt: { not: null } }, orderBy: { nextCrawlAt: "asc" }, select: { name: true, slug: true, nextCrawlAt: true } }),
    db.commerceRun.groupBy({ by: ["status"], _count: { _all: true }, orderBy: { status: "asc" } }),
    db.commerceRun.groupBy({ by: ["purpose"], _count: { _all: true }, orderBy: { purpose: "asc" } }),
    db.commerceRun.count({ where }),
    db.commerceRun.findMany({
      where,
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { brand: { select: { name: true, slug: true } }, source: { select: { name: true, slug: true } } },
    }),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const qs = new URLSearchParams({ ...(status ? { status } : {}), ...(purpose ? { purpose } : {}) }).toString();
  const base = `/admin/commerce${qs ? `?${qs}` : ""}`;
  const returnTo = base;

  return (
    <>
      <h1>Commerce engine</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p className="muted">
        Apify crawls official brand sites (and reviewed sources) for products, prices and first-party promo codes. Raw records are kept exactly as returned; a product is attached to a Made4Buyers product only after an exact identity match, and an offer is shown only while it is fresh.
      </p>

      <section aria-labelledby="engine-h">
        <h2 id="engine-h">
          Engine state <Badge value={engineOn ? "RUNNING" : "PAUSED"} tone={engineOn ? "ok" : "warn"} />
        </h2>
        {!engineOn && <p className="notice warn">The commerce engine is paused: scheduled discovery, collection and coupon checks will not act until it is resumed. Manual “Run now” still runs.</p>}
        <div className="btnrow">
          {engineOn ? (
            <ActionForm action="/api/admin/commerce" fields={{ action: "pause" }} label="Pause engine" returnTo={returnTo} className="btn small danger" confirm="Pause all scheduled commerce crawls?" />
          ) : (
            <ActionForm action="/api/admin/commerce" fields={{ action: "resume" }} label="Resume engine" returnTo={returnTo} />
          )}
          {JOBS.map(([job, label]) => (
            <ActionForm key={job} action="/api/admin/jobs" fields={{ job }} label={label} returnTo={returnTo} disabledReason={isJobName(job) ? undefined : `job "${job}" is not registered in this build`} />
          ))}
          <ActionForm
            action="/api/admin/commerce"
            fields={{ action: "retry-failed" }}
            label={`Retry failed (${failedBrands} brand${failedBrands === 1 ? "" : "s"}, ${failedRuns} run${failedRuns === 1 ? "" : "s"})`}
            returnTo={returnTo}
            disabledReason={failedBrands || failedRuns ? undefined : "nothing has failed"}
          />
        </div>
        <p className="small">
          Next scheduled run:{" "}
          {COMMERCE_CRONS.length ? (
            COMMERCE_CRONS.map((c, i) => (
              <span key={c.path}>
                {i > 0 && " · "}
                <code>{c.path}</code> at <code>{c.schedule}</code> (cron, UTC)
              </span>
            ))
          ) : (
            <span className="muted">no commerce cron is configured in vercel.json</span>
          )}
          . Earliest brand due:{" "}
          {nextBrand ? (
            <>
              {nextBrand.name} at {when(nextBrand.nextCrawlAt)}
              {nextBrand.nextCrawlAt && nextBrand.nextCrawlAt <= now ? " (due now)" : ""}
            </>
          ) : (
            "no enabled brand is scheduled"
          )}
          .
        </p>
      </section>

      <div className="stats">
        <Stat label="Brands enabled" value={`${brandsEnabled} / ${brandsTotal}`} note={<Link href="/admin/commerce/brands">Manage brands</Link>} />
        <Stat label="Commerce products" value={productsTotal} note={`${matched} matched · ${rejected} rejected`} />
        <Stat label="Fresh offers" value={freshOffers} note={`${staleOffers} stale`} />
        <Stat label="Verified coupons" value={verifiedCoupons} note={<Link href="/admin/commerce/coupons">Coupons</Link>} />
        <Stat label="Runs (last 24 h)" value={runs24} note={`${fails24} failed`} />
        <Stat label="Apify usage this month" value={`${usd(usage.used)} / $${usage.budget.toFixed(2)}`} note={`${(usage.ratio * 100).toFixed(0)}% of budget since ${usage.from.toISOString().slice(0, 10)}`} />
      </div>
      {usage.warn && (
        <p className="notice warn" role="alert">
          Apify usage is at {(usage.ratio * 100).toFixed(0)}% of the monthly budget (${usage.budget.toFixed(2)}, COMMERCE_MONTHLY_BUDGET_USD). Consider pausing the engine or lowering brand crawl frequency.
        </p>
      )}

      <h2 id="runs-h">Apify runs</h2>
      <form className="toolbar" action="/admin/commerce">
        <div className="field">
          <label htmlFor="run-status">Status</label>
          <select id="run-status" name="status" defaultValue={status}>
            <option value="">All</option>
            {statuses.map((s) => (
              <option key={s.status} value={s.status}>
                {s.status} ({s._count._all})
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="run-purpose">Purpose</label>
          <select id="run-purpose" name="purpose" defaultValue={purpose}>
            <option value="">All</option>
            {purposes.map((p) => (
              <option key={p.purpose} value={p.purpose}>
                {p.purpose} ({p._count._all})
              </option>
            ))}
          </select>
        </div>
        <button className="btn" type="submit">
          Filter
        </button>
      </form>
      <div className="table-wrap">
        <table className="table responsive" aria-labelledby="runs-h">
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col">Purpose</th>
              <th scope="col">Brand / source</th>
              <th scope="col">Actor</th>
              <th scope="col">Started</th>
              <th scope="col">Duration</th>
              <th scope="col">Status</th>
              <th scope="col" className="num">Pages</th>
              <th scope="col" className="num">Extracted</th>
              <th scope="col" className="num">Accepted</th>
              <th scope="col" className="num">Rejected</th>
              <th scope="col">Errors</th>
              <th scope="col" className="num">Usage</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td data-label="Run" className="small" style={{ wordBreak: "break-all" }}>
                  <code>{r.apifyRunId ?? r.id}</code>
                  <div className="muted">{r.trigger}</div>
                </td>
                <td data-label="Purpose">{r.purpose}</td>
                <td data-label="Brand / source" className="small">
                  {r.brand ? r.brand.name : r.source ? r.source.name : "—"}
                </td>
                <td data-label="Actor" className="small">
                  <code>{r.actorId}</code>
                </td>
                <td data-label="Started" className="small">
                  {when(r.startedAt)}
                </td>
                <td data-label="Duration" className="small">
                  {duration(r.startedAt, r.finishedAt)}
                </td>
                <td data-label="Status">
                  <Badge value={r.status} tone={RUN_TONE[r.status] ?? "neutral"} />
                </td>
                <td data-label="Pages" className="num">{r.pagesProcessed ?? "—"}</td>
                <td data-label="Extracted" className="num">{r.extracted ?? "—"}</td>
                <td data-label="Accepted" className="num">{r.accepted ?? "—"}</td>
                <td data-label="Rejected" className="num">{r.rejected ?? "—"}</td>
                <td data-label="Errors" className="small" style={{ wordBreak: "break-word" }}>
                  {errorSummary(r.errors)}
                </td>
                <td data-label="Usage" className="num">{usd(r.usageUsd)}</td>
              </tr>
            ))}
            {!runs.length && (
              <tr>
                <td colSpan={13}>{status || purpose ? "No runs match these filters." : "No commerce runs yet."}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={page} pages={pages} base={base} />
    </>
  );
}
