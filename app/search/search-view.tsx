import type { Metadata } from "next";
import Link from "next/link";
import Breadcrumbs from "@/components/breadcrumbs";
import CategoryIcon from "@/components/category-icon";
import EmptyState from "@/components/empty-state";
import { PriceDropGrid, PromoCodeGrid } from "@/components/official-deals";
import { ReviewGrid } from "@/components/review-card";
import SearchCombobox from "@/components/search-combobox";
import TrackOnce from "@/components/track-once";
import { couponMaxAgeDays } from "@/lib/commerce/deal-status";
import type { SearchKind } from "@/lib/public/queries";
import { searchCommerce, type CommerceSearch } from "@/lib/public/search";
import { themeStyle } from "@/lib/taxonomy/themes";
import { cachedCategoryCounts, cachedDidYouMean, cachedSearchGroups, cachedSearchReviews } from "./data";
import "../deals/deals.css";

/*
 * Rendered by page.tsx (no query: the search box and categories, cached) and q/page.tsx (`?q=`,
 * rewritten there by proxy.ts; per request, with its content results cached per query: ./data.ts).
 */

export const searchMetadata: Metadata = { title: "Search", description: "Search Made4Buyers reviews, guides, products, brands, verified deals and coupons.", robots: { index: false, follow: true }, alternates: { canonical: "/search" } };

export type TypeValue = SearchKind | "DEALS" | null;
const TYPES: Array<{ value: TypeValue; label: string }> = [
  { value: null, label: "Everything" },
  { value: "REVIEW", label: "Reviews" },
  { value: "COMPARISON", label: "Comparisons" },
  { value: "GUIDE", label: "Guides" },
  { value: "DEALS", label: "Deals & coupons" },
];

const NO_COMMERCE: CommerceSearch = { drops: [], dropCount: 0, coupons: [], couponCount: 0, brands: [] };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Search: real published content (reviews, comparisons, guides), the products, categories and brands
 * they cover, and the verified commerce data /deals shows (current price drops and the latest
 * verified coupons, matched by product or brand). Grouped, each group with its count; nothing is
 * listed that the database does not hold.
 */
/** The content type filter (`?type=`) as the page reads it. */
export function searchType(raw: string | undefined): TypeValue {
  return TYPES.find((t) => t.value && t.value.toLowerCase() === (raw ?? "").toLowerCase())?.value ?? null;
}

