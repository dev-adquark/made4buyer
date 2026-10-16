import Link from "next/link";
import SafeImg from "./safe-img";
import TrustLabel from "./trust-label";
import { REPRESENTATIVE_CAPTION } from "@/lib/images/provenance";
import { placeholderPath } from "@/lib/pipeline/images";
import { resolveCardImage, type CardImage, type ReviewCard as Card } from "@/lib/public/queries";
import { categoryName } from "@/lib/taxonomy/definitions";
import { themeStyle } from "@/lib/taxonomy/themes";
import { displayText } from "@/lib/public/display";
import { dateline } from "@/lib/util/format";
import { MADE4BUYERS_SOURCE_NAME, resolveSourceAttribution } from "@/lib/public/source-attribution";

/** Keyword-to-Blog post type, from the stored generation metadata. */
export function aiPostType(meta: unknown): "ARTICLE" | "GUIDE" {
  return (meta as { articleType?: string } | null)?.articleType === "ARTICLE" ? "ARTICLE" : "GUIDE";
}

export function KindPill({ kind, articleType, contentRewritten = false }: { kind: string; articleType?: "ARTICLE" | "GUIDE" | null; contentRewritten?: boolean }) {
  if (kind === "AI_GUIDE") return <TrustLabel kind="ai">{articleType === "ARTICLE" ? "Article" : "Guide"}</TrustLabel>;
  if (contentRewritten) return <TrustLabel kind="ai">{MADE4BUYERS_SOURCE_NAME}</TrustLabel>;
  if (kind === "COMPARISON") return <TrustLabel kind="source">Comparison</TrustLabel>;
  if (kind === "BUYING_GUIDE") return <TrustLabel kind="source">Buying guide</TrustLabel>;
  return <TrustLabel kind="source">Review</TrustLabel>;
}

/** The noun for a content kind, for sentences like "The full comparison belongs to …". */
export function kindNoun(kind: string): string {
  return kind === "COMPARISON" ? "comparison" : kind === "BUYING_GUIDE" ? "buying guide" : kind === "AI_GUIDE" ? "guide" : "review";
}

type CardAttributionFields = Pick<Card, "kind" | "contentRewritten" | "source" | "sourceUrl" | "slug"> & Partial<Pick<Card, "entities" | "author">>;

/** Shared public attribution policy for cards; original citations are only shown on excerpt detail pages. */
export function sourceOf(r: CardAttributionFields): string | null {
  return resolveCardAttribution(r).name;
}

function resolveCardAttribution(r: CardAttributionFields) {
  return resolveSourceAttribution({
    kind: r.kind,
    contentRewritten: r.contentRewritten,
    sourceName: r.entities?.source || r.source,
    sourceKey: r.source,
    sourceUrl: r.sourceUrl,
    canonicalPath: `/review/${r.slug}`,
  });
}

/** Cards use Made4Buyers' publication date rather than the original publisher's date. */
export function shownDate(r: CardAttributionFields & Pick<Card, "sourcePublishedAt" | "publishedAt">) {
  const source = resolveSourceAttribution({
    kind: r.kind,
    contentRewritten: r.contentRewritten,
    sourceName: r.entities?.source || r.source,
    sourceKey: r.source,
    sourceUrl: r.sourceUrl,
    sourcePublishedAt: r.sourcePublishedAt,
    publishedAt: r.publishedAt,
    canonicalPath: `/review/${r.slug}`,
  });
  return source.publishedAt ? new Date(source.publishedAt) : null;
}

function Meta({ r }: { r: Card }) {
  const d = shownDate(r);
  const source = sourceOf(r);
  const when = dateline(d);
  if (!source && !when) return null;
  return (
    <div className="foot">
      {source && <span>{source}</span>}
      {d && when && <time dateTime={d.toISOString()}>{when}</time>}
    </div>
  );
}

function cardHref(r: Card): string {
  const attribution = resolveCardAttribution(r);
  return attribution.isMade4Buyers && attribution.url ? attribution.url : `/review/${r.slug}`;
}

/**
 * The small "Representative photo" chip on a card photo that is not the exact product (a Pexels
 * photo of its type or category); the photo credit is in its title. Exact product photos carry none.
 */
export function RepresentativeTag({ credit }: { credit?: string | null }) {
  return (
    <span className="rep-tag" title={credit ? `${REPRESENTATIVE_CAPTION} · ${credit}` : REPRESENTATIVE_CAPTION} data-representative="">
      {REPRESENTATIVE_CAPTION}
    </span>
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
export default async function ReviewCard({ review, headingLevel = 3, eager = false, variant, sizes = CARD_SIZES, image }: { review: Card; headingLevel?: 2 | 3; eager?: boolean; variant?: "row"; sizes?: string; image?: CardImage }) {
  const img = image ?? (await resolveCardImage(review));
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <article className={`review-card${variant ? ` ${variant}` : ""}`} style={themeStyle(review.categorySlug) as React.CSSProperties}>
      <Link href={cardHref(review)} data-cursor="Read">
        <div className="media">
          <SafeImg src={img.url} alternates={img.alternates} fallback={placeholderPath(review.categorySlug)} alt="" width={640} height={427} loading={eager ? "eager" : "lazy"} decoding="async" {...(variant === "row" ? ROW_IMAGE : { sizes })} />
          <span className="kind">
            <KindPill kind={review.kind} articleType={aiPostType(review.generationMeta)} contentRewritten={review.contentRewritten} />
          </span>
          {img.representative && <RepresentativeTag credit={img.credit} />}
        </div>
        <div className="body">
          <div className="meta-row">
            {categoryName(review.categorySlug) && <span className="cat-tag">{categoryName(review.categorySlug)}</span>}
          </div>
          <Heading>{review.canonicalTitle}</Heading>
          {displayText(review.summary) && <p className="summary">{review.summary}</p>}
          <Meta r={review} />
        </div>
      </Link>
    </article>
  );
}

/** Feature story: the dominant item of a section, large image and display headline. */
export async function FeatureStory({ review, image }: { review: Card; image?: CardImage }) {
  const img = image ?? (await resolveCardImage(review));
  return (
    <article className="feature-story" style={themeStyle(review.categorySlug) as React.CSSProperties}>
      <Link href={cardHref(review)} data-cursor="Read">
        <div className="media">
          <SafeImg src={img.url} alternates={img.alternates} fallback={placeholderPath(review.categorySlug)} alt="" width={1200} height={750} sizes="(max-width: 1000px) 100vw, (max-width: 1520px) 58vw, 860px" fetchPriority="high" decoding="async" />
          {img.representative && <RepresentativeTag credit={img.credit} />}
        </div>
        <div className="meta-row" style={{ marginTop: 16 }}>
          {categoryName(review.categorySlug) && <span className="cat-tag">{categoryName(review.categorySlug)}</span>}
          <KindPill kind={review.kind} articleType={aiPostType(review.generationMeta)} contentRewritten={review.contentRewritten} />
        </div>
        <h3>{review.canonicalTitle}</h3>
        {displayText(review.summary) && <p className="summary">{review.summary}</p>}
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
