import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { Badge, Pager, safeHref, Stat, when } from "@/components/admin-ui";
import Flash from "@/components/flash";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { listPriceLabelFor, NOT_CLASSIFIED_LABEL, parseDealReasons } from "@/lib/commerce/admin-queries";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "Commerce products" };

const PAGE_SIZE = 40;
type Tone = "ok" | "warn" | "error" | "info" | "neutral";
const TONE: Record<string, Tone> = { MATCHED: "ok", MATCH_REJECTED: "error", UNMATCHED: "neutral", FRESH: "ok", STALE: "warn" };
const DEAL_TONE: Record<string, Tone> = { ACTIVE: "ok", VERIFIED: "info", EXPIRED: "neutral", BROKEN: "error", CONFLICTING: "warn", UNVERIFIED: "warn", INVALID: "error" };
const LINK_TONE: Record<string, Tone> = { OK: "ok", REDIRECTED_SAME_SITE: "ok", UNCHECKED: "neutral", BROKEN: "error", OFF_SITE: "error", UNREACHABLE: "error", BLOCKED: "warn" };
const OFFICIAL_TONE: Record<string, Tone> = { VERIFIED: "ok", MISMATCH: "error", NOT_FOUND: "warn", UNVERIFIED: "warn" };

/** Persisted deal status (never computed here); null → "Not classified yet". */
function DealStatusCell({ status, at }: { status: string | null; at: Date | null }) {
  return status ? (
    <>
      <Badge value={status} tone={DEAL_TONE[status] ?? "neutral"} />
      {at && <div className="small muted">{when(at)}</div>}
    </>
  ) : (
    <span className="small muted">{NOT_CLASSIFIED_LABEL}</span>
  );
}

function OfficialCell({ entityId, status }: { entityId: string | null; status: string | null | undefined }) {
  if (!entityId) return <span className="small muted">Not attached</span>;
  return <Badge value={status ?? "NOT CHECKED"} tone={status ? (OFFICIAL_TONE[status] ?? "neutral") : "neutral"} />;
}
const IDENTITY = ["MATCHED", "MATCH_REJECTED", "UNMATCHED"];

const host = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};
const money = (price: number | null, currency: string | null) => (price == null ? "—" : `${currency ?? ""} ${price.toFixed(2)}`.trim());

