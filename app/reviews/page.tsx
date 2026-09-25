import type { Metadata } from "next";
import Link from "next/link";
import Breadcrumbs from "@/components/breadcrumbs";
import EmptyState from "@/components/empty-state";
import { ReviewGrid } from "@/components/review-card";
import { categoryCounts, publishedReviews } from "@/lib/public/queries";
import { themeStyle } from "@/lib/taxonomy/themes";

export const dynamic = "force-dynamic";

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ page?: string }> }): Promise<Metadata> {
  const { page } = await searchParams;
  return { title: "All reviews", description: "Every published Made4Buyers technology review, newest first.", alternates: { canonical: "/reviews" }, robots: page && page !== "1" ? { index: false, follow: true } : undefined };
}

export default async function ReviewsIndex({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { page: raw } = await searchParams;
  const page = Math.max(1, Math.min(500, Number(raw) || 1));
  const [{ rows, total, pages }, categories] = await Promise.all([publishedReviews(page), categoryCounts()]);
  return (
    <main>
      <section className="cat-hero">
        <div className="container">
          <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Reviews", href: "/reviews" }]} />
          <h1>All reviews</h1>
          <p className="lede">{total ? `${total} published ${total === 1 ? "review" : "reviews"}, newest first.` : "No reviews have been published yet."}</p>
          <nav aria-label="Categories">
            <ul className="chips">
              {categories.filter((c) => c.count > 0).map((c) => (
                <li key={c.slug} style={themeStyle(c.slug) as React.CSSProperties}>
                  <Link className="chip neutral" href={`/category/${c.slug}`}>
                    {c.name} ({c.count})
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </section>
      <section className="section">
        <div className="container">
          {rows.length ? <ReviewGrid reviews={rows} eagerCount={3} headingLevel={2} /> : <EmptyState title="We’re waiting for the next verified review.">Reviews appear here once they pass editorial QA.</EmptyState>}
          {pages > 1 && (
            <nav className="pagination" aria-label="Pagination">
              {page > 1 && (
                <Link className="btn" href={`/reviews?page=${page - 1}`}>
                  Previous page
                </Link>
              )}
              <span className="muted">
                Page {page} of {pages}
              </span>
              {page < pages && (
                <Link className="btn" href={`/reviews?page=${page + 1}`}>
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
