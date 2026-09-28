import Link from "next/link";
import CategoryIcon from "@/components/category-icon";
import DealLedger from "@/components/deal-ledger";
import EmptyState from "@/components/empty-state";
import HeroVisual from "@/components/hero3d/hero-visual";
import JsonLd from "@/components/json-ld";
import { ReviewGrid } from "@/components/review-card";
import SafeImg from "@/components/safe-img";
import SearchCombobox from "@/components/search-combobox";
import SponsoredSlot from "@/components/sponsored-slot";
import { config } from "@/lib/config";
import { placeholderPath } from "@/lib/pipeline/images";
import { cardImage, categoryCounts, comparePair, latestByKind, trendingReviews, trustStats, TRENDING_MIN_VIEWS, verifiedDealRows } from "@/lib/public/queries";
import { CATEGORY_BY_SLUG, categoryName, subcategoryName } from "@/lib/taxonomy/definitions";
import { themeStyle } from "@/lib/taxonomy/themes";
import { money } from "@/lib/util/format";

export const dynamic = "force-dynamic";

const style = (slug: string | null | undefined) => themeStyle(slug) as React.CSSProperties;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default async function Home() {
  const [reviews, guides, categories, deals, trending, pair, stats] = await Promise.all([latestByKind("REVIEW", 7), latestByKind("AI_GUIDE", 3), categoryCounts(), verifiedDealRows({ take: 5 }), trendingReviews(7, 4), comparePair(), trustStats()]);
  const site = config.siteUrl();
  const heroReview = reviews[0];
  const heroDeal = deals[0];
  const hasCards = Boolean(heroReview || heroDeal || pair);

  return (
    <main>
      <JsonLd data={{ "@context": "https://schema.org", "@type": "WebSite", name: "Made4Buyers", url: site, potentialAction: { "@type": "SearchAction", target: `${site}/search?q={search_term_string}`, "query-input": "required name=search_term_string" } }} />

      {/* 1 — Hero */}
      <section className="hero on-ink" aria-labelledby="hero-title">
        <div className="container hero-inner">
          <div className="hero-copy">
            <p className="hero-kicker">
              <b>Checked</b>
              Reviews and offers, verified before they’re shown
            </p>
            <h1 id="hero-title">
              We help you find the right{" "}
              <span className="beam">technology to buy.</span>
            </h1>
            <p className="lede">Reviews sorted by what you need, comparisons built only from facts we hold, and offers whose links we follow to the retailer first.</p>
            <SearchCombobox variant="hero" label="Search products, brands and guides" />
            <div className="btnrow">
              <Link className="btn light large" href="/match">
                Find my match
              </Link>
              <Link className="btn ghost-ink large" href="/compare">
                Compare products
              </Link>
            </div>
            <ul className="hero-proof">
              <li>No invented ratings</li>
              <li>Missing facts shown as missing</li>
              <li>AI guides always labelled</li>
            </ul>
            <SponsoredSlot position="HOME_HERO" />
          </div>
          <div className="hero-stage">
            <HeroVisual />
            {hasCards ? (
              <ul className="stage-cards" aria-label="From the site right now">
                {heroReview && (
                  <li style={style(heroReview.categorySlug)}>
                    <Link className="glass-card" href={`/review/${heroReview.slug}`}>
                      <span className="gc-label">Latest review</span>
                      <SafeImg src={cardImage(heroReview).url} fallback={placeholderPath(heroReview.categorySlug)} alt="" width={226} height={141} />
                      <span className="gc-title">{heroReview.productName}</span>
                      <span className="meta-row" style={{ marginTop: 6 }}>
                        <span className="pill">{categoryName(heroReview.categorySlug) ?? "Technology"}</span>
                      </span>
                    </Link>
                  </li>
                )}
                {heroDeal && (
                  <li style={style(heroDeal.review.categorySlug)}>
                    <Link className="glass-card" href={`/review/${heroDeal.review.slug}#deal`}>
                      <span className="gc-label">Verified offer</span>
                      <span className="gc-title">{heroDeal.review.productName}</span>
                      <span className="gc-price">{money(heroDeal.price, heroDeal.currency) ?? "Price at retailer"}</span>
                      <span className="small muted">{heroDeal.merchant ?? "Retailer not reported"}</span>
                    </Link>
                  </li>
                )}
                {pair && pair.length === 2 && (
                  <li style={style(pair[0].categorySlug)}>
                    <Link className="glass-card" href={`/compare?ids=${pair.map((p) => p.id).join(",")}`}>
                      <span className="gc-label">Compare</span>
                      <span className="gc-row">
                        <strong>{pair[0].productName}</strong>
                      </span>
                      <span className="gc-row">
                        <strong>{pair[1].productName}</strong>
                      </span>
                      <span className="small muted">Side by side in {categoryName(pair[0].categorySlug)}</span>
                    </Link>
                  </li>
                )}
              </ul>
            ) : (
              <div className="stage-empty" role="status">
                <strong>The first reviews are on their way.</strong>
                <p>Products appear here once a review passes our editorial checks.</p>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* 2 — Explore categories */}
      <section className="section" aria-labelledby="cats-title">
        <div className="container">
          <div className="section-head">
            <div>
              <h2 id="cats-title">Explore by category</h2>
              <p>{stats.categoriesCovered ? `${plural(stats.categoriesCovered, "category", "categories")} with published reviews so far.` : "Each category fills up as reviews are published."}</p>
            </div>
          </div>
          <ul className="rail-track" aria-label="Categories">
            {categories.map((c) => {
              const def = CATEGORY_BY_SLUG.get(c.slug);
              return (
                <li key={c.slug} style={style(c.slug)}>
                  <Link className="cat-panel" href={`/category/${c.slug}`}>
                    <div>
                      <span className="swatch">
                        <CategoryIcon slug={c.slug} size={22} />
                      </span>
                      <h3>{c.name}</h3>
                      <p>{c.description}</p>
                      {def && def.subcategories.length > 0 && (
                        <ul aria-label={`${c.name} types`}>
                          {def.subcategories.slice(0, 3).map((s) => (
                            <li key={s.slug}>{s.name}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <span className="count">{c.count ? plural(c.count, "review") : "No reviews yet"}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      {/* 3 — Trending */}
      <section className="section band" aria-labelledby="trending-title">
        <div className="container">
          <div className="section-head">
            <div>
              <h2 id="trending-title">Trending this week</h2>
              <p>Ranked by real page views over the last 7 days.</p>
            </div>
          </div>
          {trending.length ? (
            <ReviewGrid reviews={trending.map((t) => t.review)} />
          ) : (
            <EmptyState title="Not enough data yet." headingLevel={3}>
              A review needs at least {TRENDING_MIN_VIEWS} views this week before we call it trending.
            </EmptyState>
          )}
        </div>
      </section>

      {/* 4 — Featured guides */}
      <section className="section" aria-labelledby="guides-title">
        <div className="container">
          <div className="section-head">
            <div>
              <h2 id="guides-title">Buying guides</h2>
              <p>AI-assisted guides, read and approved by an editor. They explain what to look for; they are not hands-on reviews.</p>
            </div>
            {guides.length > 0 && (
              <Link className="btn" href="/guides">
                All buying guides
              </Link>
            )}
          </div>
          {guides.length ? (
            <ReviewGrid reviews={guides} />
          ) : (
            <EmptyState title="No buying guides are published yet." headingLevel={3}>
              Guides appear here after an editor has read and approved them.
            </EmptyState>
          )}
        </div>
      </section>

      {/* 5 — Latest reviews */}
      <section className="section band" aria-labelledby="latest-title">
        <div className="container">
          <div className="section-head">
            <h2 id="latest-title">Latest reviews</h2>
            {reviews.length > 0 && (
              <Link className="btn" href="/reviews">
                All reviews
              </Link>
            )}
          </div>
          {reviews.length ? (
            <ReviewGrid reviews={reviews.slice(0, 5)} layout="editorial" />
          ) : (
            <EmptyState title="We’re waiting for the next verified review." headingLevel={3}>
              Reviews appear here once they pass editorial QA.
            </EmptyState>
          )}
        </div>
      </section>

      {/* 6 — Compare */}
      <section className="section" aria-labelledby="compare-title">
        <div className="container">
          <div className="section-head">
            <div>
              <h2 id="compare-title">Compare side by side</h2>
              <p>Only the facts we hold. Where we don’t know something, the comparison says so.</p>
            </div>
            <Link className="btn" href="/compare">
              Build a comparison
            </Link>
          </div>
          {pair && pair.length === 2 ? (
            <div className="duel" style={style(pair[0].categorySlug)}>
              {pair.map((p, i) => (
                <div key={p.id} style={{ display: "contents" }}>
                  {i === 1 && (
                    <div className="duel-vs" aria-hidden="true">
                      <span>vs</span>
                    </div>
                  )}
                  <div className="duel-side">
                    <SafeImg src={cardImage(p).url} fallback={placeholderPath(p.categorySlug)} alt="" width={480} height={300} loading="lazy" />
                    <h3>
                      <Link href={`/review/${p.slug}`}>{p.productName}</Link>
                    </h3>
                    <dl className="facts">
                      <dt>Brand</dt>
                      <dd>{p.brand ?? <span className="na">Not available</span>}</dd>
                      <dt>Type</dt>
                      <dd>{subcategoryName(p.categorySlug, p.subcategorySlug) ?? p.entities?.deviceType ?? <span className="na">Not available</span>}</dd>
                      <dt>Platform</dt>
                      <dd>{p.entities?.platform ?? <span className="na">Not available</span>}</dd>
                      <dt>Price tier</dt>
                      <dd>{p.assignments[0]?.categoryTag.name ?? <span className="na">Not available</span>}</dd>
                    </dl>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="Comparisons need two reviewed products in the same category." headingLevel={3} action={<Link className="btn" href="/compare">Open the comparison tool</Link>}>
              As soon as two are published, a head-to-head appears here.
            </EmptyState>
          )}
          {pair && pair.length === 2 && (
            <div className="btnrow">
              <Link className="btn primary" href={`/compare?ids=${pair.map((p) => p.id).join(",")}`}>
                See the full comparison
              </Link>
            </div>
          )}
        </div>
      </section>

      {/* 7 — Live deals */}
      <section className="section band" aria-labelledby="deals-title">
        <div className="container">
          <div className="section-head">
            <div>
              <h2 id="deals-title">Verified deals</h2>
              <p>Offers whose links we followed to the retailer and confirmed. Prices are the retailer’s and can change.</p>
            </div>
            {deals.length > 0 && (
              <Link className="btn" href="/deals">
                All verified deals
              </Link>
            )}
          </div>
          {deals.length ? (
            <DealLedger rows={deals} />
          ) : (
            <EmptyState title="No verified offer currently available." headingLevel={3}>
              We list an offer only after checking its link. New offers appear here automatically.
            </EmptyState>
          )}
        </div>
      </section>

      {/* 8 — How it works */}
      <section className="section band-ink on-ink" aria-labelledby="how-title">
        <div className="container method">
          <div className="method-sticky">
            <h2 id="how-title">How a product reaches this page</h2>
            <p className="muted">Every step is automated, logged and checked. When a step can’t be completed, the page shows what’s missing instead of guessing.</p>
            <Link className="btn ghost-ink" href="/about">
              Read our methodology
            </Link>
          </div>
          <ol className="steps">
            <li>
              <h3>A review arrives</h3>
              <p>Reviews come in from our content feed. Duplicates and incomplete items are set aside.</p>
            </li>
            <li>
              <h3>We identify the product</h3>
              <p>Brand, model, platform and use case are extracted. Anything uncertain goes to an editor.</p>
            </li>
            <li>
              <h3>We file it for buyers</h3>
              <p>Each product is placed in a category, type and price tier so you can filter by what matters to you.</p>
            </li>
            <li>
              <h3>We check the offer</h3>
              <p>Offer links are followed to the retailer before they’re shown, then re-checked on a schedule.</p>
            </li>
            <li>
              <h3>An editor publishes</h3>
              <p>Only reviews that pass quality checks go live. AI-assisted guides also need an editor’s approval.</p>
            </li>
          </ol>
        </div>
      </section>

      {/* 9 — Trust & transparency */}
      <section className="section" aria-labelledby="trust-title">
        <div className="container">
          <div className="section-head">
            <div>
              <h2 id="trust-title">What you can rely on</h2>
              <p>Counted from our database right now.</p>
            </div>
          </div>
          <ul className="ledger-stats">
            <li>
              <span className="n">{stats.published}</span>
              <span className="l">published {stats.published === 1 ? "review" : "reviews"}</span>
            </li>
            <li>
              <span className="n">{stats.guides}</span>
              <span className="l">editor-approved {stats.guides === 1 ? "guide" : "guides"}</span>
            </li>
            <li>
              <span className="n">{stats.verifiedOffers}</span>
              <span className="l">verified {stats.verifiedOffers === 1 ? "offer" : "offers"} live</span>
            </li>
            <li>
              <span className="n">{stats.checkedThisWeek}</span>
              <span className="l">offer {stats.checkedThisWeek === 1 ? "link" : "links"} re-checked this week</span>
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

      {/* 10 — Final CTA */}
      <section className="section" aria-labelledby="cta-title">
        <div className="container">
          <div className="cta-final on-ink">
            <h2 id="cta-title">Not sure where to start?</h2>
            <p>Answer four quick questions about what you need, and we’ll show the reviewed products that fit.</p>
            <div className="btnrow">
              <Link className="btn light large" href="/match">
                Find my match
              </Link>
              <Link className="btn ghost-ink large" href="/reviews">
                Browse all reviews
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
