import type { Metadata } from "next";
import Link from "next/link";
import Collage from "@/components/collage";
import DealLedger from "@/components/deal-ledger";
import EmptyState from "@/components/empty-state";
import JsonLd from "@/components/json-ld";
import ReviewCard, { FeatureStory, ReviewGrid } from "@/components/review-card";
import SafeImg from "@/components/safe-img";
import SearchCombobox from "@/components/search-combobox";
import SectionHeader from "@/components/section-header";
import SponsoredSlot from "@/components/sponsored-slot";
import Ticker, { type TickerItem } from "@/components/ticker";
import TrustLabel from "@/components/trust-label";
import { config } from "@/lib/config";
import { placeholderPath } from "@/lib/pipeline/images";
import { categoryPhotos } from "@/lib/public/category-images";
import { cardImage, categoryLedger, comparePair, latestByKind, trendingReviews, trustStats, verifiedDealRows } from "@/lib/public/queries";
import { CATEGORIES, categoryName, subcategoryName } from "@/lib/taxonomy/definitions";
import { themeStyle } from "@/lib/taxonomy/themes";
import { dateline, money } from "@/lib/util/format";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { alternates: { canonical: "/" } };

const style = (slug: string | null | undefined) => themeStyle(slug) as React.CSSProperties;
const NA = <span className="na">Not available</span>;

