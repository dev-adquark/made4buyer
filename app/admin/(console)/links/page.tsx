import type { LinkVerificationStatus } from "@prisma/client";
import Link from "next/link";
import Flash from "@/components/flash";
import { ActionForm, Badge, Stat, when } from "@/components/admin-ui";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "Link health" };

const STATUSES: LinkVerificationStatus[] = ["VERIFIED_OK", "PENDING", "REDIRECT_MISMATCH", "FORBIDDEN", "BLOCKED", "UNAVAILABLE", "TIMEOUT", "INVALID", "PROVIDER_ERROR"];

function defaultRange() {
  const now = new Date();
  return { today: now.toISOString().slice(0, 10), weekAgo: new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10) };
}

export default async function LinksPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const status = STATUSES.includes(param(sp, "status") as LinkVerificationStatus) ? (param(sp, "status") as LinkVerificationStatus) : undefined;
  const [counts, links, runs] = await Promise.all([
    db.affiliateLink.groupBy({ by: ["verificationStatus"], where: { isActive: true }, _count: { _all: true } }),
    db.affiliateLink.findMany({
      where: { isActive: true, ...(status ? { verificationStatus: status } : {}) },
      orderBy: [{ lastVerifiedAt: { sort: "desc", nulls: "first" } }],
      take: 100,
      include: { review: { select: { id: true, productName: true, status: true } }, offerMatch: { select: { merchantName: true } } },
    }),
    db.revalidationRun.findMany({ where: { type: { in: ["LINK_VERIFICATION", "OFFER_REFRESH"] } }, orderBy: { startedAt: "desc" }, take: 10 }),
  ]);
  const count = (s: string) => counts.find((c) => c.verificationStatus === s)?._count._all ?? 0;
  const { today, weekAgo } = defaultRange();

  return (
    <>
      <h1>Link health</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <div className="stats">
        {STATUSES.map((s) => (
          <Stat key={s} label={s} value={count(s)} />
        ))}
      </div>
      <section aria-labelledby="reval-h" className="card card-body">
        <h2 id="reval-h" style={{ marginTop: 0 }}>
          Revalidate by date range
        </h2>
        <p className="small muted">Selects reviews published in the range (or created in the range, if never published) and re-checks every active link, or re-queries Sovrn for their offers.</p>
        <form action="/api/admin/revalidate" method="post" className="toolbar">
          <input type="hidden" name="returnTo" value="/admin/links" />
          <div className="field">
            <label htmlFor="rv-start">From</label>
            <input id="rv-start" name="start" type="date" defaultValue={weekAgo} max={today} />
          </div>
          <div className="field">
            <label htmlFor="rv-end">To</label>
            <input id="rv-end" name="end" type="date" defaultValue={today} max={today} />
          </div>
          <div className="field">
            <label htmlFor="rv-type">What</label>
            <select id="rv-type" name="type" defaultValue="links">
              <option value="links">Affiliate link verification</option>
              <option value="offers">Sovrn offer refresh (+ links)</option>
            </select>
          </div>
          <button className="btn primary" type="submit">
            Run revalidation
          </button>
        </form>
        <ActionForm action="/api/admin/jobs" fields={{ job: "verify-links" }} label="Verify all due links" returnTo="/admin/links" />
      </section>

      <h2>Recent revalidation runs</h2>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Type</th>
              <th scope="col">Trigger</th>
              <th scope="col">Range</th>
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
                <td data-label="Range" className="small">{r.rangeStart || r.rangeEnd ? `${when(r.rangeStart)} → ${when(r.rangeEnd)}` : "due items"}</td>
                <td data-label="Checked" className="num">{r.checkedCount}</td>
                <td data-label="OK" className="num">{r.successCount}</td>
                <td data-label="Failed" className="num">{r.failureCount}</td>
                <td data-label="Reasons" className="small">{r.reasonBreakdown ? Object.entries(r.reasonBreakdown as Record<string, number>).map(([k, v]) => `${k}: ${v}`).join(", ") : "—"}</td>
                <td data-label="Status">
                  <Badge value={r.status} />
                </td>
              </tr>
            ))}
            {!runs.length && (
              <tr>
                <td colSpan={9}>No revalidation runs yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2>Active links</h2>
      <nav aria-label="Verification status filter">
        <ul className="chips">
          <li>
            <Link className="chip neutral" href="/admin/links" aria-current={!status ? "true" : undefined}>
              All
            </Link>
          </li>
          {STATUSES.map((s) => (
            <li key={s}>
              <Link className="chip neutral" href={`/admin/links?status=${s}`} aria-current={status === s ? "true" : undefined}>
                {s}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Review</th>
              <th scope="col">Merchant</th>
              <th scope="col">Status</th>
              <th scope="col">Reason</th>
              <th scope="col">Last checked</th>
              <th scope="col">Next check</th>
            </tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <tr key={l.id}>
                <td data-label="Review">
                  <Link href={`/admin/reviews/${l.review.id}`}>{l.review.productName}</Link> {l.isBest && <Badge value="BEST" tone="ok" />}
                </td>
                <td data-label="Merchant">{l.offerMatch?.merchantName ?? "—"}</td>
                <td data-label="Status">
                  <Badge value={l.verificationStatus} />
                </td>
                <td data-label="Reason" className="small">
                  {l.httpStatus ? `HTTP ${l.httpStatus} · ` : ""}
                  {l.verificationReason ?? "—"}
                </td>
                <td data-label="Last checked">{when(l.lastVerifiedAt)}</td>
                <td data-label="Next check">{when(l.nextVerificationAt)}</td>
              </tr>
            ))}
            {!links.length && (
              <tr>
                <td colSpan={6}>No active links in this view.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
