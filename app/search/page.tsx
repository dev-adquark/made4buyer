import type { Metadata } from "next";
import Link from "next/link";
import EmptyState from "@/components/empty-state";
import { ReviewGrid } from "@/components/review-card";
import SearchCombobox from "@/components/search-combobox";
import TrackOnce from "@/components/track-once";
import { categoryCounts, searchReviews } from "@/lib/public/queries";
import { themeStyle } from "@/lib/taxonomy/themes";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Search reviews", robots: { index: false, follow: true }, alternates: { canonical: "/search" } };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q: raw } = await searchParams;
  const q = (raw ?? "").trim().slice(0, 100);
  const [results, categories] = await Promise.all([q ? searchReviews(q) : Promise.resolve([]), categoryCounts()]);
  const withReviews = categories.filter((c) => c.count > 0);
  return (
    <main>
      <section className="cat-hero">
        <div className="container">
          <h1>Search reviews</h1>
          <div style={{ maxWidth: 680 }}>
            <SearchCombobox variant="wide" defaultValue={q} label="Search query" />
          </div>
          {q && (
            <>
              <TrackOnce event="search" metadata={{ q, results: results.length }} />
              <p className="muted" aria-live="polite" style={{ marginTop: 14 }}>
                {results.length === 1 ? "1 result" : `${results.length} results`} for “{q}”
              </p>
            </>
          )}
        </div>
      </section>
      <section className="section">
        <div className="container">
          {q && !results.length && (
            <EmptyState title="Try another product, brand or category.">No published review matches “{q}”.</EmptyState>
          )}
          {results.length > 0 && <ReviewGrid reviews={results} eagerCount={3} headingLevel={2} />}
          {(!q || !results.length) && withReviews.length > 0 && (
            <nav aria-labelledby="browse-cats">
              <h2 id="browse-cats">Browse a category</h2>
              <ul className="chips">
                {withReviews.map((c) => (
                  <li key={c.slug} style={themeStyle(c.slug) as React.CSSProperties}>
                    <Link className="chip" href={`/category/${c.slug}`} style={{ background: "var(--cat-soft)", color: "var(--cat-ink)" }}>
                      {c.name} ({c.count})
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </div>
      </section>
    </main>
  );
}
