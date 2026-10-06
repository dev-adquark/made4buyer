import type { DealStatus } from "@prisma/client";
import Link from "next/link";
import { BarList } from "@/components/charts";
import Flash from "@/components/flash";
import { categoryName } from "@/lib/taxonomy/definitions";
import { Badge, Stat, when } from "@/components/admin-ui";
import { getAffiliateProvider } from "@/lib/affiliate/provider";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { publishedFreshOffers } from "@/lib/public/offers";

export const dynamic = "force-dynamic";
export const metadata = { title: "Deals" };

const STATUSES: DealStatus[] = ["MATCHED", "NO_MATCH", "STALE", "FAILED", "UNAVAILABLE", "PENDING"];

/**
 * Price coverage from the commerce engine. A review's deal status is derived from the commerce
 * offers of its PRIMARY product (lib/pipeline/stages.ts runOfferStage); nothing here calls a provider.
 */
export default async function DealsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const status = STATUSES.includes(param(sp, "status") as DealStatus) ? (param(sp, "status") as DealStatus) : undefined;
  const [counts, reviews, byCategory, fresh] = await Promise.all([
    db.normalizedReview.groupBy({ by: ["dealStatus"], where: { status: { not: "REJECTED" } }, _count: { _all: true } }),
    db.normalizedReview.findMany({
      where: { status: { not: "REJECTED" }, ...(status ? { dealStatus: status } : {}) },
      orderBy: { dealCheckedAt: { sort: "desc", nulls: "last" } },
      take: 100,
      select: { id: true, productName: true, status: true, dealStatus: true, dealStatusReason: true, dealCheckedAt: true },
    }),
    db.normalizedReview.groupBy({ by: ["categorySlug"], where: { status: "PUBLISHED" }, _count: { _all: true } }),
    publishedFreshOffers(),
  ]);
  const count = (s: string) => counts.find((c) => c.dealStatus === s)?._count._all ?? 0;
  const bestByReview = new Map(fresh.map((o) => [o.review.id, o]));
  const pricedByCategory = new Map<string, number>();
  for (const o of fresh) pricedByCategory.set(o.review.categorySlug ?? "", (pricedByCategory.get(o.review.categorySlug ?? "") ?? 0) + 1);
  const coverage = byCategory
    .map((c) => {
      const priced = pricedByCategory.get(c.categorySlug ?? "") ?? 0;
      return { slug: c.categorySlug, published: c._count._all, priced, ratio: c._count._all ? priced / c._count._all : 0 };
    })
    .sort((a, b) => a.ratio - b.ratio);
  const provider = getAffiliateProvider();

  return (
    <>
      <h1>Deals</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p className="muted">
        Prices and seller links come from the commerce engine (official brand and retailer pages). A price is shown only while observed within {config.commerce.priceMaxAgeHours()} hours. Affiliate provider: <strong>{provider.name}</strong>
        {provider.active ? "." : " — retailer links stay plain."}
      </p>
      <div className="stats">
        <Stat label="Published with a fresh price" value={fresh.length} />
        {STATUSES.map((s) => (
          <Stat key={s} label={s} value={count(s)} />
        ))}
      </div>
      <div className="chart-grid">
        <section className="chart-card" aria-labelledby="cov-cat">
          <h2 id="cov-cat">Price coverage by category</h2>
          <p className="small muted">Published reviews with a fresh commerce price, weakest first.</p>
          <BarList label="Price coverage by category (%)" unit="%" data={coverage.map((c) => ({ label: `${categoryName(c.slug) ?? "No category"} (${c.priced}/${c.published})`, value: Math.round(c.ratio * 100), tone: c.ratio >= 0.7 ? "ok" : c.ratio >= 0.4 ? "warn" : "error" }))} />
        </section>
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
              <th scope="col">Best fresh price</th>
              <th scope="col">Seller</th>
              <th scope="col">Checked</th>
            </tr>
          </thead>
          <tbody>
            {reviews.map((r) => {
              const best = bestByReview.get(r.id);
              return (
                <tr key={r.id}>
                  <td data-label="Review">
                    <Link href={`/admin/reviews/${r.id}`}>{r.productName}</Link>
                    <div className="small muted">
                      <Badge value={r.status} />
                    </div>
                  </td>
                  <td data-label="Deal status">
                    <Badge value={r.dealStatus} />
                    <div className="small muted">{r.dealStatusReason}</div>
                  </td>
                  <td data-label="Best fresh price">{best?.price != null ? `${best.price} ${best.currency ?? ""}` : "—"}</td>
                  <td data-label="Seller">{best ? `${best.seller}${best.affiliated ? " (affiliate)" : ""}` : "—"}</td>
                  <td data-label="Checked">{when(r.dealCheckedAt)}</td>
                </tr>
              );
            })}
            {!reviews.length && (
              <tr>
                <td colSpan={5}>No reviews in this view.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
