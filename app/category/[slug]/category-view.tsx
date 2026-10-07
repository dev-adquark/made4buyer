import type { Prisma, TagType } from "@prisma/client";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Breadcrumbs, { breadcrumbJsonLd, type Crumb } from "@/components/breadcrumbs";
import DealLedger from "@/components/deal-ledger";
import EmptyState from "@/components/empty-state";
import FiltersToggle from "@/components/filters-toggle";
import JsonLd from "@/components/json-ld";
import { FeatureStory, ReviewGrid } from "@/components/review-card";
import SectionHeader from "@/components/section-header";
import SponsoredSlot from "@/components/sponsored-slot";
import TrackOnce from "@/components/track-once";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { CATEGORY_TYPES as TYPES, type CategoryFilterKey as FilterKey, type CategoryState } from "@/lib/public/listing-routes";
import { tagListingPage } from "@/lib/public/page-cache";
import { cardSelect, categoryCounts, facetCounts, latestByKind, trendingReviews, freshDealRows, LATEST_FIRST } from "@/lib/public/queries";
import { CATEGORIES, CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";
import { themeStyle } from "@/lib/taxonomy/themes";

/*
 * Rendered by three routes with the same markup (see lib/public/listing-routes.ts):
 *   page.tsx           the default view (ISR),
 *   v/[state]/page.tsx a filter/type/page state without free text (ISR, one entry per state),
 *   q/page.tsx         a search within the category (per request).
 */

export const PAGE_SIZE = 24;
const FILTERS: Array<{ key: FilterKey; type?: TagType; label: string }> = [
  { key: "sub", label: "Type" },
  { key: "brand", label: "Brand" },
  { key: "intent", type: "INTENT", label: "Use case" },
  { key: "platform", type: "PLATFORM", label: "Platform" },
  { key: "tier", type: "PRICE_TIER", label: "Price tier" },
];

export async function categoryMetadata(slug: string, state: CategoryState): Promise<Metadata> {
  const def = CATEGORY_BY_SLUG.get(slug);
  if (!def) return { title: "Category not found", robots: { index: false } };
  const count = (await categoryCounts()).find((c) => c.slug === slug)?.count ?? 0;
  return {
    title: `${def.name} reviews`,
    description: `${def.description} Buyer-focused reviews with recently checked prices.`,
    alternates: { canonical: `/category/${slug}` },
    openGraph: { siteName: "Made4Buyers", type: "website", title: `${def.name} reviews`, description: def.description, url: `/category/${slug}` },
    // Empty or filtered listing pages are not indexed (avoids thin/duplicate pages).
    robots: count === 0 || state.noindex ? { index: false, follow: true } : undefined,
  };
}

/** The category listing for one filter state (the default view, a cached filter state or a search). */
export async function CategoryView({ slug, state }: { slug: string; state: CategoryState }) {
  const def = CATEGORY_BY_SLUG.get(slug);
  if (!def) notFound();
  // Cached views are purged by publishes (content) and by the commerce engine (the price ledger).
  await tagListingPage({ commerce: true });

  const { active, q, page, type } = state;
  const terms = q.split(/\s+/).filter((t) => t.length >= 2).slice(0, 6);
  const where: Prisma.NormalizedReviewWhereInput = {
    status: "PUBLISHED",
    categorySlug: slug,
    ...(type ? { kind: { in: [...type.kinds] } } : {}),
    ...(active.sub ? { subcategorySlug: active.sub } : {}),
    ...(active.brand ? { brandSlug: active.brand } : {}),
    AND: [
      ...FILTERS.filter((f) => f.type && active[f.key]).map((f) => ({ assignments: { some: { active: true, tagType: f.type, categoryTag: { slug: active[f.key]! } } } })),
      ...terms.map((t) => ({ OR: [{ canonicalTitle: { contains: t, mode: "insensitive" as const } }, { productName: { contains: t, mode: "insensitive" as const } }, { brand: { contains: t, mode: "insensitive" as const } }, { summary: { contains: t, mode: "insensitive" as const } }] })),
    ],
  };
  const anyFilter = FILTERS.some((f) => active[f.key]) || terms.length > 0 || Boolean(type);

  const [total, reviews, facets, counts, guides, deals, trending, products, kindCounts] = await Promise.all([
    db.normalizedReview.count({ where }),
    db.normalizedReview.findMany({ where, orderBy: LATEST_FIRST, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE, select: cardSelect }),
    facetCounts({ categorySlug: slug }),
    categoryCounts(),
    anyFilter ? Promise.resolve([]) : latestByKind(["AI_GUIDE", "BUYING_GUIDE"], 3, slug),
    anyFilter ? Promise.resolve([]) : freshDealRows({ categorySlug: slug, take: 4 }),
    anyFilter ? Promise.resolve([]) : trendingReviews(7, 30),
    // Products and services with published content in this category (product hubs).
    db.productEntity.findMany({
      where: { content: { some: { review: { status: "PUBLISHED", categorySlug: slug } } } },
      select: { slug: true, name: true, _count: { select: { content: { where: { review: { status: "PUBLISHED" } } } } } },
      orderBy: { content: { _count: "desc" } },
      take: 24,
    }),
    db.normalizedReview.groupBy({ by: ["kind"], where: { status: "PUBLISHED", categorySlug: slug }, _count: { _all: true } }),
  ]);
  const kindCount = (kinds: readonly string[]) => kindCounts.filter((k) => kinds.includes(k.kind)).reduce((n, k) => n + k._count._all, 0);
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
    if (key === "type") {
      if (value) p.set("type", value);
    } else if (type) p.set("type", type.param);
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
      <section className="page-hero has-issue">
        <div className="wrap">
          <div className="ph-top">
            <Breadcrumbs items={crumbs} />
            <span className="label muted">{categoryTotal === 1 ? "1 published review" : `${categoryTotal} published reviews`}</span>
          </div>
          <div className="ph-title">
            <span className="issue-no" aria-hidden="true">
              {String(CATEGORIES.findIndex((c) => c.slug === slug) + 1).padStart(2, "0")}
            </span>
            <h1 style={{ marginBottom: 0 }}>{def.name}</h1>
          </div>
          <p className="lede" style={{ marginTop: 18 }}>
            {def.description} {categoryTotal ? "" : "No reviews are published here yet."}
          </p>
          <form action={`/category/${slug}`} role="search" className="searchbox wide" style={{ maxWidth: 620, marginTop: 18, display: "flex", gap: 8 }}>
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
            <button className="btn primary" type="submit">
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
                <a href="#deals">Prices</a>
              </li>
            )}
          </ul>
          <SponsoredSlot position="CATEGORY_TOP" categorySlug={slug} />
        </div>
      </section>

      {!anyFilter && page === 1 && reviews[0] && (
        <section className="section tight" aria-labelledby="lead-title">
          <div className="wrap">
            <h2 id="lead-title" className="visually-hidden">
              Lead story
            </h2>
            <div className="lead-grid">
              <FeatureStory review={reviews[0]} />
              <div>
                <span className="label muted">In this issue</span>
                <ul className="story-list" style={{ marginTop: 10 }}>
                  {options.sub.map((o) => (
                    <li key={o.slug}>
                      <Link className="ledger-row" style={{ gridTemplateColumns: "minmax(0, 1fr) auto", textDecoration: "none" }} href={hrefWith("sub", o.slug)}>
                        <span className="l-title">{o.name}</span>
                        <span className="l-meta">
                          {o.count} {o.count === 1 ? "review" : "reviews"}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>
      )}

      <section className="section" id="results" aria-labelledby="results-title">
        <div className="wrap with-filters">
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
                {total === 1 ? `1 ${type ? type.label.toLowerCase().replace(/s$/, "") : "item"}` : `${total} ${type ? type.label.toLowerCase() : "items"}`}
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
            {kindCounts.length > 1 || type ? (
              <nav aria-label="Filter by content type" style={{ margin: "0 0 18px" }}>
                <ul className="chips">
                  <li>
                    <Link className="chip" href={hrefWith("type")} aria-current={!type ? "page" : undefined}>
                      Everything
                    </Link>
                  </li>
                  {TYPES.filter((t) => kindCount(t.kinds) > 0).map((t) => (
                    <li key={t.param}>
                      <Link className="chip" href={hrefWith("type", t.param)} aria-current={type?.param === t.param ? "page" : undefined}>
                        {t.label} ({kindCount(t.kinds)})
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            ) : null}
            {reviews.length ? (
              <ReviewGrid reviews={reviews} eagerCount={3} headingLevel={3} />
            ) : (
              <EmptyState title={anyFilter ? "No reviews match these filters." : "We’re waiting for the next published review."} headingLevel={3} action={anyFilter ? <Link className="btn" href={`/category/${slug}`}>Clear filters</Link> : <Link className="btn" href="/reviews">Browse all reviews</Link>}>
                {anyFilter ? "Try removing a filter." : "Reviews appear here once they pass our automatic checks."}
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
        <section className="section" id="popular" aria-labelledby="popular-title">
          <div className="wrap">
            <SectionHeader id="popular-title" label="Last 7 days" title={`Popular in ${def.name.toLowerCase()}`}>
              Most-read reviews, by real page views.
            </SectionHeader>
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
          <div className="wrap">
            <div className="ink-section on-dark" style={{ padding: "clamp(28px, 4vw, 56px)" }}>
              <span className="label muted">Compare</span>
              <h2 id="cmp-title" style={{ color: "#fff", textTransform: "uppercase", margin: "10px 0 14px", maxWidth: "18ch" }}>
                {reviews[0].productName} or {reviews[1].productName}?
              </h2>
              <p className="muted" style={{ fontFamily: "var(--f-read)", fontSize: 19 }}>Put them side by side. You can add a third product or swap either one.</p>
              <div className="btnrow">
                <Link className="btn primary large" href={`/compare?ids=${compareIds.join(",")}`} data-cursor="Compare">
                  Compare these two
                </Link>
                <Link className="btn large" href="/compare">
                  Choose other products
                </Link>
              </div>
            </div>
          </div>
        </section>
      )}

      {products.length > 0 && !anyFilter && (
        <section className="section tight" aria-labelledby="cp-title">
          <div className="wrap">
            <SectionHeader id="cp-title" label={`${products.length} ${products.length === 1 ? "product" : "products"}`} title={`Products and services in ${def.name}`}>
              Each one links to every review, comparison and guide that covers it.
            </SectionHeader>
            <ul className="entity-list">
              {products.map((p) => (
                <li key={p.slug}>
                  <Link href={`/product/${p.slug}`}>{p.name}</Link> <span className="small">({p._count.content})</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
      {guides.length > 0 && (
        <section className="section" id="guides" aria-labelledby="cg-title">
          <div className="wrap">
            <SectionHeader id="cg-title" label="Latest" title={`${def.name} buying guides`}>
              Buying guides from named publishers and from Made4Buyers.
            </SectionHeader>
            <ReviewGrid reviews={guides} />
          </div>
        </section>
      )}

      {deals.length > 0 && (
        <section className="section" id="deals" aria-labelledby="cd-title">
          <div className="wrap">
            <SectionHeader id="cd-title" label={`${deals.length} shown`} title={`Current ${def.name.toLowerCase()} prices`} action={<Link className="arrow-link" href={`/deals?category=${slug}`}>All {def.name.toLowerCase()} prices</Link>} />
            <DealLedger rows={deals} />
          </div>
        </section>
      )}

      {others.length > 0 && (
        <section className="section" aria-labelledby="other-cats">
          <div className="wrap">
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
