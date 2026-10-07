import Link from "next/link";
import { Badge, Pager, Stat, when } from "@/components/admin-ui";
import Flash from "@/components/flash";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { FAILED_RUN_STATUSES, commerceMonthUsage, SUCCESSFUL_RUN_STATUSES } from "@/lib/commerce/admin-actions";
import { durationLabel, listRuns, pageCount, parsePaging, runPurposeOptions, runStatusOptions, statusToken } from "@/lib/commerce/admin-queries";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "Commerce runs" };

const PAGE = "/admin/commerce/runs";
const PAGE_SIZE = 30;

type Tone = "ok" | "warn" | "error" | "info" | "neutral";
const runTone = (s: string): Tone => (SUCCESSFUL_RUN_STATUSES.includes(s) ? "ok" : FAILED_RUN_STATUSES.includes(s) ? "error" : /RUNNING|READY/.test(s) ? "info" : /SKIP|DISALLOW|DISABLED|RETRY/.test(s) ? "warn" : "neutral");
const usd = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(n < 1 ? 3 : 2)}`);
const num = (n: number | null | undefined) => (n == null ? "—" : String(n));

/** Admin → Commerce → Runs: every Apify run (and skipped / blocked attempt) of the commerce engine, with what it found and what it cost. */
export default async function CommerceRunsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const status = statusToken(param(sp, "status"));
  const purpose = statusToken(param(sp, "purpose"));
  const brandId = param(sp, "brand")?.slice(0, 40) || undefined;
  const page = parsePaging((k) => (k === "limit" ? String(PAGE_SIZE) : param(sp, k)), PAGE_SIZE);

  const [usage, brands, statuses, runs] = await Promise.all([
    commerceMonthUsage(),
    db.commerceBrand.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    runStatusOptions(),
    listRuns({ status, purpose, brandId }, page),
  ]);
  const monthRuns = await db.commerceRun.aggregate({ where: { startedAt: { gte: usage.from } }, _count: { _all: true }, _sum: { computeUnits: true } });
  const pages = pageCount(runs.total, PAGE_SIZE);
  const qs = new URLSearchParams(Object.entries({ status, purpose, brand: brandId }).filter((e): e is [string, string] => Boolean(e[1]))).toString();
  const base = `${PAGE}${qs ? `?${qs}` : ""}`;

  return (
    <>
      <h1>Commerce runs</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p className="muted">
        Every Apify run the commerce engine started, and every attempt it skipped or that failed to start (with the reason). Found products, deals and coupons are what the run’s raw records currently source: an offer observed again by a later run moves to that run. A deal here is an offer whose page stated a list price
        above the price; whether it is shown publicly is decided by its deal status (<Link href="/admin/commerce/deals">Deals</Link>).
      </p>

      <h2 id="cost-h">Apify cost this UTC month</h2>
      <div className="stats" aria-labelledby="cost-h">
        <Stat label="Spent" value={usd(usage.used)} note={`since ${usage.from.toISOString().slice(0, 10)} · recorded usage of ${monthRuns._count._all} run${monthRuns._count._all === 1 ? "" : "s"}`} />
        <Stat label="Budget" value={usd(usage.budget)} note="COMMERCE_MONTHLY_BUDGET_USD" />
        <Stat label="Remaining" value={usd(usage.remaining)} note={usage.exhausted ? "exhausted: no new runs until next month" : usage.warn ? "over 80% used" : undefined} />
        <Stat label="Compute units" value={monthRuns._sum.computeUnits != null ? monthRuns._sum.computeUnits.toFixed(2) : "—"} note="this month, where Apify reported them" />
      </div>

      <form className="toolbar" action={PAGE}>
        <div className="field">
          <label htmlFor="cr-purpose">Purpose</label>
          <select id="cr-purpose" name="purpose" defaultValue={purpose ?? ""}>
            <option value="">All</option>
            {runPurposeOptions.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="cr-status">Status</label>
          <select id="cr-status" name="status" defaultValue={status ?? ""}>
            <option value="">All</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="cr-brand">Brand</label>
          <select id="cr-brand" name="brand" defaultValue={brandId ?? ""}>
            <option value="">All</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <button className="btn" type="submit">
          Filter
        </button>
        {qs && (
          <a className="btn" href={PAGE}>
            Clear
          </a>
        )}
      </form>

      <h2 id="cr-list-h">
        Runs <span className="muted small">({runs.total})</span>
      </h2>
      <div className="table-wrap">
        <table className="table responsive" aria-labelledby="cr-list-h">
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Purpose</th>
              <th scope="col">Brand / source</th>
              <th scope="col">Status</th>
              <th scope="col">Duration</th>
              <th scope="col" className="num">
                Pages
              </th>
              <th scope="col" className="num">
                Extracted / accepted / rejected
              </th>
              <th scope="col" className="num">
                Products / deals / coupons
              </th>
              <th scope="col">Failures</th>
              <th scope="col" className="num">
                Compute units
              </th>
              <th scope="col" className="num">
                Cost
              </th>
            </tr>
          </thead>
          <tbody>
            {runs.items.map((r) => (
              <tr key={r.id}>
                <td data-label="Started" className="small">
                  {when(r.startedAt)}
                  <div className="muted">ended {r.finishedAt ? when(r.finishedAt) : "—"}</div>
                  <div className="muted">{r.trigger.replace(/^admin:.*/, "admin")}</div>
                </td>
                <td data-label="Purpose" className="small">
                  {r.purpose}
                  <div className="muted" style={{ wordBreak: "break-all" }}>
                    {r.actorId}
                  </div>
                </td>
                <td data-label="Brand / source" className="small">
                  {r.brand ? r.brand.name : r.source ? `${r.source.name} (source)` : "—"}
                  {r.apifyRunId && (
                    <div className="muted">
                      Apify <code>{r.apifyRunId}</code>
                    </div>
                  )}
                </td>
                <td data-label="Status">
                  <Badge value={r.status} tone={runTone(r.status)} />
                  {r.collectedAt && <div className="small muted">collected {when(r.collectedAt)}</div>}
                </td>
                <td data-label="Duration" className="small">
                  {r.finishedAt ? durationLabel(r.durationMs) : /RUNNING|READY/.test(r.status) ? "running" : "—"}
                </td>
                <td data-label="Pages" className="num">
                  {num(r.pagesProcessed)}
                  <div className="small muted">{r.startUrls} start URL{r.startUrls === 1 ? "" : "s"}</div>
                </td>
                <td data-label="Extracted / accepted / rejected" className="num">
                  {num(r.extracted)} / {num(r.accepted)} / {num(r.rejected)}
                </td>
                <td data-label="Products / deals / coupons" className="num">
                  {r.found.products} / {r.found.deals} / {r.found.coupons}
                </td>
                <td data-label="Failures" className="small" style={{ wordBreak: "break-word" }}>
                  {r.errors.count ? (
                    <>
                      {r.errors.codes.map((c) => `${c.code}${c.count > 1 ? ` ×${c.count}` : ""}`).join(", ")}
                      {r.errors.sample && <div className="muted">{r.errors.sample}</div>}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td data-label="Compute units" className="num">
                  {r.computeUnits != null ? r.computeUnits.toFixed(3) : "—"}
                </td>
                <td data-label="Cost" className="num">
                  {usd(r.usageUsd)}
                </td>
              </tr>
            ))}
            {!runs.items.length && (
              <tr>
                <td colSpan={11}>{qs ? "No runs match these filters." : "No commerce runs recorded yet."}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={Math.min(page.page, pages)} pages={pages} base={base} />
    </>
  );
}
