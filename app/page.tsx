import Link from "next/link";
import ReviewCard from "@/components/review-card";
import SponsoredSlot from "@/components/sponsored-slot";
import JsonLd from "@/components/json-ld";
import { config } from "@/lib/config";
import { categoryCounts, latestReviews } from "@/lib/public/queries";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [reviews, categories] = await Promise.all([latestReviews(9), categoryCounts()]);
  const site = config.siteUrl();
  return (
    <main>
      <JsonLd data={{ "@context": "https://schema.org", "@type": "WebSite", name: "Made4Buyers", url: site, potentialAction: { "@type": "SearchAction", target: `${site}/search?q={search_term_string}`, "query-input": "required name=search_term_string" } }} />
      <section className="hero">
        <div className="container">
          <div className="eyebrow">Independent technology research</div>
          <h1>Find the right tech without the guesswork.</h1>
          <p>Reviews organised by what you actually need, with offers that are checked before we show them — and an honest “no verified deal” when there isn’t one.</p>
          <form className="hero-search" action="/search" role="search">
            <label htmlFor="hero-q" className="visually-hidden">
              Search laptops, phones, AI tools and more
            </label>
            <input id="hero-q" name="q" type="search" placeholder="Search laptops, phones, AI tools…" maxLength={100} />
            <button className="btn primary" type="submit">
              Search
            </button>
          </form>
          <SponsoredSlot position="HOME_HERO" />
          <nav aria-label="Browse categories">
            <ul className="category-tiles" style={{ listStyle: "none", padding: 0 }}>
              {categories.map((c) => (
                <li key={c.slug}>
                  <Link className="category-tile" href={`/category/${c.slug}`}>
                    <strong>{c.name}</strong>
                    <span className="small muted">{c.count === 1 ? "1 review" : `${c.count} reviews`}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </section>
      <section className="section">
        <div className="container">
          <h2>Latest reviews</h2>
          {reviews.length ? (
            <div className="grid">
              {reviews.map((r, i) => (
                <ReviewCard key={r.id} review={r} eager={i < 3} />
              ))}
            </div>
          ) : (
            <p className="notice">No reviews have been published yet. Reviews appear here once they pass editorial QA.</p>
          )}
          <h2>How we work</h2>
          <div className="grid">
            <div className="card card-body">
              <h3>Categorised for buyers</h3>
              <p className="muted small">Every review is classified by category, use case, platform and price tier, and uncertain classifications are checked by an editor.</p>
            </div>
            <div className="card card-body">
              <h3>Offers are verified</h3>
              <p className="muted small">We only show an offer after its link has been followed and confirmed to reach the merchant. Links are re-checked on a schedule.</p>
            </div>
            <div className="card card-body">
              <h3>Nothing invented</h3>
              <p className="muted small">Prices, merchants and availability come from the offer provider. If we don’t have a verified offer, we say so.</p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
