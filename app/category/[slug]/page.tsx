import type { Prisma, TagType } from "@prisma/client";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Breadcrumbs, { breadcrumbJsonLd, type Crumb } from "@/components/breadcrumbs";
import CategoryIcon from "@/components/category-icon";
import DealLedger from "@/components/deal-ledger";
import EmptyState from "@/components/empty-state";
import FiltersToggle from "@/components/filters-toggle";
import JsonLd from "@/components/json-ld";
import { ReviewGrid } from "@/components/review-card";
import SponsoredSlot from "@/components/sponsored-slot";
import TrackOnce from "@/components/track-once";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { cardSelect, categoryCounts, facetCounts, latestByKind, trendingReviews, verifiedDealRows } from "@/lib/public/queries";
import { CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";
import { themeStyle } from "@/lib/taxonomy/themes";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 24;
type Search = { sub?: string; brand?: string; intent?: string; platform?: string; tier?: string; q?: string; page?: string };
type FilterKey = "sub" | "brand" | "intent" | "platform" | "tier";
const FILTERS: Array<{ key: FilterKey; type?: TagType; label: string }> = [
  { key: "sub", label: "Type" },
  { key: "brand", label: "Brand" },
  { key: "intent", type: "INTENT", label: "Use case" },
  { key: "platform", type: "PLATFORM", label: "Platform" },
  { key: "tier", type: "PRICE_TIER", label: "Price tier" },
];

function clean(v?: string) {
  return v && /^[a-z0-9-]{1,60}$/.test(v) ? v : undefined;
}

export async function generateMetadata({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Search> }): Promise<Metadata> {
  const { slug } = await params;
  const sp = await searchParams;
  const def = CATEGORY_BY_SLUG.get(slug);
  if (!def) return { title: "Category not found", robots: { index: false } };
  const count = (await categoryCounts()).find((c) => c.slug === slug)?.count ?? 0;
  const filtered = FILTERS.some((f) => sp[f.key]) || Boolean(sp.q) || (sp.page && sp.page !== "1");
  return {
    title: `${def.name} reviews`,
    description: `${def.description} Buyer-focused reviews with verified offers.`,
    alternates: { canonical: `/category/${slug}` },
    openGraph: { title: `${def.name} reviews`, description: def.description, url: `/category/${slug}` },
    // Empty or filtered listing pages are not indexed (avoids thin/duplicate pages).
    robots: count === 0 || filtered ? { index: false, follow: true } : undefined,
  };
}

export default async function CategoryPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Search> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const def = CATEGORY_BY_SLUG.get(slug);
  if (!def) notFound();

  const active = Object.fromEntries(FILTERS.map((f) => [f.key, clean(sp[f.key])])) as Record<FilterKey, string | undefined>;
  const q = (sp.q ?? "").trim().slice(0, 80);
  const terms = q.split(/\s+/).filter((t) => t.length >= 2).slice(0, 6);
  const page = Math.max(1, Math.min(500, Number(sp.page) || 1));
  const where: Prisma.NormalizedReviewWhereInput = {
    status: "PUBLISHED",
    categorySlug: slug,
    ...(active.sub ? { subcategorySlug: active.sub } : {}),
    ...(active.brand ? { brandSlug: active.brand } : {}),
    AND: [
      ...FILTERS.filter((f) => f.type && active[f.key]).map((f) => ({ assignments: { some: { active: true, tagType: f.type, categoryTag: { slug: active[f.key]! } } } })),
      ...terms.map((t) => ({ OR: [{ canonicalTitle: { contains: t, mode: "insensitive" as const } }, { productName: { contains: t, mode: "insensitive" as const } }, { brand: { contains: t, mode: "insensitive" as const } }, { summary: { contains: t, mode: "insensitive" as const } }] })),
    ],
  };
  const anyFilter = FILTERS.some((f) => active[f.key]) || terms.length > 0;

  const [total, reviews, facets, counts, guides, deals, trending] = await Promise.all([
    db.normalizedReview.count({ where }),
    db.normalizedReview.findMany({ where, orderBy: [{ publishedAt: "desc" }, { id: "asc" }], skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE, select: cardSelect }),
    facetCounts({ categorySlug: slug }),
    categoryCounts(),
    anyFilter ? Promise.resolve([]) : latestByKind("AI_GUIDE", 3, slug),
    anyFilter ? Promise.resolve([]) : verifiedDealRows({ categorySlug: slug, take: 4 }),
    anyFilter ? Promise.resolve([]) : trendingReviews(7, 30),
  ]);
  const categoryTotal = counts.find((c) => c.slug === slug)?.count ?? 0;
  const popular = trending.filter((t) => t.review.categorySlug === slug).slice(0, 3);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const options: Record<FilterKey, Array<{ slug: string; name: string; count: number }>> = {
    sub: def.subcategories.map((s) => ({ slug: s.slug, name: s.name, count: facets.sub.find((x) => x.slug === s.slug)?.count ?? 0 })).filter((o) => o.count > 0),
    brand: facets.brand,
    intent: facets.intent,
    platform: facets.platform,
    tier: facets.tier,
  };
  const hrefWith = (key: string, value?: string, extra: Record<string, string> = {}) => {
    const p = new URLSearchParams();
    for (const f of FILTERS) {
      const v = f.key === key ? value : active[f.key];
      if (v) p.set(f.key, v);
    }
    if (q && key !== "q") p.set("q", q);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    const s = p.toString();
    return `/category/${slug}${s ? `?${s}` : ""}`;
  };
  const crumbs: Crumb[] = [{ name: "Home", href: "/" }, { name: def.name, href: `/category/${slug}` }];
  const others = counts.filter((c) => c.slug !== slug && c.count > 0);
  const activeCount = FILTERS.filter((f) => active[f.key]).length;
  const compareIds = reviews.slice(0, 2).map((r) => r.id);

  return (
    <main style={themeStyle(slug) as React.CSSProperties}>
      <JsonLd data={breadcrumbJsonLd(crumbs, config.siteUrl())} />
      <TrackOnce event="category_view" categorySlug={slug} metadata={{ filters: active }} />
      <section className="page-hero on-ink">
        <div className="container">
          <Breadcrumbs items={crumbs} />
          <h1>
            <span className="swatch">
              <CategoryIcon slug={slug} size={28} />
            </span>
            {def.name}
          </h1>
          <p className="lede">
            {def.description} {categoryTotal ? `${categoryTotal === 1 ? "1 published review" : `${categoryTotal} published reviews`}.` : "No reviews are published here yet."}
          </p>
          <form action={`/category/${slug}`} role="search" className="searchbox wide" style={{ maxWidth: 560, marginTop: 18, display: "flex", gap: 8 }}>
            {FILTERS.filter((f) => active[f.key]).map((f) => (
              <input key={f.key} type="hidden" name={f.key} value={active[f.key]} />
            ))}
            <label htmlFor="cat-q" className="visually-hidden">
              Search {def.name.toLowerCase()}
            </label>
            <svg className="search-glyph" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            <input id="cat-q" name="q" type="search" defaultValue={q} maxLength={80} placeholder={`Search within ${def.name.toLowerCase()}`} />
            <button className="btn light" type="submit">
              Search
            </button>
          </form>
          <ul className="tabs" aria-label="On this page">
            <li>
              <a href="#results">{anyFilter ? "Results" : "All"}</a>
            </li>
            {popular.length > 0 && (
              <li>
                <a href="#popular">Popular</a>
              </li>
            )}
            {compareIds.length === 2 && (
              <li>
                <a href="#compare">Compare</a>
              </li>
            )}
            {guides.length > 0 && (
              <li>
                <a href="#guides">Guides</a>
              </li>
            )}
            {deals.length > 0 && (
              <li>
                <a href="#deals">Deals</a>
              </li>
            )}
          </ul>
          <SponsoredSlot position="CATEGORY_TOP" categorySlug={slug} />
        </div>
      </section>

      <section className="section" id="results" aria-labelledby="results-title">
        <div className="container with-filters">
          <aside className="filters" id="category-filters" aria-label="Filters">
            <h2>Filter {def.name.toLowerCase()}</h2>
            {FILTERS.map((f) =>
              options[f.key].length ? (
                <nav key={f.key} className="filter-group" aria-label={`Filter by ${f.label.toLowerCase()}`}>
                  <h3 aria-hidden="true">{f.label}</h3>
                  <Link href={hrefWith(f.key)} aria-current={!active[f.key] ? "true" : undefined}>
                    All
                  </Link>
                  {options[f.key].map((o) => (
                    <Link key={o.slug} href={hrefWith(f.key, o.slug)} aria-current={active[f.key] === o.slug ? "true" : undefined}>
                      {o.name}
                      <span className="c">
                        {o.count}
                        <span className="visually-hidden"> {o.count === 1 ? "review" : "reviews"}</span>
                      </span>
                    </Link>
                  ))}
                </nav>
              ) : null,
            )}
            {FILTERS.every((f) => !options[f.key].length) && <p className="small muted">Filters appear once reviews in this category are published.</p>}
          </aside>
          <div>
            <div className="result-bar">
              <h2 id="results-title" className="small" style={{ font: "600 15px var(--font-body)", margin: 0 }} aria-live="polite">
                {total === 1 ? "1 review" : `${total} reviews`}
                {q ? ` matching “${q}”` : ""}
              </h2>
              <div className="btnrow" style={{ margin: 0 }}>
                <FiltersToggle target="category-filters" activeCount={activeCount} />
                {anyFilter && (
                  <Link className="btn small" href={`/category/${slug}`}>
                    Clear all
                  </Link>
                )}
              </div>
            </div>
            {reviews.length ? (
              <ReviewGrid reviews={reviews} eagerCount={3} headingLevel={3} />
            ) : (
              <EmptyState title={anyFilter ? "No reviews match these filters." : "We’re waiting for the next verified review."} headingLevel={3} action={anyFilter ? <Link className="btn" href={`/category/${slug}`}>Clear filters</Link> : <Link className="btn" href="/reviews">Browse all reviews</Link>}>
                {anyFilter ? "Try removing a filter." : "Reviews appear here once they pass editorial QA."}
              </EmptyState>
            )}
            {pages > 1 && (
              <nav className="pagination" aria-label="Pagination">
                {page > 1 ? (
                  <Link className="btn" href={hrefWith("", undefined, { page: String(page - 1) })}>
                    Previous page
                  </Link>
                ) : null}
                <span className="muted">
                  Page {page} of {pages}
                </span>
                {page < pages ? (
                  <Link className="btn" href={hrefWith("", undefined, { page: String(page + 1) })}>
                    Next page
                  </Link>
                ) : null}
              </nav>
            )}
          </div>
        </div>
      </section>

      {popular.length > 0 && (
        <section className="section band" id="popular" aria-labelledby="popular-title">
          <div className="container">
            <div className="section-head">
              <div>
                <h2 id="popular-title">Popular in {def.name.toLowerCase()}</h2>
                <p>Most-read reviews in the last 7 days.</p>
              </div>
            </div>
            <ul className="ledger">
              {popular.map((t) => (
                <li key={t.review.id}>
                  <div className="ledger-row" style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
                    <Link className="l-title" href={`/review/${t.review.slug}`}>
                      {t.review.canonicalTitle}
                    </Link>
                    <span className="l-meta">{t.views} views this week</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {compareIds.length === 2 && !anyFilter && (
        <section className="section" id="compare" aria-labelledby="cmp-title">
          <div className="container">
            <div className="cta-final on-ink" style={themeStyle(slug) as React.CSSProperties}>
              <h2 id="cmp-title">Deciding between {reviews[0].productName} and {reviews[1].productName}?</h2>
              <p>Put them side by side. You can add a third product or swap either one.</p>
              <div className="btnrow">
                <Link className="btn light large" href={`/compare?ids=${compareIds.join(",")}`}>
                  Compare these two
                </Link>
                <Link className="btn ghost-ink large" href="/compare">
                  Choose other products
                </Link>
              </div>
            </div>
          </div>
        </section>
      )}

      {guides.length > 0 && (
        <section className="section band" id="guides" aria-labelledby="cg-title">
          <div className="container">
            <div className="section-head">
              <div>
                <h2 id="cg-title">{def.name} buying guides</h2>
                <p>AI-assisted and editor-approved. Not hands-on reviews.</p>
              </div>
            </div>
            <ReviewGrid reviews={guides} />
          </div>
        </section>
      )}

      {deals.length > 0 && (
        <section className="section" id="deals" aria-labelledby="cd-title">
          <div className="container">
            <div className="section-head">
              <h2 id="cd-title">Verified {def.name.toLowerCase()} deals</h2>
              <Link className="btn" href={`/deals?category=${slug}`}>
                All {def.name.toLowerCase()} deals
              </Link>
            </div>
            <DealLedger rows={deals} />
          </div>
        </section>
      )}

      {others.length > 0 && (
        <section className="section" aria-labelledby="other-cats">
          <div className="container">
            <h2 id="other-cats">Other categories</h2>
            <ul className="chips">
              {others.map((c) => (
                <li key={c.slug} style={themeStyle(c.slug) as React.CSSProperties}>
                  <Link className="chip" href={`/category/${c.slug}`}>
                    {c.name} ({c.count})
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </main>
  );
}
