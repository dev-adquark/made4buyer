import Link from "next/link";
import { Badge, Pager, safeHref, when } from "@/components/admin-ui";
import Flash from "@/components/flash";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { couponStatusCounts, isDealReason, isDealStatus, listDeals, NOT_CLASSIFIED_LABEL, pageCount, parsePaging, persistedDealStatusCounts, UNCLASSIFIED } from "@/lib/commerce/admin-queries";
import { DEAL_REASON_LABEL, DEAL_STATUSES, type DealReasonCode } from "@/lib/commerce/deal-status";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "Commerce deals" };

const PAGE = "/admin/commerce/deals";
const PAGE_SIZE = 40;

type Tone = "ok" | "warn" | "error" | "info" | "neutral";
const DEAL_TONE: Record<string, Tone> = { ACTIVE: "ok", VERIFIED: "info", EXPIRED: "neutral", BROKEN: "error", CONFLICTING: "warn", UNVERIFIED: "warn", INVALID: "error" };
const LINK_TONE: Record<string, Tone> = { OK: "ok", REDIRECTED_SAME_SITE: "ok", UNCHECKED: "neutral", BROKEN: "error", OFF_SITE: "error", UNREACHABLE: "error", BLOCKED: "warn" };
const OFFICIAL_TONE: Record<string, Tone> = { VERIFIED: "ok", MISMATCH: "error", NOT_FOUND: "warn", UNVERIFIED: "warn" };
const COUPON_TONE: Record<string, Tone> = { VERIFIED: "ok", UNVERIFIED: "warn", UNKNOWN: "neutral", CONFLICTING: "warn", EXPIRED: "neutral", INVALID: "error" };
const EVENT_TONE = (r: string): Tone => (/^(OK|VERIFIED|ACTIVE|MATCH(ED)?|SAME|REDIRECTED_SAME_SITE)$/.test(r) ? "ok" : /BROKEN|INVALID|MISMATCH|OFF_SITE|UNREACHABLE|FAIL/.test(r) ? "error" : "neutral");
const money = (v: number | null, currency: string | null) => (v == null ? "—" : `${currency ?? ""} ${v.toFixed(2)}`.trim());

/**
 * Admin → Commerce → Deals: every stored offer by its persisted deal status (ACTIVE … INVALID), why,
 * and the latest verification checks. The status is shown exactly as the classifier stored it; an
 * offer it has not classified yet says so (nothing is computed here).
 */
