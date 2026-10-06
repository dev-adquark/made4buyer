import Link from "next/link";
import Flash from "@/components/flash";
import { ActionForm, Badge, Pager, Stat, when } from "@/components/admin-ui";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { CATEGORY_LABELS, CHECKS, checkByKey, lastDataAudit, listFlagged, type AuditCategory } from "@/lib/ops/data-audit";

export const dynamic = "force-dynamic";
export const metadata = { title: "Data audit" };

const PAGE_SIZE = 50;

export default async function DataAuditPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const selected = checkByKey(param(sp, "check") ?? "");
  const page = Math.max(1, Number(param(sp, "page")) || 1);
  const [last, drill] = await Promise.all([lastDataAudit(), selected ? listFlagged(selected.key, page, PAGE_SIZE) : Promise.resolve(null)]);
  const categories = Object.keys(CATEGORY_LABELS) as AuditCategory[];
  const categoryTotal = (cat: AuditCategory) => (last ? CHECKS.filter((c) => c.category === cat).reduce((n, c) => n + (last.counts[c.key] ?? 0), 0) : null);

  return (
    <>
      <h1>Data audit</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p className="muted">
        Scans published content and commerce data for unverified, stale, conflicting, duplicate, broken and unsourced items. Read-only except two safe, audited status corrections: FRESH offers past the price max age become STALE, and VERIFIED coupons past their stated expiry become EXPIRED. Nothing is deleted, no article is rewritten and no value is filled in. Runs as the <code>data-audit</code> job (see <Link href="/admin/schedules">Schedules</Link>).
      </p>
      <div className="btnrow">
        <ActionForm action="/api/admin/data-audit" fields={{}} label="Run audit now" returnTo="/admin/data-audit" className="btn" />
      </div>

      <h2>Last audit</h2>
      {last ? (
        <>
          <p className="small muted">
            Finished {when(last.finishedAt)} · trigger {last.trigger} · took {last.durationMs} ms · counts are what the audit found before its fixes.
          </p>
          <div className="stats">
            {categories.map((cat) => (
              <Stat key={cat} label={CATEGORY_LABELS[cat]} value={categoryTotal(cat) ?? "—"} />
            ))}
            <Stat label="Offers marked STALE" value={last.fixed.offersMarkedStale} note="safe fix" />
            <Stat label="Coupons marked EXPIRED" value={last.fixed.couponsMarkedExpired} note="safe fix" />
          </div>
        </>
      ) : (
        <p>No audit recorded yet. Use “Run audit now”.</p>
      )}

      <h2>Checks</h2>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Check</th>
              <th scope="col" className="num">Last audit</th>
              <th scope="col">Rule</th>
              <th scope="col">Items</th>
            </tr>
          </thead>
          <tbody>
            {CHECKS.map((c) => {
              const n = last?.counts[c.key];
              return (
                <tr key={c.key} aria-current={selected?.key === c.key ? "true" : undefined}>
                  <td data-label="Category">
                    <Badge value={CATEGORY_LABELS[c.category]} tone={c.category === "BROKEN" || c.category === "CONFLICTING" ? "error" : "warn"} />
                  </td>
                  <td data-label="Check">{c.label}</td>
                  <td data-label="Last audit" className="num">
                    {n === undefined ? "—" : n ? <Badge value={`${n} ${c.unit}`} tone="warn" /> : "0"}
                  </td>
                  <td data-label="Rule" className="small muted">
                    {c.rule}
                    {c.safeFix && <div>Safe fix: {c.safeFix}</div>}
                  </td>
                  <td data-label="Items">
                    <Link className="btn small" href={`/admin/data-audit?check=${c.key}#items`}>
                      View
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selected && drill && (
        <>
          <h2 id="items">
            {selected.label} — {drill.total} {selected.unit} now
          </h2>
          <p className="small muted">Evaluated live (may differ from the last audit). {selected.rule}</p>
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Detail</th>
                  <th scope="col">Date</th>
                </tr>
              </thead>
              <tbody>
                {drill.rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Item">{r.href ? <Link href={r.href}>{r.title}</Link> : r.title}</td>
                    <td data-label="Detail" className="small" style={{ wordBreak: "break-word" }}>
                      {r.detail}
                    </td>
                    <td data-label="Date" className="small">{r.at ? when(r.at) : "—"}</td>
                  </tr>
                ))}
                {!drill.rows.length && (
                  <tr>
                    <td colSpan={3}>Nothing flagged.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <Pager page={page} pages={Math.ceil(drill.total / PAGE_SIZE)} base={`/admin/data-audit?check=${selected.key}`} />
        </>
      )}
    </>
  );
}
