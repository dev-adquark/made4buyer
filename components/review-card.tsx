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

export function KindPill({ kind }: { kind: string }) {
  return kind === "AI_GUIDE" ? <span className="pill ai">AI-assisted guide</span> : <span className="pill review">Review</span>;
}

/** Product card. The verified-offer pill appears only for a VERIFIED_OK link on a matched offer. */
export default function ReviewCard({ review, headingLevel = 3, eager = false, variant }: { review: Card; headingLevel?: 2 | 3; eager?: boolean; variant?: "feature" | "compact" }) {
  const img = cardImage(review);
  const Heading = headingLevel === 2 ? "h2" : "h3";
  // Show when the source published it, not when we did: old reviews never look new.
  const shown = review.sourcePublishedAt ?? review.publishedAt;
  const published = date(shown);
  return (
    <Tilt className={`review-card${variant ? ` ${variant}` : ""}`} max={4} style={themeStyle(review.categorySlug) as React.CSSProperties}>
      <Link href={`/review/${review.slug}`}>
        <div className="media">
          <SafeImg src={img.url} fallback={placeholderPath(review.categorySlug)} alt="" width={640} height={400} loading={eager ? "eager" : "lazy"} decoding="async" />
          <span className="kind">
            <KindPill kind={review.kind} />
          </span>
        </div>
        <div className="body">
          <div className="meta-row">
            <span className="pill">{categoryName(review.categorySlug) ?? "Technology"}</span>
            {hasVerifiedOffer(review) && <span className="pill verified">Verified offer</span>}
          </div>
          <Heading>{review.canonicalTitle}</Heading>
          <p className="summary">{review.summary}</p>
          <div className="foot">
            <span>{review.brand ?? review.productName}</span>
            {published && <time dateTime={shown!.toISOString()}>{published}</time>}
          </div>
        </div>
      </Link>
    </Tilt>
  );
}

export function ReviewGrid({ reviews, eagerCount = 0, headingLevel = 3, layout = "grid" }: { reviews: Card[]; eagerCount?: number; headingLevel?: 2 | 3; layout?: "grid" | "editorial" }) {
  return (
    <ul className={layout === "editorial" && reviews.length >= 3 ? "editorial-grid" : "grid"}>
      {reviews.map((r, i) => (
        <li key={r.id}>
          <ReviewCard review={r} eager={i < eagerCount} headingLevel={headingLevel} />
        </li>
      ))}
    </ul>
  );
}
