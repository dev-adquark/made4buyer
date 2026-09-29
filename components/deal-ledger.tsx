import Link from "next/link";
import DealImpression from "./deal-impression";
import SafeImg from "./safe-img";
import { placeholderPath } from "@/lib/pipeline/images";
import { cardImage, type DealRow } from "@/lib/public/queries";
import { categoryName } from "@/lib/taxonomy/definitions";
import { themeStyle } from "@/lib/taxonomy/themes";
import { availabilityLabel, money, shortDate } from "@/lib/util/format";

/** Verified offers as a ledger: product, price and merchant as reported, and when we last checked. */
export default function DealLedger({ rows, headingLevel = 3 }: { rows: DealRow[]; headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <ul className="ledger">
      {rows.map((d) => {
        const r = d.review;
        const price = money(d.price, d.currency);
        return (
          <li key={d.linkId} style={themeStyle(r.categorySlug) as React.CSSProperties}>
            <DealImpression linkId={d.linkId} reviewId={r.id} categorySlug={r.categorySlug}>
              <div className="ledger-row">
                <SafeImg src={cardImage(r).url} fallback={placeholderPath(r.categorySlug)} alt="" width={88} height={60} loading="lazy" />
                <div>
                  <H style={{ font: "inherit", margin: 0 }}>
                    <Link className="l-title" href={`/review/${r.slug}`}>
                      {r.productName}
                    </Link>
                  </H>
                  <div className="meta-row" style={{ marginTop: 4 }}>
                    <span className="pill">{categoryName(r.categorySlug) ?? "Technology"}</span>
                    <span className="pill verified">Verified offer</span>
                  </div>
                </div>
                <div>
                  <div className="l-price">{price ?? <span className="small">Price shown at the retailer</span>}</div>
                  <div className="l-meta">
                    {d.merchant ?? "Retailer not reported"}, {availabilityLabel(d.availability).toLowerCase()}
                  </div>
                  <div className="l-meta">
                    Link checked <time dateTime={d.verifiedAt.toISOString()}>{shortDate(d.verifiedAt)}</time>
                  </div>
                </div>
                <a className="btn primary" href={`/go/${d.linkId}`} rel="sponsored nofollow noopener" target="_blank">
                  View deal<span className="visually-hidden"> for {r.productName} at {d.merchant ?? "the retailer"} (opens in a new tab)</span>
                </a>
              </div>
            </DealImpression>
          </li>
        );
      })}
    </ul>
  );
}
