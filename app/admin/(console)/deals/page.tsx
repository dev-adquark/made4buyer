import type { DealStatus } from "@prisma/client";
import Link from "next/link";
import { BarList } from "@/components/charts";
import Flash from "@/components/flash";
import { categoryName } from "@/lib/taxonomy/definitions";
import { ActionForm, Badge, Stat, when } from "@/components/admin-ui";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { integrationStatus } from "@/lib/config";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "Deals" };

const STATUSES: DealStatus[] = ["MATCHED", "NO_MATCH", "STALE", "FAILED", "UNAVAILABLE", "PENDING"];

export default async function DealsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const status = STATUSES.includes(param(sp, "status") as DealStatus) ? (param(sp, "status") as DealStatus) : undefined;
  const [counts, reviews] = await Promise.all([
    db.normalizedReview.groupBy({ by: ["dealStatus"], where: { status: { not: "REJECTED" } }, _count: { _all: true } }),
    db.normalizedReview.findMany({
      where: { status: { not: "REJECTED" }, ...(status ? { dealStatus: status } : {}) },
      orderBy: { dealCheckedAt: { sort: "desc", nulls: "last" } },
      take: 100,
      select: {
        id: true,
        canonicalTitle: true,
        productName: true,
        status: true,
        dealStatus: true,
        dealStatusReason: true,
        dealCheckedAt: true,
        sovrnDealIdOverride: true,
        offerMatches: { where: { isBestOffer: true }, take: 1 },
        affiliateLinks: { where: { isActive: true, isBest: true }, take: 1, select: { verificationStatus: true } },
      },
    }),
  ]);
  const count = (s: string) => counts.find((c) => c.dealStatus === s)?._count._all ?? 0;
  const [byCategory, verifiedByCategory, providerStates, unmatched] = await Promise.all([
    db.normalizedReview.groupBy({ by: ["categorySlug"], where: { status: "PUBLISHED" }, _count: { _all: true } }),
    db.normalizedReview.groupBy({ by: ["categorySlug"], where: { status: "PUBLISHED", affiliateLinks: { some: { isActive: true, verificationStatus: "VERIFIED_OK", offerMatch: { matchStatus: "MATCHED" } } } }, _count: { _all: true } }),
    db.sovrnOfferCache.groupBy({ by: ["providerStatus"], _count: { _all: true } }),
    db.normalizedReview.findMany({ where: { status: "PUBLISHED", affiliateLinks: { none: { isActive: true, verificationStatus: "VERIFIED_OK" } } }, select: { id: true, productName: true, categorySlug: true, dealStatus: true, dealStatusReason: true }, orderBy: { productName: "asc" }, take: 50 }),
  ]);
  const coverage = byCategory
    .map((c) => {
      const verified = verifiedByCategory.find((v) => v.categorySlug === c.categorySlug)?._count._all ?? 0;
      return { slug: c.categorySlug, published: c._count._all, verified, ratio: c._count._all ? verified / c._count._all : 0 };
    })
    .sort((a, b) => a.ratio - b.ratio);
  const sovrn = integrationStatus().sovrn;

  return (
    <>
      <h1>Deals</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      {sovrn !== "READY" && <p className="notice warn">Sovrn is BLOCKED_BY_ENVIRONMENT: set SOVRN_API_URL and SOVRN_API_KEY (and SOVRN_SITE_KEY for link wrapping). No offers are fabricated while it is unavailable.</p>}
      <div className="stats">
        {STATUSES.map((s) => (
          <Stat key={s} label={s} value={count(s)} />
        ))}
      </div>
      <div className="chart-grid">
        <section className="chart-card" aria-labelledby="cov-cat">
          <h2 id="cov-cat">Verified coverage by category</h2>
          <p className="small muted">Published reviews with a verified offer, weakest first.</p>
          <BarList label="Verified coverage by category (%)" unit="%" data={coverage.map((c) => ({ label: `${categoryName(c.slug) ?? "No category"} (${c.verified}/${c.published})`, value: Math.round(c.ratio * 100), tone: c.ratio >= 0.7 ? "ok" : c.ratio >= 0.4 ? "warn" : "error" }))} />
        </section>
        <section className="chart-card" aria-labelledby="prov-state">
          <h2 id="prov-state">Sovrn response states</h2>
          <p className="small muted">Cached provider responses by outcome.</p>
          <BarList label="Sovrn responses by status" data={providerStates.map((p) => ({ label: p.providerStatus, value: p._count._all, tone: p.providerStatus === "OK" ? "ok" : p.providerStatus === "EMPTY" ? "warn" : "error" }))} />
        </section>
      </div>
      {unmatched.length > 0 && (
        <details className="card card-body" style={{ marginBottom: 16 }}>
          <summary>Published reviews without a verified offer ({unmatched.length}{unmatched.length === 50 ? "+" : ""})</summary>
          <ul>
            {unmatched.map((u) => (
              <li key={u.id}>
                <Link href={`/admin/reviews/${u.id}`}>{u.productName}</Link> ({categoryName(u.categorySlug) ?? "no category"}) <Badge value={u.dealStatus} /> <span className="small muted">{u.dealStatusReason ?? ""}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="btnrow">
        <ActionForm action="/api/admin/jobs" fields={{ job: "revalidate-offers" }} label="Refresh stale offers" returnTo="/admin/deals" disabledReason={sovrn === "READY" ? undefined : "Sovrn not configured"} />
      </div>
      <nav aria-label="Deal status filter">
        <ul className="chips">
          <li>
            <Link className="chip neutral" href="/admin/deals" aria-current={!status ? "true" : undefined}>
              All
            </Link>
          </li>
          {STATUSES.map((s) => (
            <li key={s}>
              <Link className="chip neutral" href={`/admin/deals?status=${s}`} aria-current={status === s ? "true" : undefined}>
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
              <th scope="col">Deal status</th>
              <th scope="col">Best offer</th>
              <th scope="col">Merchant</th>
              <th scope="col" className="num">Price</th>
              <th scope="col" className="num">Score</th>
              <th scope="col">Link</th>
              <th scope="col">Checked</th>
            </tr>
          </thead>
          <tbody>
            {reviews.map((r) => {
              const best = r.offerMatches[0];
              return (
                <tr key={r.id}>
                  <td data-label="Review">
                    <Link href={`/admin/reviews/${r.id}`}>{r.productName}</Link>
                    <div className="small muted">
                      <Badge value={r.status} />
                      {r.sovrnDealIdOverride ? ` · override ${r.sovrnDealIdOverride}` : ""}
                    </div>
                  </td>
                  <td data-label="Deal status">
                    <Badge value={r.dealStatus} />
                    <div className="small muted">{r.dealStatusReason}</div>
                  </td>
                  <td data-label="Best offer" className="small">{best ? `${best.title} (${best.offerId})` : "—"}</td>
                  <td data-label="Merchant">{best?.merchantName ?? "—"}</td>
                  <td data-label="Price" className="num">{best?.price != null ? `${best.price} ${best.currency ?? ""}` : "—"}</td>
                  <td data-label="Score" className="num">{best ? best.score.toFixed(3) : "—"}</td>
                  <td data-label="Link">
                    <Badge value={r.affiliateLinks[0]?.verificationStatus ?? "NO LINK"} />
                  </td>
                  <td data-label="Checked">{when(r.dealCheckedAt)}</td>
                </tr>
              );
            })}
            {!reviews.length && (
              <tr>
                <td colSpan={8}>No reviews in this view.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
