import Link from "next/link";
import CategoryIcon from "@/components/category-icon";
import EmptyState from "@/components/empty-state";
import HeroVisual from "@/components/hero3d/hero-visual";
import JsonLd from "@/components/json-ld";
import { ReviewGrid } from "@/components/review-card";
import SafeImg from "@/components/safe-img";
import SearchCombobox from "@/components/search-combobox";
import { placeholderPath } from "@/lib/pipeline/images";
import SponsoredSlot from "@/components/sponsored-slot";
import { config } from "@/lib/config";
import { cardImage, categoryCounts, hasVerifiedOffer, latestReviews, reviewsWithDeals, trendingReviews, TRENDING_MIN_VIEWS } from "@/lib/public/queries";
import { categoryName } from "@/lib/taxonomy/definitions";
import { themeStyle } from "@/lib/taxonomy/themes";

export const dynamic = "force-dynamic";

const style = (slug: string | null) => themeStyle(slug) as React.CSSProperties;

export default async function Home() {
  const [latest, categories, deals, trending] = await Promise.all([latestReviews(9), categoryCounts(), reviewsWithDeals(6), trendingReviews(7, 3)]);
  const site = config.siteUrl();
  const floating = latest.slice(0, 3);
  const withReviews = categories.filter((c) => c.count > 0).length;

  return (
    <main>
      <JsonLd data={{ "@context": "https://schema.org", "@type": "WebSite", name: "Made4Buyers", url: site, potentialAction: { "@type": "SearchAction", target: `${site}/search?q={search_term_string}`, "query-input": "required name=search_term_string" } }} />

      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-grid-bg" aria-hidden="true" />
        <div className="hero-blob a" aria-hidden="true" />
        <div className="hero-blob b" aria-hidden="true" />
        <div className="hero-blob c" aria-hidden="true" />
        <div className="hero-rays" aria-hidden="true" />
        <div className="container hero-inner">
          <div>
            <h1 id="hero-title">
              <span className="line l1">Find the right tech.</span>
              <span className="line l2">See real reviews.</span>
              <span className="line l3">Discover real deals.</span>
            </h1>
            <p className="lede">Reviews sorted by what you actually need, and offers we check before we show them. When there’s no verified offer, we say so.</p>
            <SearchCombobox variant="hero" label="Search laptops, phones, AI tools and more" />
            <div className="btnrow">
              <Link className="btn primary large" href="/reviews">
                Explore Reviews
              </Link>
              <Link className="btn glass large" href="/compare">
                Compare Products
              </Link>
            </div>
            <SponsoredSlot position="HOME_HERO" />
          </div>
          <div className="hero-stage">
            <HeroVisual />
            {floating.length ? (
              <ul className="hero-cards" aria-label="Latest reviews">
                {floating.map((r) => (
                  <li key={r.id} style={style(r.categorySlug)}>
                    <Link className="float-card" href={`/review/${r.slug}`}>
                      <SafeImg src={cardImage(r).url} fallback={placeholderPath(r.categorySlug)} alt="" width={230} height={144} />
                      <span className="fc-body">
                        <span className="fc-title">{r.productName}</span>
                        <span className="meta-row">
                          <span className="pill">{categoryName(r.categorySlug) ?? "Technology"}</span>
                          {hasVerifiedOffer(r) && <span className="pill verified">Verified offer</span>}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="hero-empty" role="status">
                <strong>We’re waiting for the next verified review.</strong>
                <p className="small">Published reviews appear here as soon as they pass editorial checks.</p>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="cats-title">
        <div className="container">
          <div className="section-head reveal">
            <div>
              <h2 id="cats-title">Browse by category</h2>
              <p className="muted">{withReviews ? `${withReviews} categories with published reviews.` : "Categories fill up as reviews are published."}</p>
            </div>
          </div>
          <ul className="cat-rail">
            {categories.map((c, i) => (
              <li key={c.slug} className="reveal" style={{ ...style(c.slug), "--delay": `${i * 40}ms` } as React.CSSProperties}>
                <Link className="cat-tile" href={`/category/${c.slug}`}>
                  <span className="mega-icon">
                    <CategoryIcon slug={c.slug} />
                  </span>
                  <div>
                    <strong>{c.name}</strong>
                    <span className="small">{c.count === 1 ? "1 review" : c.count ? `${c.count} reviews` : "No reviews yet"}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="section band" aria-labelledby="latest-title">
        <div className="container">
          <div className="section-head reveal">
            <h2 id="latest-title">Latest reviews</h2>
            {latest.length > 0 && (
              <Link className="btn" href="/reviews">
                All reviews
              </Link>
            )}
          </div>
          {latest.length ? (
            <ReviewGrid reviews={latest} eagerCount={0} />
          ) : (
            <EmptyState title="We’re waiting for the next verified review.">Reviews appear here once they pass editorial QA.</EmptyState>
          )}
        </div>
      </section>

      <section className="section" aria-labelledby="trending-title">
        <div className="container">
          <div className="section-head reveal">
            <div>
              <h2 id="trending-title">Trending this week</h2>
              <p className="muted">Ranked by real page views over the last 7 days.</p>
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

      <section className="section band" aria-labelledby="deals-title">
        <div className="container">
          <div className="section-head reveal">
            <div>
              <h2 id="deals-title">Verified deals</h2>
              <p className="muted">Offers whose links we followed to the retailer and confirmed.</p>
            </div>
            {deals.length > 0 && (
              <Link className="btn" href="/deals">
                All verified deals
              </Link>
            )}
          </div>
          {deals.length ? <ReviewGrid reviews={deals} /> : <EmptyState title="No verified offer is available right now.">We only list a deal after its link has been checked. New offers appear here automatically.</EmptyState>}
        </div>
      </section>

      <section className="section" aria-labelledby="why-title">
        <div className="container">
          <h2 id="why-title" className="reveal">
            Why Made4Buyers
          </h2>
          <ul className="why-grid">
            {[
              { slug: "laptops", title: "Sorted for buyers", text: "Every review is filed by category, use case, platform and price tier. Uncertain classifications are checked by an editor." },
              { slug: "developer-software", title: "Offers are checked", text: "We follow each offer link to the retailer before showing it, and re-check it on a schedule. Failing links disappear." },
              { slug: "ai-tools", title: "Nothing invented", text: "Prices, merchants and availability come from the offer provider. Missing information is shown as missing." },
            ].map((w, i) => (
              <li key={w.title} className="reveal" style={{ ...style(w.slug), "--delay": `${i * 80}ms` } as React.CSSProperties}>
                <div className="why-item">
                  <span className="mega-icon">
                    <CategoryIcon slug={w.slug} />
                  </span>
                  <h3>{w.title}</h3>
                  <p>{w.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="section" aria-labelledby="cta-title">
        <div className="container">
          <div className="cta-band reveal">
            <h2 id="cta-title">Choosing between two?</h2>
            <p>Put up to three reviewed products side by side, with only the facts we actually have.</p>
            <div className="btnrow">
              <Link className="btn glass large" href="/compare">
                Compare Products
              </Link>
              <Link className="btn glass large" href="/reviews">
                Explore Reviews
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
