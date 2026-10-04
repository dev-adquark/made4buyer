import type { Metadata } from "next";
import Link from "next/link";
import Breadcrumbs from "@/components/breadcrumbs";
import CategoryIcon from "@/components/category-icon";
import EmptyState from "@/components/empty-state";
import { ReviewGrid } from "@/components/review-card";
import SearchCombobox from "@/components/search-combobox";
import TrackOnce from "@/components/track-once";
import { categoryCounts, didYouMean, searchGroups, searchReviews, type SearchKind } from "@/lib/public/queries";
import { themeStyle } from "@/lib/taxonomy/themes";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Search reviews", description: "Search Made4Buyers reviews and guides by product, brand or category.", robots: { index: false, follow: true }, alternates: { canonical: "/search" } };

const TYPES: Array<{ value: SearchKind | null; label: string }> = [
  { value: null, label: "Everything" },
  { value: "REVIEW", label: "Reviews" },
  { value: "COMPARISON", label: "Comparisons" },
  { value: "GUIDE", label: "Guides" },
];

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string; type?: string }> }) {
  const { q: raw, type: rawType } = await searchParams;
  const q = (raw ?? "").trim().slice(0, 100);
  const type = TYPES.find((t) => t.value && t.value.toLowerCase() === (rawType ?? "").toLowerCase())?.value ?? null;
  const [results, groups, categories] = await Promise.all([q ? searchReviews(q, 30, { type }) : Promise.resolve([]), q.length >= 2 ? searchGroups(q) : Promise.resolve(null), categoryCounts()]);
  const suggestion = q && !results.length && !(groups?.products.length ?? 0) ? await didYouMean(q) : null;
  const reviews = results.filter((r) => r.kind === "REVIEW");
  const comparisons = results.filter((r) => r.kind === "COMPARISON");
  const guides = results.filter((r) => r.kind === "AI_GUIDE" || r.kind === "BUYING_GUIDE");
  const typeHref = (t: SearchKind | null) => `/search?${new URLSearchParams({ q, ...(t ? { type: t.toLowerCase() } : {}) })}`;
  const withReviews = categories.filter((c) => c.count > 0);
  const shortcuts = [...(groups?.products ?? []).map((p) => ({ key: p.href, href: p.href, label: `${p.name} (${p.count})`, slug: null as string | null })), ...(groups?.categories ?? []).map((c) => ({ key: c.href, href: c.href, label: c.parent ? `${c.name} in ${c.parent}` : c.name, slug: c.slug })), ...(groups?.brands ?? []).map((b) => ({ key: b.href, href: b.href, label: b.name, slug: null as string | null }))];
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
                Products, categories and brands
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
          {q && (
            <nav aria-label="Filter by content type" style={{ marginBottom: 24 }}>
              <ul className="chips">
                {TYPES.map((t) => (
                  <li key={t.label}>
                    <Link className="chip" href={typeHref(t.value)} aria-current={t.value === type ? "page" : undefined}>
                      {t.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          {q && !results.length && (
            <EmptyState
              title={suggestion ? `Did you mean “${suggestion}”?` : "Try another product, brand or category."}
              action={suggestion ? <Link className="btn primary" href={`/search?q=${encodeURIComponent(suggestion)}`}>Search for {suggestion}</Link> : <Link className="btn" href="/match">Find my match instead</Link>}
            >
              Nothing published matches “{q}”{type ? ` in ${TYPES.find((t) => t.value === type)?.label.toLowerCase()}` : ""}.
            </EmptyState>
          )}
          {reviews.length > 0 && (
            <section aria-labelledby="r-title" style={{ marginBottom: 36 }}>
              <h2 id="r-title">Reviews</h2>
              <ReviewGrid reviews={reviews} eagerCount={3} />
            </section>
          )}
          {comparisons.length > 0 && (
            <section aria-labelledby="c-title" style={{ marginBottom: 36 }}>
              <h2 id="c-title">Comparisons</h2>
              <ReviewGrid reviews={comparisons} />
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
