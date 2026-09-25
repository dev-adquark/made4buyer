import Link from "next/link";
import { cardImage, type ReviewCard as Card } from "@/lib/public/queries";
import { categoryName } from "@/lib/taxonomy/definitions";

export default function ReviewCard({ review, headingLevel = 3, eager = false }: { review: Card; headingLevel?: 2 | 3; eager?: boolean }) {
  const img = cardImage(review);
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <article className="card">
      <Link className="card-link" href={`/review/${review.slug}`}>
        <div className="thumb">
          <img src={img.url} alt="" width={640} height={360} loading={eager ? "eager" : "lazy"} decoding="async" />
        </div>
        <div className="card-body">
          <div className="meta">
            {categoryName(review.categorySlug) ?? "Technology"}
            {review.brand ? ` · ${review.brand}` : ""}
          </div>
          <Heading style={{ fontSize: 18 }}>{review.canonicalTitle}</Heading>
          <p className="muted small">{review.summary}</p>
        </div>
      </Link>
    </article>
  );
}
