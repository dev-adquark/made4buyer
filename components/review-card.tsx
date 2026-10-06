import Link from "next/link";
import SafeImg from "./safe-img";
import TrustLabel from "./trust-label";
import { placeholderPath } from "@/lib/pipeline/images";
import { cardImage, hasVerifiedOffer, type ReviewCard as Card } from "@/lib/public/queries";
import { categoryName } from "@/lib/taxonomy/definitions";
import { themeStyle } from "@/lib/taxonomy/themes";
import { dateline } from "@/lib/util/format";

/** Keyword-to-Blog post type, from the stored generation metadata. */
export function aiPostType(meta: unknown): "ARTICLE" | "GUIDE" {
  return (meta as { articleType?: string } | null)?.articleType === "ARTICLE" ? "ARTICLE" : "GUIDE";
}

export function KindPill({ kind, articleType }: { kind: string; articleType?: "ARTICLE" | "GUIDE" | null }) {
  if (kind === "AI_GUIDE") return <TrustLabel kind="ai">{articleType === "ARTICLE" ? "Article" : "Guide"}</TrustLabel>;
  if (kind === "COMPARISON") return <TrustLabel kind="source">Source comparison</TrustLabel>;
  if (kind === "BUYING_GUIDE") return <TrustLabel kind="source">Source buying guide</TrustLabel>;
  return <TrustLabel kind="source" />;
}

/** The noun for a content kind, for sentences like "The full comparison belongs to …". */
export function kindNoun(kind: string): string {
  return kind === "COMPARISON" ? "comparison" : kind === "BUYING_GUIDE" ? "buying guide" : kind === "AI_GUIDE" ? "guide" : "review";
}

/** Who wrote it: the publisher for reviews; Made4Buyers for our own guides and articles. */
export function sourceOf(r: Pick<Card, "kind" | "entities" | "author">) {
  return r.kind === "AI_GUIDE" ? "Made4Buyers" : r.entities?.source ?? r.author ?? "Source not reported";
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

/** `sizes` for a card image in a .grid (auto-fill, min 280px columns inside a 1440px container). */
export const CARD_SIZES = "(max-width: 600px) 100vw, (max-width: 1000px) 50vw, 400px";
const ROW_IMAGE = { sizes: "112px", responsive: { maxWidth: 224, boxAspect: 1 } } as const;

/** `sizes` for each slot of the 12-column editorial grid (7 + 5, then 4 per item; 6 under 1000px). */
function editorialSizes(i: number) {
  const [vw, cap] = i === 0 ? [56, 820] : i === 1 ? [40, 590] : [32, 470];
  return `(max-width: 720px) 100vw, (max-width: 1000px) 50vw, (max-width: 1520px) ${vw}vw, ${cap}px`;
}

/**
 * Compact review card (default). `row` is the list variant used beside a feature story.
 * The verified-offer label appears only for a VERIFIED_OK link on a matched offer.
 */
export default function ReviewCard({ review, headingLevel = 3, eager = false, variant, sizes = CARD_SIZES }: { review: Card; headingLevel?: 2 | 3; eager?: boolean; variant?: "row"; sizes?: string }) {
  const img = cardImage(review);
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <article className={`review-card${variant ? ` ${variant}` : ""}`} style={themeStyle(review.categorySlug) as React.CSSProperties}>
      <Link href={`/review/${review.slug}`} data-cursor="Read">
        <div className="media">
          <SafeImg src={img.url} fallback={placeholderPath(review.categorySlug)} alt="" width={640} height={427} loading={eager ? "eager" : "lazy"} decoding="async" {...(variant === "row" ? ROW_IMAGE : { sizes })} />
          <span className="kind">
            <KindPill kind={review.kind} articleType={aiPostType(review.generationMeta)} />
          </span>
        </div>
        <div className="body">
          <div className="meta-row">
            <span className="cat-tag">{categoryName(review.categorySlug) ?? "General"}</span>
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
          <SafeImg src={img.url} fallback={placeholderPath(review.categorySlug)} alt="" width={1200} height={750} sizes="(max-width: 1000px) 100vw, (max-width: 1520px) 58vw, 860px" fetchPriority="high" decoding="async" />
        </div>
        <div className="meta-row" style={{ marginTop: 16 }}>
          <span className="cat-tag">{categoryName(review.categorySlug) ?? "General"}</span>
          <KindPill kind={review.kind} articleType={aiPostType(review.generationMeta)} />
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
          <ReviewCard review={r} eager={i < eagerCount} headingLevel={headingLevel} sizes={cls === "editorial-grid" ? editorialSizes(i) : CARD_SIZES} />
        </li>
      ))}
    </ul>
  );
}
