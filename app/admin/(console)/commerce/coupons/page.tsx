import { ActionForm, Badge, safeHref, Stat, when } from "@/components/admin-ui";
import Flash from "@/components/flash";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { COUPON_STATUSES, couponMaxAgeDays } from "@/lib/commerce/coupons";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "Commerce coupons" };

const PAGE = "/admin/commerce/coupons";
const TONE: Record<string, "ok" | "warn" | "error" | "neutral"> = { VERIFIED: "ok", UNVERIFIED: "warn", UNKNOWN: "neutral", CONFLICTING: "warn", EXPIRED: "neutral", INVALID: "error", APPROVED: "ok", UNREVIEWED: "neutral", REJECTED: "error" };

export default async function CommerceCouponsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const status = (COUPON_STATUSES as readonly string[]).includes(param(sp, "status") ?? "") ? param(sp, "status")! : undefined;
  const brandId = param(sp, "brand") || undefined;
  const where = { ...(status ? { status } : {}), ...(brandId ? { brandId } : {}) };
  const [coupons, total, byStatus, brands, sources, runs] = await Promise.all([
    db.commerceCoupon.findMany({ where, orderBy: [{ observedAt: "desc" }], take: 100 }),
    db.commerceCoupon.count({ where }),
    db.commerceCoupon.groupBy({ by: ["status"], _count: { _all: true } }),
    db.commerceBrand.findMany({ select: { id: true, name: true, promoUrls: true, enabled: true }, orderBy: { name: "asc" } }),
    db.commerceSource.findMany({ where: { kind: "COUPON_SITE" }, orderBy: { name: "asc" } }),
    db.commerceRun.findMany({ where: { purpose: "COUPON" }, orderBy: { startedAt: "desc" }, take: 10, include: { brand: { select: { name: true } }, source: { select: { name: true } } } }),
  ]);
  const count = (s: string) => byStatus.find((b) => b.status === s)?._count._all ?? 0;
  const withPromo = brands.filter((b) => b.enabled && b.promoUrls.length).length;

  return (
    <>
      <h1>Commerce coupons</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p className="muted">
        Promo codes come only from brands&rsquo; own official promotions pages (each brand&rsquo;s promo URLs on its official domain, allowed by robots.txt). A code is VERIFIED only when the latest crawl found it on that official page and its stated expiry has not passed; only VERIFIED codes re-verified within {couponMaxAgeDays()} days are shown publicly. Discounts and dates are quoted exactly as the brand states them; nothing is inferred. Rows are never deleted.
      </p>
      <div className="stats">
        <Stat label="Verified" value={count("VERIFIED")} note="shown on the site while fresh" />
        <Stat label="Unverified / unknown" value={count("UNVERIFIED") + count("UNKNOWN")} note="never shown" />
        <Stat label="Conflicting" value={count("CONFLICTING")} />
        <Stat label="Expired / invalid" value={count("EXPIRED") + count("INVALID")} />
        <Stat label="Brands with promo pages" value={withPromo} />
      </div>

      <form className="btnrow" method="get" action={PAGE}>
        <label className="small" htmlFor="f-status">
          Status{" "}
          <select id="f-status" name="status" defaultValue={status ?? ""}>
            <option value="">All</option>
            {COUPON_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="small" htmlFor="f-brand">
          Brand{" "}
          <select id="f-brand" name="brand" defaultValue={brandId ?? ""}>
            <option value="">All</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn small" type="submit">
          Filter
        </button>
        <span className="small muted">
          {total} coupon{total === 1 ? "" : "s"}
          {total > coupons.length ? ` (newest ${coupons.length} shown)` : ""}
        </span>
      </form>

      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Merchant</th>
              <th scope="col">Code</th>
              <th scope="col">Discount</th>
              <th scope="col">Status</th>
              <th scope="col">Source</th>
              <th scope="col">Expires</th>
              <th scope="col">Last verified</th>
              <th scope="col">Evidence</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {coupons.map((c) => (
              <tr key={c.id}>
                <td data-label="Merchant">{c.merchant}</td>
                <td data-label="Code">
                  <code>{c.code}</code>
                </td>
                <td data-label="Discount">
                  {c.discount ?? <span className="muted">not stated</span>}
                  {c.discountType && <div className="small muted">{c.discountType}</div>}
                  {(c.eligibility || c.restrictions) && <div className="small muted">{[c.eligibility, c.restrictions].filter(Boolean).join(" · ")}</div>}
                </td>
                <td data-label="Status">
                  <Badge value={c.status} tone={TONE[c.status] ?? "neutral"} />
                </td>
                <td data-label="Source">
                  <a className="small" href={safeHref(c.sourceUrl)} rel="nofollow noopener noreferrer" target="_blank">
                    {c.sourceUrl.replace(/^https?:\/\//, "").slice(0, 60)}
                  </a>
                </td>
                <td data-label="Expires">{c.expiresAt ? when(c.expiresAt) : <span className="muted">not stated</span>}</td>
                <td data-label="Last verified">{when(c.lastVerifiedAt)}</td>
                <td data-label="Evidence">
                  <span className="small">{c.verificationEvidence ?? "—"}</span>
                  <div className="small muted">First seen {when(c.firstSeenAt)} · observed {when(c.observedAt)}</div>
                </td>
                <td data-label="Actions">
                  {c.status !== "INVALID" && <ActionForm action="/api/admin/commerce/coupons" fields={{ action: "mark-invalid", id: c.id }} label="Mark invalid" returnTo={PAGE} confirm={`Mark ${c.code} invalid? It stays on file and is no longer shown.`} />}
                </td>
              </tr>
            ))}
            {!coupons.length && (
              <tr>
                <td colSpan={9}>No coupons{status || brandId ? " match these filters" : " yet. Add official promotions page URLs to a brand; the next coupon crawl reads them"}.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2>Coupon sources (third-party sites)</h2>
      <p className="muted small">
        Kept disabled. Their terms of service generally prohibit automated collection. Enable one only after confirming written permission: record the terms as APPROVED first, then enable. Codes from these sites are never VERIFIED and never shown.
      </p>
      <div className="btnrow">
        <ActionForm action="/api/admin/commerce/coupons" fields={{ action: "import-sources" }} label="Import source list" returnTo={PAGE} />
      </div>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Terms</th>
              <th scope="col">Status</th>
              <th scope="col">Notes</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.id} className={s.enabled ? undefined : "row-inactive"}>
                <td data-label="Source">
                  <strong>{s.name}</strong>
                  <div className="small muted">{s.domain}</div>
                </td>
                <td data-label="Terms">
                  <Badge value={s.termsStatus} tone={TONE[s.termsStatus] ?? "neutral"} />
                </td>
                <td data-label="Status">
                  <Badge value={s.enabled ? "ENABLED" : "DISABLED"} tone={s.enabled ? "warn" : "neutral"} />
                  {s.lastCrawlAt && <div className="small muted">Last crawl {when(s.lastCrawlAt)}</div>}
                </td>
                <td data-label="Notes">
                  <span className="small">{s.notes ?? "—"}</span>
                </td>
                <td data-label="Actions">
                  <div className="btnrow" style={{ margin: 0 }}>
                    {s.termsStatus === "APPROVED" ? (
                      <ActionForm action="/api/admin/commerce/coupons" fields={{ action: "revoke-terms", id: s.id }} label="Revoke terms approval" returnTo={PAGE} />
                    ) : (
                      <ActionForm action="/api/admin/commerce/coupons" fields={{ action: "approve-terms", id: s.id }} label="Record terms approved" returnTo={PAGE} confirm={`Confirm ${s.name}'s terms permit automated collection by Made4Buyers (written permission on file)?`} />
                    )}
                    <ActionForm
                      action="/api/admin/commerce/coupons"
                      fields={{ action: "toggle-source", id: s.id }}
                      label={s.enabled ? "Disable" : "Enable"}
                      returnTo={PAGE}
                      disabledReason={!s.enabled && s.termsStatus !== "APPROVED" ? "Record the terms as APPROVED first" : undefined}
                    />
                  </div>
                </td>
              </tr>
            ))}
            {!sources.length && (
              <tr>
                <td colSpan={5}>No coupon sources on file. Import the source list to record the known third-party sites (disabled).</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2>Recent coupon runs</h2>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Brand / source</th>
              <th scope="col">Status</th>
              <th scope="col" className="num">
                Pages
              </th>
              <th scope="col" className="num">
                Codes
              </th>
              <th scope="col">Notes</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td data-label="Started">{when(r.startedAt)}</td>
                <td data-label="Brand / source">{r.brand?.name ?? r.source?.name ?? "—"}</td>
                <td data-label="Status">
                  <Badge value={r.status} tone={r.status === "COLLECTED" ? "ok" : /FAIL|DISALLOWED|DISABLED/.test(r.status) ? "error" : "neutral"} />
                </td>
                <td className="num" data-label="Pages">
                  {r.pagesProcessed ?? "—"}
                </td>
                <td className="num" data-label="Codes">
                  {r.accepted ?? "—"}
                </td>
                <td data-label="Notes">
                  <span className="small muted">
                    {Array.isArray(r.errors)
                      ? (r.errors as Array<Record<string, unknown>>)
                          .slice(0, 3)
                          .map((e) => [e.url, e.reason ?? e.message].filter(Boolean).join(": "))
                          .join(" · ")
                      : ""}
                  </span>
                </td>
              </tr>
            ))}
            {!runs.length && (
              <tr>
                <td colSpan={6}>No coupon runs yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
