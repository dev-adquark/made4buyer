import type { Metadata } from "next";
import Link from "next/link";
import Breadcrumbs from "@/components/breadcrumbs";
import CategoryIcon from "@/components/category-icon";
import EmptyState from "@/components/empty-state";
import { ReviewGrid } from "@/components/review-card";
import SearchCombobox from "@/components/search-combobox";
import TrackOnce from "@/components/track-once";
import { categoryCounts, searchGroups, searchReviews } from "@/lib/public/queries";
import { themeStyle } from "@/lib/taxonomy/themes";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Search reviews", robots: { index: false, follow: true }, alternates: { canonical: "/search" } };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q: raw } = await searchParams;
  const q = (raw ?? "").trim().slice(0, 100);
  const [results, groups, categories] = await Promise.all([q ? searchReviews(q) : Promise.resolve([]), q.length >= 2 ? searchGroups(q) : Promise.resolve(null), categoryCounts()]);
  const reviews = results.filter((r) => r.kind === "REVIEW");
  const guides = results.filter((r) => r.kind === "AI_GUIDE");
  const withReviews = categories.filter((c) => c.count > 0);
  const shortcuts = [...(groups?.categories ?? []).map((c) => ({ key: c.href, href: c.href, label: c.parent ? `${c.name} in ${c.parent}` : c.name, slug: c.slug })), ...(groups?.brands ?? []).map((b) => ({ key: b.href, href: b.href, label: b.name, slug: null as string | null }))];
  return (
    <main>
      <section className="page-hero">
        <div className="wrap">
          <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Search", href: "/search" }]} />
          <h1>{q ? `Results for “${q}”` : "Search"}</h1>
          <div style={{ maxWidth: 680 }}>
            <SearchCombobox variant="wide" defaultValue={q} label="Search query" />
          </div>
          {q && (
            <>
              <TrackOnce event="search" metadata={{ q, results: results.length }} />
              <p className="lede" aria-live="polite" style={{ marginTop: 14 }}>
                {results.length === 1 ? "1 result" : `${results.length} results`} for “{q}”
              </p>
            </>
          )}
        </div>
      </section>
      <section className="section">
        <div className="wrap">
          {shortcuts.length > 0 && (
            <nav aria-labelledby="shortcut-title" style={{ marginBottom: 28 }}>
              <h2 id="shortcut-title" style={{ fontSize: 18 }}>
                Categories and brands
              </h2>
              <ul className="chips">
                {shortcuts.map((s) => (
                  <li key={s.key} style={s.slug ? (themeStyle(s.slug) as React.CSSProperties) : undefined}>
                    <Link className="chip" href={s.href}>
                      {s.slug && <CategoryIcon slug={s.slug} size={16} />}
                      {s.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          {q && !results.length && (
            <EmptyState title="Try another product, brand or category." action={<Link className="btn" href="/match">Find my match instead</Link>}>
              No published review matches “{q}”.
            </EmptyState>
          )}
          {reviews.length > 0 && (
            <section aria-labelledby="r-title" style={{ marginBottom: 36 }}>
              <h2 id="r-title">Reviews</h2>
              <ReviewGrid reviews={reviews} eagerCount={3} />
            </section>
          )}
          {guides.length > 0 && (
            <section aria-labelledby="g-title">
              <h2 id="g-title">Buying guides</h2>
              <ReviewGrid reviews={guides} />
            </section>
          )}
          {(!q || !results.length) && withReviews.length > 0 && (
            <nav aria-labelledby="browse-cats" style={{ marginTop: 28 }}>
              <h2 id="browse-cats">Browse a category</h2>
              <ul className="chips">
                {withReviews.map((c) => (
                  <li key={c.slug} style={themeStyle(c.slug) as React.CSSProperties}>
                    <Link className="chip" href={`/category/${c.slug}`}>
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
