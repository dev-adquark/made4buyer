import Link from "next/link";
import SafeImg from "./safe-img";
import TrustLabel from "./trust-label";
import { placeholderPath } from "@/lib/pipeline/images";
import { cardImage, hasVerifiedOffer, type ReviewCard as Card } from "@/lib/public/queries";
import { categoryName } from "@/lib/taxonomy/definitions";
import { themeStyle } from "@/lib/taxonomy/themes";
import { dateline } from "@/lib/util/format";

export function KindPill({ kind }: { kind: string }) {
  return kind === "AI_GUIDE" ? <TrustLabel kind="ai" /> : <TrustLabel kind="source" />;
}

/** Who wrote it: the publisher for reviews; for guides, that it is AI-assisted. */
export function sourceOf(r: Pick<Card, "kind" | "entities" | "author">) {
  return r.kind === "AI_GUIDE" ? "Made4Buyers (AI-assisted)" : r.entities?.source ?? r.author ?? "Source not reported";
}

/** The date the source published it (never our ingestion date, so old reviews don't look new). */
export function shownDate(r: Pick<Card, "sourcePublishedAt" | "publishedAt">) {
  return r.sourcePublishedAt ?? r.publishedAt;
}

function Meta({ r }: { r: Card }) {
  const d = shownDate(r);
  return (
    <div className="foot">
      <span>{sourceOf(r)}</span>
      {d && <time dateTime={d.toISOString()}>{dateline(d)}</time>}
    </div>
  );
}

/**
 * Compact review card (default). `row` is the list variant used beside a feature story.
 * The verified-offer label appears only for a VERIFIED_OK link on a matched offer.
 */
export default function ReviewCard({ review, headingLevel = 3, eager = false, variant }: { review: Card; headingLevel?: 2 | 3; eager?: boolean; variant?: "row" }) {
  const img = cardImage(review);
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <article className={`review-card${variant ? ` ${variant}` : ""}`} style={themeStyle(review.categorySlug) as React.CSSProperties}>
      <Link href={`/review/${review.slug}`} data-cursor="Read">
        <div className="media">
          <SafeImg src={img.url} fallback={placeholderPath(review.categorySlug)} alt="" width={640} height={427} loading={eager ? "eager" : "lazy"} decoding="async" />
          <span className="kind">
            <KindPill kind={review.kind} />
          </span>
        </div>
        <div className="body">
          <div className="meta-row">
            <span className="cat-tag">{categoryName(review.categorySlug) ?? "Technology"}</span>
            {hasVerifiedOffer(review) && <TrustLabel kind="verified" />}
          </div>
          <Heading>{review.canonicalTitle}</Heading>
          <p className="summary">{review.summary}</p>
          <Meta r={review} />
        </div>
      </Link>
    </article>
  );
}

/** Feature story: the dominant item of a section, large image and display headline. */
export function FeatureStory({ review }: { review: Card }) {
  const img = cardImage(review);
  return (
    <article className="feature-story" style={themeStyle(review.categorySlug) as React.CSSProperties}>
      <Link href={`/review/${review.slug}`} data-cursor="Read">
        <div className="media">
          <SafeImg src={img.url} fallback={placeholderPath(review.categorySlug)} alt="" width={1200} height={750} fetchPriority="high" decoding="async" />
        </div>
        <div className="meta-row" style={{ marginTop: 16 }}>
          <span className="cat-tag">{categoryName(review.categorySlug) ?? "Technology"}</span>
          <KindPill kind={review.kind} />
          {hasVerifiedOffer(review) && <TrustLabel kind="verified" />}
        </div>
        <h3>{review.canonicalTitle}</h3>
        <p className="summary">{review.summary}</p>
        <div className="review-card" style={{ height: "auto" }}>
          <Meta r={review} />
        </div>
      </Link>
    </article>
  );
}

export function ReviewGrid({ reviews, eagerCount = 0, headingLevel = 3, layout = "grid" }: { reviews: Card[]; eagerCount?: number; headingLevel?: 2 | 3; layout?: "grid" | "editorial" | "ruled" }) {
  const cls = layout === "editorial" && reviews.length >= 3 ? "editorial-grid" : layout === "ruled" ? "grid ruled" : "grid";
  return (
    <ul className={cls}>
      {reviews.map((r, i) => (
        <li key={r.id} className="reveal" style={{ "--delay": `${Math.min(i, 5) * 70}ms` } as React.CSSProperties}>
          <ReviewCard review={r} eager={i < eagerCount} headingLevel={headingLevel} />
        </li>
      ))}
    </ul>
  );
}
