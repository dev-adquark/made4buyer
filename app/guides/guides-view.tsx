import type { Metadata } from "next";
import Link from "next/link";
import Breadcrumbs from "@/components/breadcrumbs";
import EmptyState from "@/components/empty-state";
import { ReviewGrid } from "@/components/review-card";
import type { GuidesState } from "@/lib/public/listing-routes";
import { tagListingPage } from "@/lib/public/page-cache";
import { publishedGuides } from "@/lib/public/queries";

/* Rendered by page.tsx (page 1) and v/[state]/page.tsx (`?page=`, rewritten there by proxy.ts); both cached (ISR). */

export async function guidesMetadata(state: GuidesState): Promise<Metadata> {
  const { total } = await publishedGuides(1);
  return {
    title: "Buying guides",
    description: "Buying guides and articles from named publishers and from Made4Buyers.",
    alternates: { canonical: "/guides" },
    robots: total === 0 || state.noindex ? { index: false, follow: true } : undefined,
  };
}

/** The guides index for one page (default view or a cached page state). */
export async function GuidesView({ state }: { state: GuidesState }) {
  await tagListingPage();
  const { page } = state;
  const { rows, total, pages } = await publishedGuides(page);
  return (
    <main>
      <section className="page-hero">
        <div className="wrap">
          <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Buying guides", href: "/guides" }]} />
          <h1>Buying guides</h1>
          <p className="lede">What to look for before you buy. {total ? `${total === 1 ? "1 guide" : `${total} guides`} published.` : ""}</p>
        </div>
      </section>
      <section className="section">
        <div className="wrap">
          {rows.length ? (
            <ReviewGrid reviews={rows} eagerCount={3} headingLevel={2} />
          ) : (
            <EmptyState title="No buying guides are published yet." action={<Link className="btn" href="/reviews">Browse reviews</Link>}>
              Guides appear here as they are published.
            </EmptyState>
          )}
          {pages > 1 && (
            <nav className="pagination" aria-label="Pagination">
              {page > 1 && (
                <Link className="btn" href={`/guides?page=${page - 1}`}>
                  Previous page
                </Link>
              )}
              <span className="muted">
                Page {page} of {pages}
              </span>
              {page < pages && (
                <Link className="btn" href={`/guides?page=${page + 1}`}>
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
