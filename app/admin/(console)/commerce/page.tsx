import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { ActionForm, Badge, Pager, Stat, when } from "@/components/admin-ui";
import Flash from "@/components/flash";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { commerceEngineOn, commerceMetrics, nextMonthStartUtc } from "@/lib/commerce/admin-actions";
import { DEAL_REASON_LABEL, DEAL_STATUSES, type DealStatus } from "@/lib/commerce/deal-status";
import { db } from "@/lib/db";
import { isJobName } from "@/lib/jobs/registry";
import WeeklyRefreshPanel from "./weekly-refresh-panel";

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
const money = (v: number) => `$${v.toFixed(2)}`;
const percent = (ratio: number) => (Number.isFinite(ratio) ? `${(ratio * 100).toFixed(0)}%` : "—");
const day = (d: Date) => d.toISOString().slice(0, 10);

const DEAL_TONE: Record<DealStatus, "ok" | "warn" | "error" | "info" | "neutral"> = { ACTIVE: "ok", VERIFIED: "info", EXPIRED: "neutral", INVALID: "error", BROKEN: "error", CONFLICTING: "warn", UNVERIFIED: "warn" };
const DEAL_MEANING: Record<DealStatus, string> = {
  ACTIVE: "shown on /deals",
  VERIFIED: "valid, not a live drop (no list price, out of stock, not started, duplicate)",
  EXPIRED: "stale (> price window), stated end passed, or not re-seen",
  INVALID: "not USD, no price, list ≤ price, no identity, unknown site",
  BROKEN: "link BROKEN / OFF_SITE / UNREACHABLE",
  CONFLICTING: "official site contradicts it",
  UNVERIFIED: "not confirmed by the official site",
};

