import Link from "next/link";
import DealImpression from "./deal-impression";
import SafeImg from "./safe-img";
import { placeholderPath } from "@/lib/pipeline/images";
import { displayText } from "@/lib/public/display";
import { resolveCardImage, type DealRow } from "@/lib/public/queries";
import { categoryName } from "@/lib/taxonomy/definitions";
import { themeStyle } from "@/lib/taxonomy/themes";
import { availabilityLabel, dateline, money } from "@/lib/util/format";

/** A row can be shown only with a real price (amount + ISO currency) and a named seller. */
export function dealRowShowable(d: DealRow): boolean {
  return money(d.price, d.currency) !== null && displayText(d.seller) !== null;
}

/** One fresh commerce price as a tear-off tag: product, price and seller as observed, and when we checked. */
export async function DealCard({ d, headingLevel = 3 }: { d: DealRow; headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  const r = d.review;
  const price = money(d.price, d.currency);
  // Never a card without a verified price: nothing is rendered instead.
  if (!price || !displayText(d.seller)) return null;
  const img = await resolveCardImage(r);
  const availability = availabilityLabel(d.availability);
  const checked = dateline(d.observedAt);
  const category = categoryName(r.categorySlug);
  return (
    <DealImpression offerId={d.offerId} reviewId={r.id} categorySlug={r.categorySlug}>
      <article className="deal-card" style={themeStyle(r.categorySlug) as React.CSSProperties}>
        <div className="dc-top">
          {category ? <span className="cat-tag">{category}</span> : <span />}
          <span className="trust checked">Price checked</span>
        </div>
        <div className="dc-main">
          <SafeImg src={img.url} alternates={img.alternates} fallback={placeholderPath(r.categorySlug)} alt="" width={84} height={84} sizes="84px" loading="lazy" decoding="async" />
          <div>
            <H style={{ font: "inherit", margin: 0 }}>
              <Link className="dc-title" href={`/review/${r.slug}`} data-cursor="Read">
                {r.productName}
              </Link>
            </H>
            <span className="dc-price">{price}</span>
            <span className="label muted">{d.seller}</span>
          </div>
        </div>
        <dl className="dc-more">
          {availability && (
            <>
              <dt>Availability</dt>
              <dd>{availability}</dd>
            </>
          )}
          {checked && (
            <>
              <dt>Last checked</dt>
              <dd>
                <time dateTime={d.observedAt.toISOString()}>{checked}</time>
              </dd>
            </>
          )}
          <dt>Seller</dt>
          <dd>{d.sellerType === "MANUFACTURER" ? "Official store" : "Retailer"}</dd>
        </dl>
        <div className="dc-cta">
          <span className="label muted">{d.affiliated ? "Affiliate link" : "Direct link"}</span>
          <a className="btn primary small" href={`/go/${d.offerId}`} rel={d.affiliated ? "sponsored nofollow noopener" : "nofollow noopener"} target="_blank" data-cursor="View">
            View at {d.seller}<span className="visually-hidden"> for {r.productName} (opens in a new tab)</span>
          </a>
        </div>
      </article>
    </DealImpression>
  );
}

export default function DealLedger({ rows, headingLevel = 3 }: { rows: DealRow[]; headingLevel?: 2 | 3 }) {
  const shown = rows.filter(dealRowShowable);
  if (!shown.length) return null;
  return (
    <ul className="deal-grid">
      {shown.map((d, i) => (
        <li key={d.offerId} className="reveal" style={{ "--delay": `${Math.min(i, 5) * 60}ms` } as React.CSSProperties}>
          <DealCard d={d} headingLevel={headingLevel} />
        </li>
      ))}
    </ul>
  );
}
