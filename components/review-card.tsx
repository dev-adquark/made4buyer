import Link from "next/link";
import SafeImg from "./safe-img";
import Tilt from "./tilt";
import { placeholderPath } from "@/lib/pipeline/images";
import { cardImage, hasVerifiedOffer, type ReviewCard as Card } from "@/lib/public/queries";
import { categoryName } from "@/lib/taxonomy/definitions";
import { themeStyle } from "@/lib/taxonomy/themes";

function date(d: Date | null) {
  return d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null;
}

/** Review card. The verified-offer pill appears only for a VERIFIED_OK link on a matched offer. */
export default function ReviewCard({ review, headingLevel = 3, eager = false }: { review: Card; headingLevel?: 2 | 3; eager?: boolean }) {
  const img = cardImage(review);
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const published = date(review.publishedAt);
  return (
    <Tilt className="review-card" style={themeStyle(review.categorySlug) as React.CSSProperties}>
      <Link className="card-link" href={`/review/${review.slug}`}>
        <div className="thumb">
          <SafeImg src={img.url} fallback={placeholderPath(review.categorySlug)} alt="" width={640} height={400} loading={eager ? "eager" : "lazy"} decoding="async" />
          <span className="accent" />
        </div>
        <div className="card-body">
          <div className="meta-row">
            <span className="pill">{categoryName(review.categorySlug) ?? "Technology"}</span>
            {hasVerifiedOffer(review) && <span className="pill verified">Verified offer</span>}
          </div>
          <Heading>{review.canonicalTitle}</Heading>
          <p className="summary">{review.summary}</p>
          <div className="card-foot">
            <span>{review.brand ?? review.productName}</span>
            {published && <time dateTime={review.publishedAt!.toISOString()}>{published}</time>}
          </div>
        </div>
      </Link>
    </Tilt>
  );
}

export function ReviewGrid({ reviews, eagerCount = 0, headingLevel = 3 }: { reviews: Card[]; eagerCount?: number; headingLevel?: 2 | 3 }) {
  return (
    <ul className="grid">
      {reviews.map((r, i) => (
        <li key={r.id} className="reveal" style={{ "--delay": `${Math.min(i, 6) * 60}ms` } as React.CSSProperties}>
          <ReviewCard review={r} eager={i < eagerCount} headingLevel={headingLevel} />
        </li>
      ))}
    </ul>
  );
}
