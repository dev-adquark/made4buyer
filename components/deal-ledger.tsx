import Link from "next/link";
import DealImpression from "./deal-impression";
import SafeImg from "./safe-img";
import TrustLabel from "./trust-label";
import { placeholderPath } from "@/lib/pipeline/images";
import { cardImage, type DealRow } from "@/lib/public/queries";
import { categoryName } from "@/lib/taxonomy/definitions";
import { themeStyle } from "@/lib/taxonomy/themes";
import { availabilityLabel, dateline, money } from "@/lib/util/format";

/** One verified offer as a tear-off tag: product, price and merchant as reported, and when we checked. */
export function DealCard({ d, headingLevel = 3 }: { d: DealRow; headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  const r = d.review;
  const price = money(d.price, d.currency);
  return (
    <DealImpression linkId={d.linkId} reviewId={r.id} categorySlug={r.categorySlug}>
      <article className="deal-card" style={themeStyle(r.categorySlug) as React.CSSProperties}>
        <div className="dc-top">
          <span className="cat-tag">{categoryName(r.categorySlug) ?? "Technology"}</span>
          <TrustLabel kind="verified" />
        </div>
        <div className="dc-main">
          <SafeImg src={cardImage(r).url} fallback={placeholderPath(r.categorySlug)} alt="" width={84} height={84} loading="lazy" />
          <div>
            <H style={{ font: "inherit", margin: 0 }}>
              <Link className="dc-title" href={`/review/${r.slug}`} data-cursor="Read">
                {r.productName}
              </Link>
            </H>
            <span className="dc-price">{price ?? <span className="na">Price shown at the retailer</span>}</span>
            <span className="label muted">{d.merchant ?? "Retailer not reported"}</span>
          </div>
        </div>
        <dl className="dc-more">
          <dt>Availability</dt>
          <dd>{availabilityLabel(d.availability)}</dd>
          <dt>Last checked</dt>
          <dd>
            <time dateTime={d.verifiedAt.toISOString()}>{dateline(d.verifiedAt)}</time>
          </dd>
          <dt>State</dt>
          <dd>Link reached the retailer</dd>
        </dl>
        <div className="dc-cta">
          <span className="label muted">Affiliate link</span>
          <a className="btn primary small" href={`/go/${d.linkId}`} rel="sponsored nofollow noopener" target="_blank" data-cursor="View deal">
            View deal<span className="visually-hidden"> for {r.productName} at {d.merchant ?? "the retailer"} (opens in a new tab)</span>
          </a>
        </div>
      </article>
    </DealImpression>
  );
}

export default function DealLedger({ rows, headingLevel = 3 }: { rows: DealRow[]; headingLevel?: 2 | 3 }) {
  return (
    <ul className="deal-grid">
      {rows.map((d, i) => (
        <li key={d.linkId} className="reveal" style={{ "--delay": `${Math.min(i, 5) * 60}ms` } as React.CSSProperties}>
          <DealCard d={d} headingLevel={headingLevel} />
        </li>
      ))}
    </ul>
  );
}
