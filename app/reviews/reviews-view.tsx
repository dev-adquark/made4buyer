import type { Metadata } from "next";
import Link from "next/link";
import Breadcrumbs from "@/components/breadcrumbs";
import EmptyState from "@/components/empty-state";
import { ReviewGrid } from "@/components/review-card";
import { REVIEW_TYPES as TYPES, type ReviewsState } from "@/lib/public/listing-routes";
import { tagListingPage } from "@/lib/public/page-cache";
import { categoryCounts, publishedReviews } from "@/lib/public/queries";
import { themeStyle } from "@/lib/taxonomy/themes";

/*
 * Rendered by page.tsx (default view) and v/[state]/page.tsx (a type or page state, rewritten
 * there by proxy.ts); both are cached (ISR). See lib/public/listing-routes.ts.
 */

export async function reviewsMetadata(state: ReviewsState): Promise<Metadata> {
  const { total } = await publishedReviews(1);
  // Type-filtered and paged views are not separate search results.
  return { title: "All reviews", description: "Every published Made4Buyers review, comparison and guide, newest first.", alternates: { canonical: "/reviews" }, robots: total === 0 || state.noindex ? { index: false, follow: true } : undefined };
}

/** The reviews index for one type/page state (default view or a cached state). */
export async function ReviewsView({ state }: { state: ReviewsState }) {
  await tagListingPage();
  const { page, type } = state;
  const [{ rows, total, pages }, categories] = await Promise.all([publishedReviews(page, 24, type.value), categoryCounts()]);
  const href = (p: number, t = type) => `/reviews${t.param || p > 1 ? `?${new URLSearchParams({ ...(t.param ? { type: t.param } : {}), ...(p > 1 ? { page: String(p) } : {}) })}` : ""}`;
  return (
    <main>
      <section className="page-hero">
        <div className="wrap">
          <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Reviews", href: "/reviews" }]} />
          <h1>Reviews</h1>
          <p className="lede">{total ? `${total} published, newest first. Every card says what it is: a source review, a source comparison, a source buying guide or a Made4Buyers guide.` : type.value ? `Nothing of this type has been published yet.` : "No reviews have been published yet."}</p>
          <nav aria-label="Filter by content type" style={{ marginBottom: 14 }}>
            <ul className="chips">
              {TYPES.map((t) => (
                <li key={t.label}>
                  <Link className="chip" href={href(1, t)} aria-current={t === type ? "page" : undefined}>
                    {t.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <nav aria-label="Categories">
            <ul className="chips">
              {categories.filter((c) => c.count > 0).map((c) => (
                <li key={c.slug} style={themeStyle(c.slug) as React.CSSProperties}>
                  <Link className="chip" href={`/category/${c.slug}`}>
                    {c.name} ({c.count})
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </section>
      <section className="section">
        <div className="wrap">
          {rows.length ? <ReviewGrid reviews={rows} eagerCount={3} headingLevel={2} /> : <EmptyState title="We’re waiting for the next published review.">Reviews appear here once they pass our automatic checks.</EmptyState>}
          {pages > 1 && (
            <nav className="pagination" aria-label="Pagination">
              {page > 1 && (
                <Link className="btn" href={href(page - 1)}>
                  Previous page
                </Link>
              )}
              <span className="muted">
                Page {page} of {pages}
              </span>
              {page < pages && (
                <Link className="btn" href={href(page + 1)}>
                  Next page
                </Link>
              )}
            </nav>
          )}
        </div>
      </section>
    </main>
  );
}