/** Admin → Commerce products: identity decisions, best fresh price, and full provenance per product. */
export default async function CommerceProductsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const identity = param(sp, "identity") ?? "";
  const brand = param(sp, "brand") ?? "";
  const freshness = param(sp, "freshness") ?? "";
  const id = param(sp, "id");
  const page = Math.max(1, Number(param(sp, "page")) || 1);

  const where: Prisma.CommerceProductWhereInput = {
    ...(identity ? { identityStatus: identity } : {}),
    ...(brand ? { brandId: brand } : {}),
    ...(freshness === "FRESH" ? { offers: { some: { status: "FRESH" } } } : freshness === "STALE" ? { offers: { some: {}, none: { status: "FRESH" } } } : freshness === "NONE" ? { offers: { none: {} } } : {}),
  };

  const [brands, byIdentity, total, rows, detail] = await Promise.all([
    db.commerceBrand.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.commerceProduct.groupBy({ by: ["identityStatus"], _count: { _all: true } }),
    db.commerceProduct.count({ where }),
    db.commerceProduct.findMany({
      where,
      orderBy: { observedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        brand: { select: { name: true } },
        offers: { orderBy: [{ status: "asc" }, { price: { sort: "asc", nulls: "last" } }, { observedAt: "desc" }], take: 10 },
      },
    }),
    id ? db.commerceProduct.findUnique({ where: { id }, include: { brand: { select: { name: true, officialDomain: true } }, offers: { orderBy: [{ status: "asc" }, { observedAt: "desc" }] } } }) : Promise.resolve(null),
  ]);
  const ids = rows.map((r) => r.id);
  const [latestLogs, entities, detailRaw, detailLogs, detailEntity] = await Promise.all([
    ids.length ? db.commerceMatchLog.findMany({ where: { commerceProductId: { in: ids } }, orderBy: { createdAt: "desc" }, distinct: ["commerceProductId"] }) : Promise.resolve([]),
    db.productEntity.findMany({ where: { id: { in: rows.map((r) => r.productEntityId).filter(Boolean) as string[] } }, select: { id: true, name: true, officialStatus: true, officialVerifiedAt: true } }),
    detail?.lastRawId ? db.commerceRawRecord.findUnique({ where: { id: detail.lastRawId } }) : Promise.resolve(null),
    detail ? db.commerceMatchLog.findMany({ where: { commerceProductId: detail.id }, orderBy: { createdAt: "desc" }, take: 100 }) : Promise.resolve([]),
    detail?.productEntityId ? db.productEntity.findUnique({ where: { id: detail.productEntityId }, select: { id: true, name: true, officialStatus: true, officialUrl: true, officialVerifiedAt: true } }) : Promise.resolve(null),
  ]);
  const count = (s: string) => byIdentity.find((b) => b.identityStatus === s)?._count._all ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const qs = new URLSearchParams({ ...(identity ? { identity } : {}), ...(brand ? { brand } : {}), ...(freshness ? { freshness } : {}) }).toString();
  const base = `/admin/commerce/products${qs ? `?${qs}` : ""}`;
  const detailHref = (pid: string) => {
    const q = new URLSearchParams(qs);
    if (page > 1) q.set("page", String(page));
    q.set("id", pid);
    return `/admin/commerce/products?${q.toString()}`;
  };

  return (
    <>
      <h1>Commerce products</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p className="muted">
        Products read from official brand and retailer pages by the commerce engine. A product is attached to a Made4Buyers product only after an exact identity match (model, MPN or GTIN); every decision is logged with its reason. Prices are shown only from fresh offers. Deal status is the persisted classification (see <Link href="/admin/commerce/deals">Deals</Link>); official verification is the attached Made4Buyers product’s official-site status.
      </p>
      <div className="stats">
        <Stat label="Matched" value={count("MATCHED")} />
        <Stat label="Match rejected" value={count("MATCH_REJECTED")} />
        <Stat label="Unmatched" value={count("UNMATCHED")} />
      </div>

      <form className="toolbar" action="/admin/commerce/products">
        <div className="field">
          <label htmlFor="cp-identity">Identity</label>
          <select id="cp-identity" name="identity" defaultValue={identity}>
            <option value="">All</option>
            {IDENTITY.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="cp-brand">Brand</label>
          <select id="cp-brand" name="brand" defaultValue={brand}>
            <option value="">All</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="cp-fresh">Offer freshness</label>
          <select id="cp-fresh" name="freshness" defaultValue={freshness}>
            <option value="">All</option>
            <option value="FRESH">Has a fresh offer</option>
            <option value="STALE">Only stale offers</option>
            <option value="NONE">No offers</option>
          </select>
        </div>
        <button className="btn" type="submit">
          Filter
        </button>
      </form>

      {id && !detail && <p className="notice warn">No commerce product with id {id}.</p>}
      {detail && (
        <section aria-labelledby="cp-detail-h">
          <h2 id="cp-detail-h">
            {detail.name} <Badge value={detail.identityStatus} tone={TONE[detail.identityStatus] ?? "neutral"} />
          </h2>
          <p className="small">
            Brand {detail.brand?.name ?? "—"} · Model {detail.model ?? "—"} · MPN {detail.mpn ?? "—"} · SKU {detail.sku ?? "—"} · GTIN {detail.gtin ?? "—"} · Category {detail.category ?? "—"}
            <br />
            Canonical URL:{" "}
            <a href={safeHref(detail.canonicalUrl)} rel="noopener noreferrer nofollow" target="_blank">
              {detail.canonicalUrl}
            </a>{" "}
            · observed {when(detail.observedAt)}
            <br />
            Official verification: <OfficialCell entityId={detail.productEntityId} status={detailEntity?.officialStatus} />
            {detailEntity?.officialVerifiedAt && <> checked {when(detailEntity.officialVerifiedAt)}</>}
            {detailEntity?.officialUrl && (
              <>
                {" "}
                ·{" "}
                <a href={safeHref(detailEntity.officialUrl)} rel="noopener noreferrer nofollow" target="_blank">
                  official page
                </a>
              </>
            )}
            <br />
            Identity: {detail.identityReason ?? "no reason recorded"}
            {detailEntity && (
              <>
                {" "}
                · attached to <Link href={`/admin/products?id=${detailEntity.id}`}>{detailEntity.name}</Link>
              </>
            )}
            {!detailEntity && detail.productEntityId && (
              <>
                {" "}
                · attached to <Link href={`/admin/products?id=${detail.productEntityId}`}>{detail.productEntityId}</Link>
              </>
            )}
          </p>

          <h3>Offers ({detail.offers.length})</h3>
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  <th scope="col">Seller</th>
                  <th scope="col">URL</th>
                  <th scope="col" className="num">Price</th>
                  <th scope="col" className="num">Previous price</th>
                  <th scope="col">Availability</th>
                  <th scope="col">Last checked</th>
                  <th scope="col">Status</th>
                  <th scope="col">Deal status</th>
                  <th scope="col">Provenance</th>
                </tr>
              </thead>
              <tbody>
                {detail.offers.map((o) => (
                  <tr key={o.id}>
                    <td data-label="Seller">
                      {o.seller}
                      <div className="small muted">{o.sellerType}</div>
                    </td>
                    <td data-label="URL" className="small" style={{ wordBreak: "break-all" }}>
                      <a href={safeHref(o.destinationUrl)} rel="noopener noreferrer nofollow" target="_blank">
                        {o.destinationUrl}
                      </a>
                      {o.affiliateUrl && <div className="muted">affiliate ({o.affiliateProvider ?? "?"}, {o.affiliateStatus})</div>}
                    </td>
                    <td data-label="Price" className="num">
                      {money(o.price, o.currency)}
                    </td>
                    <td data-label="Previous price" className="num">
                      {o.listPrice != null ? (
                        <>
                          {money(o.listPrice, o.currency)}
                          <div className="small muted">{parseDealReasons(o.dealStatusReasons).listPriceLabel ?? listPriceLabelFor(detail.data, o)}</div>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td data-label="Availability" className="small">
                      {o.availability ?? "—"}
                      {o.shipping && <div className="muted">{o.shipping}</div>}
                    </td>
                    <td data-label="Last checked" className="small">
                      price {when(o.observedAt)}
                      <div>
                        link <Badge value={o.linkStatus} tone={LINK_TONE[o.linkStatus] ?? "neutral"} /> {o.linkCheckedAt ? when(o.linkCheckedAt) : "not checked"}
                      </div>
                    </td>
                    <td data-label="Status">
                      <Badge value={o.status} tone={TONE[o.status] ?? "neutral"} />
                    </td>
                    <td data-label="Deal status" className="small">
                      <DealStatusCell status={o.dealStatus} at={o.dealStatusAt} />
                      {parseDealReasons(o.dealStatusReasons).reasons.map((r, i) => (
                        <div key={`${r.code}-${i}`} className="muted" title={r.message ?? undefined}>
                          {r.label}
                        </div>
                      ))}
                    </td>
                    <td data-label="Provenance" className="small">
                      {o.sourceRawId ? <code>raw {o.sourceRawId}</code> : "—"}
                    </td>
                  </tr>
                ))}
                {!detail.offers.length && (
                  <tr>
                    <td colSpan={9}>No offers recorded.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <h3>Latest raw record</h3>
          {detailRaw ? (
            <details>
              <summary className="small">
                {detailRaw.purpose} · {detailRaw.url} · fetched {when(detailRaw.fetchedAt)} · run <code>{detailRaw.runId}</code> · hash <code>{detailRaw.contentHash.slice(0, 12)}</code>
              </summary>
              <pre className="small" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 480, overflow: "auto" }}>
                {JSON.stringify(detailRaw.payload, null, 2)}
              </pre>
            </details>
          ) : (
            <p className="small muted">{detail.lastRawId ? `Raw record ${detail.lastRawId} is no longer stored.` : "No raw record linked."}</p>
          )}

          <h3>Identity decisions ({detailLogs.length})</h3>
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Result</th>
                  <th scope="col">Basis</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Made4Buyers product</th>
                </tr>
              </thead>
              <tbody>
                {detailLogs.map((l) => (
                  <tr key={l.id}>
                    <td data-label="When" className="small">
                      {when(l.createdAt)}
                    </td>
                    <td data-label="Result">
                      <Badge value={l.result} tone={TONE[l.result] ?? "neutral"} />
                    </td>
                    <td data-label="Basis" className="small">
                      {l.basis ?? "—"}
                    </td>
                    <td data-label="Reason" className="small">
                      {l.reason}
                    </td>
                    <td data-label="Made4Buyers product" className="small">
                      {l.productEntityId ? <Link href={`/admin/products?id=${l.productEntityId}`}>{l.productEntityId}</Link> : "—"}
                    </td>
                  </tr>
                ))}
                {!detailLogs.length && (
                  <tr>
                    <td colSpan={5}>No identity decisions logged.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <h2 id="cp-list-h">
        Products <span className="muted small">({total})</span>
      </h2>
      <div className="table-wrap">
        <table className="table responsive" aria-labelledby="cp-list-h">
          <thead>
            <tr>
              <th scope="col">Brand</th>
              <th scope="col">Product</th>
              <th scope="col">Model / MPN / GTIN</th>
              <th scope="col">Identity</th>
              <th scope="col">Best fresh price</th>
              <th scope="col">Previous price</th>
              <th scope="col">Deal status</th>
              <th scope="col">Last checked</th>
              <th scope="col">Official</th>
              <th scope="col">Freshness</th>
              <th scope="col">Source / basis</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const best = p.offers.filter((o) => o.status === "FRESH" && o.price != null).sort((a, b) => (a.price ?? 0) - (b.price ?? 0))[0];
              const latest = [...p.offers].sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())[0];
              const shown = best ?? latest;
              const fresh = best ? "FRESH" : p.offers.some((o) => o.status === "FRESH") ? "FRESH" : latest ? latest.status : null;
              const log = latestLogs.find((l) => l.commerceProductId === p.id);
              const entity = entities.find((e) => e.id === p.productEntityId);
              return (
                <tr key={p.id}>
                  <td data-label="Brand">{p.brand?.name ?? "—"}</td>
                  <td data-label="Product">
                    <Link href={detailHref(p.id)}>{p.name}</Link>
                    <div className="small muted">{p.category ?? ""}</div>
                  </td>
                  <td data-label="Model / MPN / GTIN" className="small">
                    {[p.model, p.mpn, p.gtin].map((v) => v ?? "—").join(" / ")}
                  </td>
                  <td data-label="Identity" className="small">
                    <Badge value={p.identityStatus} tone={TONE[p.identityStatus] ?? "neutral"} />
                    {p.identityReason && <div className="muted">{p.identityReason}</div>}
                    {p.identityStatus === "MATCHED" && p.productEntityId && (
                      <div>
                        <Link href={`/admin/products?id=${p.productEntityId}`}>{entity?.name ?? "Made4Buyers product"}</Link>
                      </div>
                    )}
                  </td>
                  <td data-label="Best fresh price" className="small">
                    {best ? (
                      <>
                        <strong>{money(best.price, best.currency)}</strong> at {best.seller}
                        <div className="muted">
                          {best.availability ?? "availability unknown"} · {when(best.observedAt)}
                        </div>
                      </>
                    ) : shown ? (
                      <span className="muted">
                        No fresh price (last: {money(shown.price, shown.currency)} at {shown.seller}, {when(shown.observedAt)})
                      </span>
                    ) : (
                      <span className="muted">No offers</span>
                    )}
                  </td>
                  <td data-label="Previous price" className="small">
                    {shown?.listPrice != null ? (
                      <>
                        {money(shown.listPrice, shown.currency)}
                        <div className="muted">{parseDealReasons(shown.dealStatusReasons).listPriceLabel ?? listPriceLabelFor(p.data, shown)}</div>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td data-label="Deal status">{shown ? <DealStatusCell status={shown.dealStatus} at={null} /> : "—"}</td>
                  <td data-label="Last checked" className="small">
                    {shown ? (
                      <>
                        {when(shown.observedAt)}
                        <div className="muted">link {shown.linkCheckedAt ? `${shown.linkStatus} ${when(shown.linkCheckedAt)}` : "not checked"}</div>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td data-label="Official">
                    <OfficialCell entityId={p.productEntityId} status={entity?.officialStatus} />
                  </td>
                  <td data-label="Freshness">{fresh ? <Badge value={fresh} tone={TONE[fresh] ?? "neutral"} /> : "—"}</td>
                  <td data-label="Source / basis" className="small">
                    {host(p.canonicalUrl)}
                    <div className="muted">{log ? `${log.result}${log.basis ? ` by ${log.basis}` : ""}` : "no decision logged"}</div>
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={11}>{qs ? "No products match these filters." : "No commerce products yet: they appear after the first collection run."}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={page} pages={pages} base={base} />
    </>
  );
}
