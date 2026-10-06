import Link from "next/link";
import Flash from "@/components/flash";
import { Badge, Stat, when } from "@/components/admin-ui";
import { getAffiliateProvider } from "@/lib/affiliate/provider";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { freshSince } from "@/lib/public/offers";

export const dynamic = "force-dynamic";
export const metadata = { title: "Retailer links" };

const STATUSES = ["FRESH", "STALE"] as const;

/** Seller links stored by the commerce engine: plain retailer URLs unless an affiliate provider set one. */
export default async function LinksPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const status = (STATUSES as readonly string[]).includes(param(sp, "status") ?? "") ? param(sp, "status") : undefined;
  const since = freshSince();
  const provider = getAffiliateProvider();
  const [byStatus, byAffiliate, shownNow, offers] = await Promise.all([
    db.commerceOffer.groupBy({ by: ["status"], _count: { _all: true } }),
    db.commerceOffer.groupBy({ by: ["affiliateStatus"], _count: { _all: true } }),
    db.commerceOffer.count({ where: { status: "FRESH", observedAt: { gte: since }, product: { productEntityId: { not: null } } } }),
    db.commerceOffer.findMany({
      where: status ? { status } : {},
      orderBy: [{ observedAt: "desc" }],
      take: 100,
      select: { id: true, seller: true, sellerType: true, destinationUrl: true, affiliateUrl: true, affiliateStatus: true, price: true, currency: true, status: true, observedAt: true, product: { select: { name: true, productEntityId: true } } },
    }),
  ]);
  const count = (s: string) => byStatus.find((c) => c.status === s)?._count._all ?? 0;

  return (
    <>
      <h1>Retailer links</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p className="muted">
        Seller links come from the commerce engine. Affiliate provider: <strong>{provider.name}</strong>
        {provider.active ? " (links may carry provider-generated affiliate URLs)." : " — every link is the retailer’s own URL, with no tracking added."} A price is shown publicly only while observed within {config.commerce.priceMaxAgeHours()} hours.
      </p>
      <div className="stats">
        <Stat label="Shown now" value={shownNow} note="fresh, attached to a product" />
        {STATUSES.map((s) => (
          <Stat key={s} label={s} value={count(s)} />
        ))}
        {byAffiliate.map((a) => (
          <Stat key={a.affiliateStatus} label={`Affiliate ${a.affiliateStatus}`} value={a._count._all} />
        ))}
      </div>

      <h2>Recent offers</h2>
      <nav aria-label="Offer status filter">
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
              <th scope="col">Product</th>
              <th scope="col">Seller</th>
              <th scope="col">Status</th>
              <th scope="col">Link</th>
              <th scope="col">Observed</th>
            </tr>
          </thead>
          <tbody>
            {offers.map((o) => (
              <tr key={o.id}>
                <td data-label="Product">
                  {o.product.name} {!o.product.productEntityId && <Badge value="UNMATCHED" tone="warn" />}
                </td>
                <td data-label="Seller">
                  {o.seller} <span className="small muted">({o.sellerType.toLowerCase()})</span>
                </td>
                <td data-label="Status">
                  <Badge value={o.status} />
                </td>
                <td data-label="Link" className="small" style={{ wordBreak: "break-all" }}>
                  {o.affiliateUrl ? <Badge value="AFFILIATED" tone="ok" /> : <Badge value="PLAIN" tone="neutral" />} {o.destinationUrl}
                </td>
                <td data-label="Observed">{when(o.observedAt)}</td>
              </tr>
            ))}
            {!offers.length && (
              <tr>
                <td colSpan={5}>No commerce offers stored yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
