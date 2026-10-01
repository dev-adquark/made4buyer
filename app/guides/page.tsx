import type { Metadata } from "next";
import Link from "next/link";
import Breadcrumbs from "@/components/breadcrumbs";
import EmptyState from "@/components/empty-state";
import { ReviewGrid } from "@/components/review-card";
import { publishedGuides } from "@/lib/public/queries";

export const dynamic = "force-dynamic";

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ page?: string }> }): Promise<Metadata> {
  const { page } = await searchParams;
  const { total } = await publishedGuides(1);
  return {
    title: "Buying guides",
    description: "AI-assisted technology buying guides, each read and approved by a Made4Buyers editor.",
    alternates: { canonical: "/guides" },
    robots: total === 0 || (page && page !== "1") ? { index: false, follow: true } : undefined,
  };
}

export default async function GuidesIndex({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { page: raw } = await searchParams;
  const page = Math.max(1, Math.min(500, Number(raw) || 1));
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
          <aside className="kind-banner ai" aria-label="How guides are written">
            <div>
              <strong>Every guide here is AI-assisted.</strong>
              Guides are drafted with an AI writing tool, then read and approved by an editor before they’re published. They aren’t hands-on reviews and never carry a rating. For tested products, see <Link href="/reviews">reviews</Link>.
            </div>
          </aside>
          {rows.length ? (
            <ReviewGrid reviews={rows} eagerCount={3} headingLevel={2} />
          ) : (
            <EmptyState title="No buying guides are published yet." action={<Link className="btn" href="/reviews">Browse reviews</Link>}>
              Guides appear here after an editor has read and approved them.
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