/** Admin → Commerce engine: state, controls, health numbers, budget and every Apify run. */
export default async function CommercePage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const status = param(sp, "status") ?? "";
  const purpose = param(sp, "purpose") ?? "";
  const page = Math.max(1, Number(param(sp, "page")) || 1);
  const now = new Date();
  const where: Prisma.CommerceRunWhereInput = { ...(status ? { status } : {}), ...(purpose ? { purpose } : {}) };

  const [engineOn, m, brandsTotal, brandsEnabled, failedBrands, failedRuns, nextBrand, statuses, purposes, total, runs] = await Promise.all([
    commerceEngineOn(),
    commerceMetrics(now),
    db.commerceBrand.count(),
    db.commerceBrand.count({ where: { enabled: true } }),
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
  const { budget, runs: runStats, products, offers, coupons, dealStatus } = m;

  return (
    <>
      <h1>Commerce engine</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p className="muted">
        Apify crawls official brand sites (and reviewed sources) for products, prices and first-party promo codes. Raw records are kept exactly as returned; a product is attached to a Made4Buyers product only after an exact identity match, and an offer is shown only while it is fresh.
      </p>

      <WeeklyRefreshPanel returnTo={returnTo} />

      <section aria-labelledby="engine-h">
        <h2 id="engine-h">
          Engine state <Badge value={engineOn ? "RUNNING" : "PAUSED"} tone={engineOn ? "ok" : "warn"} />
          {budget.exhausted && <> <Badge value="BUDGET REACHED" tone="error" /></>}
        </h2>
        {!engineOn && <p className="notice warn">The commerce engine is paused: scheduled discovery, collection and coupon checks will not act until it is resumed. Manual “Run now” still runs.</p>}
        {budget.pausedUntil && (
          <p className="notice error" role="alert">
            Paused: budget reached until {day(budget.pausedUntil)} (00:00 UTC). {money(budget.usedUsd)} of the {money(budget.budgetUsd)} monthly Apify budget (COMMERCE_MONTHLY_BUDGET_USD) has been used since {day(m.monthStart)}; new Apify runs are refused until the next UTC month.
          </p>
        )}
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
          Next discovery pass:{" "}
          {runStats.nextDiscovery ? (
            <>
              <strong>{when(runStats.nextDiscovery.at)}</strong> (<code>{runStats.nextDiscovery.path}</code>, {runStats.nextDiscovery.origin === "vercel" ? "Vercel cron" : "GitHub Actions"}; {runStats.nextDiscovery.schedules} discovery schedule{runStats.nextDiscovery.schedules === 1 ? "" : "s"})
            </>
          ) : (
            <span className="muted">no commerce-discover schedule is configured</span>
          )}
          {runStats.next.some((r) => r.job !== "commerce-discover") && (
            <>
              . Other commerce jobs:{" "}
              {runStats.next
                .filter((r) => r.job !== "commerce-discover")
                .map((r, i) => (
                  <span key={r.job}>
                    {i > 0 && " · "}
                    <code>{r.job}</code> {when(r.at)}
                  </span>
                ))}
            </>
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
          . Per-brand crawl status: <Link href="/admin/commerce/sources">Brands &amp; sources</Link>.
        </p>
      </section>

      <h2 id="budget-h">Apify budget (this UTC month)</h2>
      <div className="stats" aria-labelledby="budget-h">
        <Stat label="Used this month" value={money(budget.usedUsd)} note={`since ${day(m.monthStart)} · sum of run usage`} />
        <Stat label="Monthly budget" value={money(budget.budgetUsd)} note="COMMERCE_MONTHLY_BUDGET_USD" />
        <Stat label="Remaining" value={money(budget.remainingUsd)} note={budget.pausedUntil ? `paused until ${day(budget.pausedUntil)}` : `resets ${day(nextMonthStartUtc(now))}`} />
        <Stat
          label="Budget used"
          value={<Badge value={percent(budget.ratio)} tone={budget.exhausted ? "error" : budget.warn ? "warn" : "ok"} />}
          note={budget.exhausted ? "Paused: budget reached" : budget.warn ? "Warning: 80% or more used" : "under 80%"}
        />
      </div>
      {budget.warn && !budget.exhausted && (
        <p className="notice warn" role="alert">
          Apify usage is at {percent(budget.ratio)} of the monthly budget ({money(budget.budgetUsd)}, COMMERCE_MONTHLY_BUDGET_USD); {money(budget.remainingUsd)} remains. Consider pausing the engine or lowering brand crawl frequency.
        </p>
      )}

      <h2 id="health-h">Runs and data</h2>
      <div className="stats" aria-labelledby="health-h">
        <Stat label="Brands enabled" value={`${brandsEnabled} / ${brandsTotal}`} note={<><Link href="/admin/commerce/brands">Manage brands</Link> · <Link href="/admin/commerce/sources">Crawl status</Link></>} />
        <Stat label="Runs (last 24 h)" value={`${runStats.last24h.succeeded} ok · ${runStats.last24h.failed} failed`} note={`${runStats.last24h.total} total`} />
        <Stat label="Runs (this month)" value={`${runStats.month.succeeded} ok · ${runStats.month.failed} failed`} note={`${runStats.month.total} total`} />
        <Stat label="Last successful run" value={runStats.lastSuccessAt ? when(runStats.lastSuccessAt) : "—"} note={runStats.lastSuccessAt ? "Apify run succeeded" : "no successful run yet"} />
        <Stat label="Products discovered" value={products.total} note={`${products.matched} matched · ${products.rejected} rejected · ${products.unmatched} unmatched`} />
        <Stat label="Offers discovered" value={offers.total} note={<Link href="/admin/commerce/products">Products &amp; offers</Link>} />
        <Stat label="Verified public offers" value={offers.public} note="fresh ≤ price window, link OK, USD, price > 0" />
        <Stat label="Rejected offers" value={offers.priceRejectedThisMonth + offers.hiddenLink} note={`${offers.priceRejectedThisMonth} prices rejected this month · ${offers.hiddenLink} hidden (bad link)`} />
        <Stat label="Stale offers" value={offers.stale} note="STALE, or FRESH past the price window" />
        <Stat label="Duplicate offers" value={offers.duplicateGroups} note={<Link href="/admin/data-audit">duplicate groups (data audit)</Link>} />
        <Stat label="Conflicting data" value={m.conflicts.total} note={`${m.conflicts.coupons} coupons · ${m.conflicts.factFields} products with conflicting facts`} />
        <Stat label="Coupons discovered" value={coupons.total} note={<>{coupons.verifiedActive} verified &amp; active · {coupons.publicCodes} on /deals · <Link href="/admin/commerce/coupons">Coupons</Link></>} />
        <Stat label="Price-drop deals live" value={m.deals.priceDrops} note={m.deals.checkedAt ? `on /deals · newest ${when(m.deals.checkedAt)}` : "on /deals"} />
      </div>
      <p className="small muted">
        Duplicates and conflicts: {m.integrity.source === "live" ? "computed live with the data-audit checks" : "from the stored data-audit result (live check failed)"}
        {m.integrity.at ? ` at ${when(m.integrity.at)}` : ""}. Last stored data audit: {m.integrity.lastAuditAt ? when(m.integrity.lastAuditAt) : "never run"} (<Link href="/admin/data-audit">Data audit</Link>). Public offers and price drops use the same rules as the public site.
      </p>

      <h2 id="deal-status-h">Deals by status</h2>
      <div className="stats" aria-labelledby="deal-status-h">
        <Stat label="Offers classified" value={dealStatus.offers.total} note={dealStatus.offers.truncated ? `newest ${dealStatus.sampleLimit} of ${dealStatus.offers.stored}` : "every stored offer"} />
        <Stat label="Active price drops" value={dealStatus.offers.byStatus.ACTIVE} note={`${dealStatus.publicPriceDrops} on /deals`} />
        <Stat label="Active promo codes" value={dealStatus.coupons.byStatus.ACTIVE} note={`${dealStatus.publicPromoCodes} on /deals · ${dealStatus.coupons.total} classified`} />
        <Stat label="Broken links" value={dealStatus.brokenLinks} note="offers hidden: BROKEN / OFF_SITE / UNREACHABLE" />
      </div>
      <div className="table-wrap">
        <table className="table responsive" aria-labelledby="deal-status-h">
          <thead>
            <tr>
              <th scope="col">Status</th>
              <th scope="col">Meaning</th>
              <th scope="col" className="num">Offers</th>
              <th scope="col">Top offer reasons</th>
              <th scope="col" className="num">Coupons</th>
              <th scope="col">Top coupon reasons</th>
            </tr>
          </thead>
          <tbody>
            {DEAL_STATUSES.map((st) => (
              <tr key={st}>
                <td data-label="Status">
                  <Badge value={st} tone={DEAL_TONE[st]} />
                </td>
                <td data-label="Meaning" className="small">
                  {DEAL_MEANING[st]}
                </td>
                <td data-label="Offers" className="num">
                  {dealStatus.offers.byStatus[st]}
                </td>
                <td data-label="Top offer reasons" className="small">
                  {dealStatus.offers.topReasons[st].length ? dealStatus.offers.topReasons[st].map((r) => `${DEAL_REASON_LABEL[r.code]} (${r.count})`).join(" · ") : "—"}
                </td>
                <td data-label="Coupons" className="num">
                  {dealStatus.coupons.byStatus[st]}
                </td>
                <td data-label="Top coupon reasons" className="small">
                  {dealStatus.coupons.topReasons[st].length ? dealStatus.coupons.topReasons[st].map((r) => `${DEAL_REASON_LABEL[r.code]} (${r.count})`).join(" · ") : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Computed with the same functions as /deals (lib/commerce/deal-status.ts): an offer is ACTIVE only when it is an official-site page (or a retailer page for a product confirmed on the official site) stating a list price above the price, USD, observed within the price window, link not hidden, in stock, its stated end not passed and not a duplicate.
      </p>

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