export default async function CommerceDealsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const statusParam = param(sp, "status")?.toUpperCase();
  const status = statusParam === UNCLASSIFIED || isDealStatus(statusParam) ? statusParam : undefined;
  const brandId = param(sp, "brand")?.slice(0, 40) || undefined;
  const reasonParam = param(sp, "reason");
  const reason = isDealReason(reasonParam) ? reasonParam : undefined;
  const paging = parsePaging((k) => (k === "limit" ? String(PAGE_SIZE) : param(sp, k)), PAGE_SIZE);

  const [counts, brands, deals, coupons] = await Promise.all([
    persistedDealStatusCounts(brandId ? { product: { brandId } } : {}),
    db.commerceBrand.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    listDeals({ status, brandId, reason }, paging),
    couponStatusCounts(),
  ]);
  const totalOffers = Object.values(counts).reduce((a, b) => a + b, 0);
  const pages = pageCount(deals.total, PAGE_SIZE);
  const keep = (over: Record<string, string | undefined>) => {
    const q = new URLSearchParams(Object.entries({ status, brand: brandId, reason, ...over }).filter((e): e is [string, string] => Boolean(e[1])));
    const s = q.toString();
    return `${PAGE}${s ? `?${s}` : ""}`;
  };
  const tabs: Array<{ key: string | undefined; label: string; count: number }> = [
    { key: undefined, label: "All", count: totalOffers },
    ...DEAL_STATUSES.map((s) => ({ key: s, label: s, count: counts[s] ?? 0 })),
    { key: UNCLASSIFIED, label: NOT_CLASSIFIED_LABEL, count: counts[UNCLASSIFIED] ?? 0 },
  ];
  const couponTotal = coupons.reduce((a, c) => a + c.count, 0);

  return (
    <>
      <h1>Commerce deals</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p className="muted">
        Every stored offer by its deal status, as last persisted by the deal classifier (lib/commerce/deal-status.ts, the rules /deals uses). Only ACTIVE offers are shown publicly. “{NOT_CLASSIFIED_LABEL}” means the classifier has not stored a status for that offer yet. Prices, previous prices and savings are the values
        the page stated; the previous-price label is how the page labelled it.
      </p>

      <nav className="btnrow" aria-label="Deal status">
        {tabs.map((t) => (
          <a key={t.key ?? "all"} className={`btn small${status === t.key ? " primary" : ""}`} href={keep({ status: t.key, page: undefined })} aria-current={status === t.key ? "page" : undefined}>
            {t.label} <span className="muted">({t.count})</span>
          </a>
        ))}
      </nav>

      <form className="toolbar" action={PAGE}>
        {status && <input type="hidden" name="status" value={status} />}
        <div className="field">
          <label htmlFor="cd-brand">Brand</label>
          <select id="cd-brand" name="brand" defaultValue={brandId ?? ""}>
            <option value="">All</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="cd-reason">Reason</label>
          <select id="cd-reason" name="reason" defaultValue={reason ?? ""}>
            <option value="">Any</option>
            {(Object.keys(DEAL_REASON_LABEL) as DealReasonCode[]).map((code) => (
              <option key={code} value={code}>
                {DEAL_REASON_LABEL[code]} ({code})
              </option>
            ))}
          </select>
        </div>
        <button className="btn" type="submit">
          Filter
        </button>
        {(brandId || reason) && (
          <a className="btn" href={keep({ brand: undefined, reason: undefined })}>
            Clear filters
          </a>
        )}
      </form>

      <h2 id="cd-list-h">
        {status === UNCLASSIFIED ? NOT_CLASSIFIED_LABEL : (status ?? "All offers")} <span className="muted small">({deals.total})</span>
      </h2>
      <div className="table-wrap">
        <table className="table responsive" aria-labelledby="cd-list-h">
          <thead>
            <tr>
              <th scope="col">Product</th>
              <th scope="col">Seller</th>
              <th scope="col" className="num">
                Price
              </th>
              <th scope="col" className="num">
                Previous price
              </th>
              <th scope="col" className="num">
                Saving
              </th>
              <th scope="col">Deal status</th>
              <th scope="col">Link</th>
              <th scope="col">Official</th>
              <th scope="col">Last checked</th>
              <th scope="col">Latest verification</th>
            </tr>
          </thead>
          <tbody>
            {deals.items.map((d) => (
              <tr key={d.id}>
                <td data-label="Product">
                  <Link href={`/admin/commerce/products?id=${encodeURIComponent(d.product.id)}`}>{d.product.name}</Link>
                  <div className="small muted">{d.brand?.name ?? "No brand"}</div>
                </td>
                <td data-label="Seller" className="small">
                  {d.seller}
                  <div className="muted">{d.sellerType}</div>
                  <a href={safeHref(d.destinationUrl)} rel="noopener noreferrer nofollow" target="_blank" className="muted" style={{ wordBreak: "break-all" }}>
                    {(() => {
                      try {
                        return new URL(d.destinationUrl).hostname;
                      } catch {
                        return "link";
                      }
                    })()}
                  </a>
                </td>
                <td data-label="Price" className="num">
                  {money(d.price, d.currency)}
                  {d.availability && <div className="small muted">{d.availability.replace(/^https?:\/\/schema\.org\//, "")}</div>}
                </td>
                <td data-label="Previous price" className="num">
                  {d.listPrice != null ? (
                    <>
                      {money(d.listPrice, d.currency)}
                      <div className="small muted">{d.listPriceLabel}</div>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td data-label="Saving" className="num">
                  {d.saving ? (
                    <>
                      {money(d.saving.amount, d.currency)}
                      <div className="small muted">{d.saving.percent}%</div>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td data-label="Deal status" className="small">
                  {d.dealStatus ? <Badge value={d.dealStatus} tone={DEAL_TONE[d.dealStatus] ?? "neutral"} /> : <span className="muted">{NOT_CLASSIFIED_LABEL}</span>}
                  {d.dealStatusAt && <div className="muted">{when(d.dealStatusAt)}</div>}
                  {d.reasons.length > 0 && (
                    <ul className="muted" style={{ margin: "4px 0 0", paddingLeft: 16 }}>
                      {d.reasons.map((r, i) => (
                        <li key={`${r.code}-${i}`} title={r.message ?? undefined}>
                          {r.label}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td data-label="Link" className="small">
                  <Badge value={d.linkStatus} tone={LINK_TONE[d.linkStatus] ?? "neutral"} />
                  {d.linkCheckedAt && <div className="muted">{when(d.linkCheckedAt)}</div>}
                </td>
                <td data-label="Official" className="small">
                  {d.product.productEntityId ? <Badge value={d.officialStatus ?? "NOT CHECKED"} tone={d.officialStatus ? (OFFICIAL_TONE[d.officialStatus] ?? "neutral") : "neutral"} /> : <span className="muted">Not attached</span>}
                </td>
                <td data-label="Last checked" className="small">
                  {when(d.observedAt)}
                  <div className="muted">price read</div>
                </td>
                <td data-label="Latest verification" className="small">
                  {d.events.length ? (
                    d.events.map((e, i) => (
                      <div key={i} title={e.reason ?? undefined}>
                        {e.kind} <Badge value={e.result} tone={EVENT_TONE(e.result)} /> <span className="muted">{when(e.checkedAt)}</span>
                      </div>
                    ))
                  ) : (
                    <span className="muted">No checks recorded</span>
                  )}
                </td>
              </tr>
            ))}
            {!deals.items.length && (
              <tr>
                <td colSpan={10}>{totalOffers ? "No offers match these filters." : "No offers stored yet: they appear after the first collection run."}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={Math.min(paging.page, pages)} pages={pages} base={keep({})} />

      <h2 id="cd-coupons-h">Promo codes by status</h2>
      <p className="small muted">Coupon status as stored ({couponTotal} code{couponTotal === 1 ? "" : "s"}). Codes are reviewed and managed in Coupons.</p>
      {coupons.length ? (
        <div className="btnrow">
          {coupons.map((c) => (
            <Link key={c.status} className="btn small" href={`/admin/commerce/coupons?status=${encodeURIComponent(c.status)}`}>
              <Badge value={c.status} tone={COUPON_TONE[c.status] ?? "neutral"} /> {c.count}
            </Link>
          ))}
        </div>
      ) : (
        <p className="small muted">No promo codes stored yet.</p>
      )}
    </>
  );
}