export default async function Home() {
  // Photos depend only on the static taxonomy, so they load alongside the database queries.
  const [reviews, guides, comparisons, ledger, deals, trending, pair, stats, photos] = await Promise.all([
    latestByKind("REVIEW", 6),
    latestByKind(["AI_GUIDE", "BUYING_GUIDE"], 3),
    latestByKind("COMPARISON", 3),
    categoryLedger(),
    verifiedDealRows({ take: 6 }),
    trendingReviews(7, 4),
    comparePair(),
    trustStats(),
    categoryPhotos(CATEGORIES.map((c) => c.slug)).catch(() => ({}) as Record<string, null>),
  ]);
  const site = config.siteUrl();
  const lead = reviews[0];
  const heroDeal = deals[0];
  const specSource = pair?.[0];
  const activeCats = ledger.filter((c) => c.reviews + c.comparisons + c.guides > 0);
  const tickerItems: TickerItem[] = [
    ...reviews.map((r) => ({ key: `r-${r.id}`, href: `/review/${r.slug}`, label: "Latest review", text: r.productName, slug: r.categorySlug })),
    ...deals.slice(0, 4).map((d) => ({ key: `d-${d.linkId}`, href: `/review/${d.review.slug}#deal`, label: "Verified deal", text: `${d.review.productName}${money(d.price, d.currency) ? ` ${money(d.price, d.currency)}` : ""}`, slug: d.review.categorySlug })),
    ...guides.map((g) => ({ key: `g-${g.id}`, href: `/review/${g.slug}`, label: g.kind === "AI_GUIDE" ? "AI-assisted guide" : "Buying guide", text: g.productName, slug: g.categorySlug })),
    ...ledger.map((c) => ({ key: `c-${c.slug}`, href: `/category/${c.slug}`, label: c.reviews ? `${c.reviews} ${c.reviews === 1 ? "review" : "reviews"}` : "Category", text: c.name, slug: c.slug })),
  ];

  return (
    <main>
      <JsonLd data={{ "@context": "https://schema.org", "@type": "WebSite", name: "Made4Buyers", url: site, potentialAction: { "@type": "SearchAction", target: `${site}/search?q={search_term_string}`, "query-input": "required name=search_term_string" } }} />

      {/* ── The statement ── */}
      <section className="tear-hero" aria-labelledby="hero-title">
        <div className="wrap">
          <div className="hero-dateline">
            <span className="label">Edition of {dateline(new Date())}</span>
            <span className="label muted">
              {stats.published} {stats.published === 1 ? "review" : "reviews"}
              {stats.comparisons ? `, ${stats.comparisons} ${stats.comparisons === 1 ? "comparison" : "comparisons"}` : ""} published, {stats.verifiedOffers} verified {stats.verifiedOffers === 1 ? "offer" : "offers"} live
            </span>
          </div>
          <h1 id="hero-title" className="statement">
            <span className="line">Buy less.</span>{" "}
            <span className="line indent">Buy right.</span>
          </h1>
          <div className="hero-body">
            <div className="hero-copy">
              <p className="lede">A buying guide for everything you buy: reviews filed by what you need, comparisons built only from facts we hold, and offers we check before we show them. We’re starting with technology.</p>
              <SearchCombobox variant="hero" label="Search products, brands and guides" />
              <div className="btnrow">
                <Link className="btn primary large" href="/match" data-cursor="Start">
                  Find my match
                </Link>
                <Link className="btn large" href="/compare" data-cursor="Compare">
                  Compare products
                </Link>
              </div>
              <ul className="hero-annotations" aria-label="Counted from our database">
                <li>
                  <span className="n">{stats.published}</span>
                  <span className="label muted">Reviews published</span>
                </li>
                <li>
                  <span className="n">{stats.verifiedOffers}</span>
                  <span className="label muted">Verified offers</span>
                </li>
                <li>
                  <span className="n">{stats.checkedThisWeek}</span>
                  <span className="label muted">Links re-checked this week</span>
                </li>
              </ul>
              <SponsoredSlot position="HOME_HERO" />
            </div>

            <Collage label="On the cutting table">
              {lead ? (
                <Link className="clip photo crop" href={`/review/${lead.slug}`} data-depth="1.2" data-cursor="Read" style={style(lead.categorySlug)}>
                  <span className="tape" aria-hidden="true" />
                  <SafeImg src={cardImage(lead).url} fallback={placeholderPath(lead.categorySlug)} alt="" width={380} height={285} />
                  <span className="clip-body">
                    <span className="cat-tag">{categoryName(lead.categorySlug) ?? "General"}</span>
                    <span className="clip-title">{lead.productName}</span>
                    <span className="label muted">Latest review, {dateline(lead.sourcePublishedAt ?? lead.publishedAt)}</span>
                  </span>
                </Link>
              ) : (
                <div className="clip note" data-depth="1">
                  <span className="label muted">Status</span>
                  The first reviews are on their way. They appear here once they pass our editorial checks.
                </div>
              )}
              {heroDeal ? (
                <Link className="clip deal" href={`/review/${heroDeal.review.slug}#deal`} data-depth="0.7" data-cursor="View deal" style={style(heroDeal.review.categorySlug)}>
                  <span className="clip-body">
                    <TrustLabel kind="verified" />
                    <span className="price">{money(heroDeal.price, heroDeal.currency) ?? "At retailer"}</span>
                    <span className="clip-title" style={{ fontSize: 15 }}>
                      {heroDeal.review.productName}
                    </span>
                    <span className="label muted">
                      {heroDeal.merchant ?? "Retailer not reported"}, checked {dateline(heroDeal.verifiedAt)}
                    </span>
                  </span>
                </Link>
              ) : (
                <div className="clip deal" data-depth="0.7" style={{ borderTopColor: "var(--rule-strong)" }}>
                  <span className="clip-body">
                    <TrustLabel kind="none">No verified offers yet</TrustLabel>
                    <span className="clip-title" style={{ fontSize: 15 }}>
                      We only show an offer after following its link to the retailer.
                    </span>
                  </span>
                </div>
              )}
              {specSource ? (
                <Link className="clip spec" href={`/review/${specSource.slug}`} data-depth="1.6" data-cursor="Read" style={style(specSource.categorySlug)}>
                  <span className="clip-body">
                    <span className="label">Spec sheet: {specSource.productName}</span>
                    <dl>
                      <dt>Brand</dt>
                      <dd>{specSource.brand ?? NA}</dd>
                      <dt>Type</dt>
                      <dd>{subcategoryName(specSource.categorySlug, specSource.subcategorySlug) ?? specSource.entities?.deviceType ?? NA}</dd>
                      <dt>Platform</dt>
                      <dd>{specSource.entities?.platform ?? NA}</dd>
                      <dt>Price tier</dt>
                      <dd>{specSource.assignments[0]?.categoryTag.name ?? NA}</dd>
                    </dl>
                  </span>
                </Link>
              ) : (
                <div className="clip spec" data-depth="1.6">
                  <span className="clip-body">
                    <span className="label">What we check</span>
                    <dl>
                      <dt>Source</dt>
                      <dd>Named publisher</dd>
                      <dt>Product</dt>
                      <dd>Brand, model, platform</dd>
                      <dt>Offer</dt>
                      <dd>Link reaches retailer</dd>
                      <dt>Missing</dt>
                      <dd>Shown as missing</dd>
                    </dl>
                  </span>
                </div>
              )}
              {(activeCats.length ? activeCats : ledger).slice(0, 3).map((c, i) => (
                <Link key={c.slug} className="clip label" href={`/category/${c.slug}`} data-depth={String(0.5 + i * 0.4)} style={{ ...style(c.slug), top: `${[46, 4, 72][i]}%`, left: `${[46, 60, 28][i]}%`, ["--rot" as string]: `${[-4, 2, 5][i]}deg` }}>
                  {c.name}
                </Link>
              ))}
            </Collage>
          </div>
        </div>
      </section>

      <Ticker items={tickerItems} label="Running now" />

      {/* ── Worth buying now ── */}
      <section className="section" aria-labelledby="now-title">
        <div className="wrap">
          <SectionHeader id="now-title" label={`${stats.published} published`} title="Worth buying now" action={reviews.length ? <Link className="arrow-link" href="/reviews">All reviews</Link> : undefined}>
            The newest reviews from named publishers, newest by the source’s own date.
          </SectionHeader>
          {lead ? (
            <div className="lead-grid">
              <FeatureStory review={lead} />
              <ul className="story-list" aria-label="More reviews">
                {reviews.slice(1, 6).map((r) => (
                  <li key={r.id} className="reveal">
                    <ReviewCard review={r} variant="row" />
                  </li>
                ))}
                {reviews.length === 1 && (
                  <li>
                    <p className="muted" style={{ padding: "16px 0" }}>
                      More reviews appear here as they pass QA.
                    </p>
                  </li>
                )}
              </ul>
            </div>
          ) : (
            <EmptyState title="The first reviews are on their way." label="Reviews" action={<Link className="btn" href="/about">How reviews get here</Link>}>
              Every review comes from a named publisher and passes our checks before it’s published. Nothing here is a placeholder.
            </EmptyState>
          )}
        </div>
      </section>

      {/* ── Category issues ── */}
      <section className="section tight" aria-labelledby="cats-title">
        <div className="wrap">
          <SectionHeader id="cats-title" label={`${ledger.length} categories`} title="The categories">
            Swipe or scroll sideways. Each category is an issue with its own colour.
          </SectionHeader>
        </div>
        <ul className="issue-rail" aria-label="Categories">
          {/* Categories with published content first; numbers stay each category's issue number. */}
          {ledger
            .map((c, i) => ({ ...c, issue: i + 1 }))
            .sort((a, b) => Number(b.reviews + b.comparisons + b.guides > 0) - Number(a.reviews + a.comparisons + a.guides > 0) || a.issue - b.issue)
            .map((c) => {
            const photo = (photos as Record<string, { url: string; alt: string; photographer: string } | null>)[c.slug];
            return (
              <li key={c.slug} style={style(c.slug)}>
                <Link className="issue-panel" href={`/category/${c.slug}`} data-cursor="Open">
                  <span className="ip-num">
                    <span aria-hidden="true">{String(c.issue).padStart(2, "0")}</span>
                    <span className="cat-tag">Issue</span>
                  </span>
                  <h3>{c.name}</h3>
                  <span className="ip-media">
                    {photo ? (
                      <>
                        <SafeImg src={photo.url} fallback={placeholderPath(c.slug)} alt="" width={400} height={500} loading="lazy" decoding="async" />
                        <span className="credit">Photo: {photo.photographer} / Pexels</span>
                      </>
                    ) : (
                      <span className="fallback" aria-hidden="true">
                        {c.name.slice(0, 1)}
                      </span>
                    )}
                  </span>
                  <span>
                    <p>{c.description}</p>
                    <dl>
                      <div>
                        <dt>Reviews</dt>
                        <dd>{c.reviews}</dd>
                      </div>
                      <div>
                        <dt>Comparisons</dt>
                        <dd>{c.comparisons}</dd>
                      </div>
                      <div>
                        <dt>Guides</dt>
                        <dd>{c.guides}</dd>
                      </div>
                      <div>
                        <dt>Deals</dt>
                        <dd>{c.deals}</dd>
                      </div>
                    </dl>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      {/* ── Verified deals ── */}
      <section className="section" aria-labelledby="deals-title">
        <div className="wrap">
          <SectionHeader id="deals-title" label={`${stats.verifiedOffers} live`} title="Real deals, checked first" action={deals.length ? <Link className="arrow-link" href="/deals">All verified deals</Link> : undefined}>
            Prices and merchants are the retailer’s, as reported. We followed each link before listing it.
          </SectionHeader>
          {deals.length ? (
            <DealLedger rows={deals.slice(0, 6)} />
          ) : (
            <EmptyState title="No verified offers yet." label="Deals">
              We list an offer only after following its link to the retailer, and we re-check it on a schedule. New offers appear here automatically.
            </EmptyState>
          )}
        </div>
      </section>

      {/* ── Trending (only when the data supports it) ── */}
      {trending.length > 0 && (
        <section className="section tight" aria-labelledby="trend-title">
          <div className="wrap">
            <SectionHeader id="trend-title" label="Last 7 days" title="Most read this week">
              Ranked by real page views over the last 7 days.
            </SectionHeader>
            <ReviewGrid reviews={trending.map((t) => t.review)} layout="ruled" />
          </div>
        </section>
      )}

      {/* ── Compare ── */}
      <section className="section" aria-labelledby="cmp-title">
        <div className="wrap">
          <SectionHeader id="cmp-title" label="Up to 3 products" title="Side by side" action={<Link className="arrow-link" href="/compare">Open the compare workspace</Link>}>
            Only facts we hold. Where we don’t know something, the comparison says so.
          </SectionHeader>
          {pair && pair.length === 2 ? (
            <>
              <div className="duel" style={style(pair[0].categorySlug)}>
                {pair.map((p, i) => (
                  <div key={p.id} style={{ display: "contents" }}>
                    {i === 1 && (
                      <div className="duel-vs" aria-hidden="true">
                        versus
                      </div>
                    )}
                    <div className="duel-side">
                      <SafeImg src={cardImage(p).url} fallback={placeholderPath(p.categorySlug)} alt="" width={640} height={360} loading="lazy" />
                      <h3>
                        <Link href={`/review/${p.slug}`} data-cursor="Read">
                          {p.productName}
                        </Link>
                      </h3>
                      <dl className="facts">
                        <dt>Brand</dt>
                        <dd>{p.brand ?? NA}</dd>
                        <dt>Type</dt>
                        <dd>{subcategoryName(p.categorySlug, p.subcategorySlug) ?? p.entities?.deviceType ?? NA}</dd>
                        <dt>Platform</dt>
                        <dd>{p.entities?.platform ?? NA}</dd>
                        <dt>Price tier</dt>
                        <dd>{p.assignments[0]?.categoryTag.name ?? NA}</dd>
                      </dl>
                    </div>
                  </div>
                ))}
              </div>
              <div className="btnrow">
                <Link className="btn primary" href={`/compare?ids=${pair.map((p) => p.id).join(",")}`} data-cursor="Compare">
                  See the full comparison
                </Link>
              </div>
            </>
          ) : (
            <EmptyState title="Comparisons start with two reviews." label="Compare" compact action={<Link className="btn" href="/compare">Open the compare workspace</Link>}>
              As soon as two products in the same category are reviewed, a head-to-head appears here.
            </EmptyState>
          )}
        </div>
      </section>

      {/* ── Comparisons (only when real ones exist) ── */}
      {comparisons.length > 0 && (
        <section className="section tight" aria-labelledby="cmp-title">
          <div className="wrap">
            <SectionHeader id="cmp-title" label={`${stats.comparisons} published`} title="Head-to-head comparisons" action={<Link className="arrow-link" href="/reviews?type=comparison">All comparisons</Link>}>
              Publishers’ side-by-side comparisons, filed under every product they cover.
            </SectionHeader>
            <ReviewGrid reviews={comparisons} layout="ruled" />
          </div>
        </section>
      )}

      {/* ── Guides ── */}
      <section className="section tight" aria-labelledby="guides-title">
        <div className="wrap">
          <SectionHeader id="guides-title" label={`${stats.guides} published`} title="Buying guides" action={guides.length ? <Link className="arrow-link" href="/guides">All guides</Link> : undefined}>
            Buying guides from named publishers, and AI-assisted guides that passed our quality checks. Each is labelled; none carries a rating.
          </SectionHeader>
          {guides.length ? (
            <ReviewGrid reviews={guides} layout="ruled" />
          ) : (
            <EmptyState title="New buying guides are coming." label="Guides" compact>
              Each guide is drafted with an AI writing tool and published only after it passes our quality checks.
            </EmptyState>
          )}
        </div>
      </section>

      {/* ── Method ── */}
      <section className="section ink-section on-dark" aria-labelledby="how-title">
        <div className="wrap method">
          <div className="method-sticky">
            <span className="label muted">5 steps</span>
            <h2 id="how-title" style={{ color: "#fff", fontSize: "var(--s-1)", textTransform: "uppercase", margin: "10px 0 18px" }}>
              How a product gets here
            </h2>
            <p className="muted" style={{ fontFamily: "var(--f-read)", fontSize: 19 }}>
              Every step is automated, logged and checked. When a step can’t be completed, the page shows what’s missing instead of guessing.
            </p>
            <div className="btnrow">
              <Link className="btn" href="/about">
                Read our method
              </Link>
              <Link className="btn primary" href="/match" data-cursor="Start">
                Find my match
              </Link>
            </div>
          </div>
          <ol className="steps">
            <li>
              <div>
                <h3>A review arrives</h3>
                <p>From our content feed, with its publisher and date. Duplicates and incomplete items are set aside.</p>
              </div>
            </li>
            <li>
              <div>
                <h3>We identify the product</h3>
                <p>Brand, model, platform and use case are extracted. Anything uncertain goes to an editor.</p>
              </div>
            </li>
            <li>
              <div>
                <h3>We file it for buyers</h3>
                <p>A category, type and price tier, so you can filter by what matters to you.</p>
              </div>
            </li>
            <li>
              <div>
                <h3>We check the offer</h3>
                <p>Offer links are followed to the retailer before they’re shown, then re-checked on a schedule.</p>
              </div>
            </li>
            <li>
              <div>
                <h3>Quality checks publish</h3>
                <p>Only reviews that pass quality checks go live. AI-assisted guides must also pass duplicate, claim, image and SEO checks.</p>
              </div>
            </li>
          </ol>
        </div>
      </section>

      {/* ── What you can rely on ── */}
      <section className="section" aria-labelledby="trust-title">
        <div className="wrap">
          <SectionHeader id="trust-title" label={dateline(new Date()) ?? ""} title="What you can rely on">
            Counted from our database at {dateline(new Date())}.
          </SectionHeader>
          <ul className="ledger-stats">
            <li>
              <span className="n">{stats.published}</span>
              <span className="l">Published {stats.published === 1 ? "review" : "reviews"}</span>
            </li>
            <li>
              <span className="n">{stats.guides}</span>
              <span className="l">Published {stats.guides === 1 ? "guide" : "guides"}</span>
            </li>
            <li>
              <span className="n">{stats.verifiedOffers}</span>
              <span className="l">Verified {stats.verifiedOffers === 1 ? "offer" : "offers"} live</span>
            </li>
            <li>
              <span className="n">{stats.categoriesCovered}</span>
              <span className="l">Categories with reviews</span>
            </li>
          </ul>
          <ul className="principles">
            <li>
              <h3>Nothing invented</h3>
              <p>Prices, merchants and availability come from the offer provider. Missing information is shown as missing.</p>
            </li>
            <li>
              <h3>Ratings only when they exist</h3>
              <p>We show a rating only when the original reviewer gave one. AI guides never carry a rating.</p>
            </li>
            <li>
              <h3>Commission never picks the offer</h3>
              <p>
                Offers are chosen by how well they match the product, not by payout. <Link href="/disclosure">How we make money</Link>
              </p>
            </li>
          </ul>
        </div>
      </section>
    </main>
  );
}