/** Search results for a trimmed query (at most 100 characters; empty = the search landing view). */
export async function SearchView({ q, type }: { q: string; type: TypeValue }) {
  const contentType = type === "DEALS" ? null : type;
  const [results, groups, categories, commerce] = await Promise.all([
    q && type !== "DEALS" ? cachedSearchReviews(q, contentType) : Promise.resolve([]),
    q.length >= 2 ? cachedSearchGroups(q) : Promise.resolve(null),
    cachedCategoryCounts(),
    q.length >= 2 && (type === null || type === "DEALS") ? searchCommerce(q).catch(() => NO_COMMERCE) : Promise.resolve(NO_COMMERCE),
  ]);
  const reviews = results.filter((r) => r.kind === "REVIEW");
  const comparisons = results.filter((r) => r.kind === "COMPARISON");
  const guides = results.filter((r) => r.kind === "AI_GUIDE" || r.kind === "BUYING_GUIDE");
  const products = type === "DEALS" ? [] : (groups?.products ?? []);
  const categoryHits = type === "DEALS" ? [] : (groups?.categories ?? []);
  // Brands: review brands (brand page or a brand search) and commerce brands with verified offers (their deals), one entry per name.
  const brandHits: Array<{ key: string; name: string; href: string; detail: string }> = [];
  for (const b of type === "DEALS" ? [] : (groups?.brands ?? [])) brandHits.push({ key: `r:${b.href}`, name: b.name, href: b.href, detail: plural(b.count, "article", "articles") });
  for (const b of commerce.brands) {
    if (brandHits.some((x) => x.name.toLowerCase() === b.name.toLowerCase() && x.href.startsWith("/deals"))) continue;
    const parts = [b.drops ? plural(b.drops, "price drop", "price drops") : null, b.coupons ? plural(b.coupons, "coupon", "coupons") : null, b.prices ? plural(b.prices, "current price", "current prices") : null].filter(Boolean);
    brandHits.push({ key: `c:${b.slug}`, name: `${b.name} deals`, href: b.href, detail: parts.join(", ") });
  }
  const nothing = !results.length && !products.length && !commerce.dropCount && !commerce.couponCount && !brandHits.length && !categoryHits.length;
  const suggestion = q && !results.length && !products.length && !commerce.dropCount && !commerce.couponCount ? await cachedDidYouMean(q) : null;
  const typeHref = (t: TypeValue) => `/search?${new URLSearchParams({ q, ...(t ? { type: t.toLowerCase() } : {}) })}`;
  const withReviews = categories.filter((c) => c.count > 0);
  const jump = [
    { id: "products-title", label: "Products", count: products.length },
    { id: "r-title", label: "Reviews", count: reviews.length },
    { id: "c-title", label: "Comparisons", count: comparisons.length },
    { id: "g-title", label: "Guides", count: guides.length },
    { id: "d-title", label: "Deals", count: commerce.dropCount },
    { id: "k-title", label: "Coupons", count: commerce.couponCount },
    { id: "brands-title", label: "Brands", count: brandHits.length },
    { id: "cats-title", label: "Categories", count: categoryHits.length },
  ].filter((g) => g.count > 0);
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
          {q && jump.length > 0 && (
            <nav aria-label="Result groups" className="search-groups" style={{ marginBottom: 24 }}>
              <ul className="chips">
                {jump.map((g) => (
                  <li key={g.id}>
                    <a className="chip" href={`#${g.id}`}>
                      {g.label} ({g.count})
                    </a>
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
          {q && nothing && (
            <EmptyState
              title={suggestion ? `Did you mean “${suggestion}”?` : "Try another product, brand or category."}
              action={suggestion ? <Link className="btn primary" href={`/search?q=${encodeURIComponent(suggestion)}`}>Search for {suggestion}</Link> : <Link className="btn" href="/match">Find my match instead</Link>}
            >
              Nothing published or verified matches “{q}”{type ? ` in ${TYPES.find((t) => t.value === type)?.label.toLowerCase()}` : ""}.
            </EmptyState>
          )}
          {q && !nothing && !results.length && suggestion && (
            <p className="small muted" style={{ marginBottom: 24 }}>
              No articles match “{q}”. <Link href={`/search?q=${encodeURIComponent(suggestion)}`}>Search for {suggestion}</Link> instead?
            </p>
          )}
          {products.length > 0 && (
            <section aria-labelledby="products-title" style={{ marginBottom: 32 }}>
              <h2 id="products-title" style={{ fontSize: 20 }}>
                Products <span className="muted">({products.length})</span>
              </h2>
              <ul className="chips">
                {products.map((p) => (
                  <li key={p.href}>
                    <Link className="chip" href={p.href}>
                      {p.name} ({p.count})
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {reviews.length > 0 && (
            <section aria-labelledby="r-title" style={{ marginBottom: 36 }}>
              <h2 id="r-title">
                Reviews <span className="muted">({reviews.length})</span>
              </h2>
              <ReviewGrid reviews={reviews} eagerCount={3} />
            </section>
          )}
          {comparisons.length > 0 && (
            <section aria-labelledby="c-title" style={{ marginBottom: 36 }}>
              <h2 id="c-title">
                Comparisons <span className="muted">({comparisons.length})</span>
              </h2>
              <ReviewGrid reviews={comparisons} />
            </section>
          )}
          {guides.length > 0 && (
            <section aria-labelledby="g-title" style={{ marginBottom: 36 }}>
              <h2 id="g-title">
                Buying guides <span className="muted">({guides.length})</span>
              </h2>
              <ReviewGrid reviews={guides} />
            </section>
          )}
          {commerce.dropCount > 0 && (
            <section aria-labelledby="d-title" style={{ marginBottom: 36 }}>
              <h2 id="d-title">
                Verified price drops <span className="muted">({commerce.dropCount})</span>
              </h2>
              <PriceDropGrid drops={commerce.drops} />
              {commerce.dropCount > commerce.drops.length && (
                <p className="small" style={{ marginTop: 12 }}>
                  <Link href="/deals">All verified deals</Link>
                </p>
              )}
            </section>
          )}
          {commerce.couponCount > 0 && (
            <section aria-labelledby="k-title" style={{ marginBottom: 36 }}>
              <h2 id="k-title">
                Latest verified coupons <span className="muted">({commerce.couponCount})</span>
              </h2>
              <p className="small muted">Published on the brand’s own site and verified there within the last {couponMaxAgeDays()} days.</p>
              <PromoCodeGrid codes={commerce.coupons} />
            </section>
          )}
          {brandHits.length > 0 && (
            <section aria-labelledby="brands-title" style={{ marginBottom: 32 }}>
              <h2 id="brands-title" style={{ fontSize: 20 }}>
                Brands <span className="muted">({brandHits.length})</span>
              </h2>
              <ul className="chips">
                {brandHits.map((b) => (
                  <li key={b.key}>
                    <Link className="chip" href={b.href}>
                      {b.name} ({b.detail})
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {categoryHits.length > 0 && (
            <section aria-labelledby="cats-title" style={{ marginBottom: 32 }}>
              <h2 id="cats-title" style={{ fontSize: 20 }}>
                Categories <span className="muted">({categoryHits.length})</span>
              </h2>
              <ul className="chips">
                {categoryHits.map((c) => (
                  <li key={c.href} style={themeStyle(c.slug) as React.CSSProperties}>
                    <Link className="chip" href={c.href}>
                      <CategoryIcon slug={c.slug} size={16} />
                      {c.parent ? `${c.name} in ${c.parent}` : c.name}
                    </Link>
                  </li>
                ))}
              </ul>
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
