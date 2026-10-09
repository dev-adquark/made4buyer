import { Fragment } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import Collage from "@/components/collage";
import EmptyState from "@/components/empty-state";
import HomeCouponCard from "@/components/home-coupon-card";
import HomeDealCard from "@/components/home-deal-card";
import HomeRail from "@/components/home-rail";
import ReviewCard, { FeatureStory } from "@/components/review-card";
import SafeImg from "@/components/safe-img";
import SearchCombobox from "@/components/search-combobox";
import SectionHeader from "@/components/section-header";
import SponsoredSlot from "@/components/sponsored-slot";
import Ticker, { type TickerItem } from "@/components/ticker";
import TrustLabel from "@/components/trust-label";
import { db } from "@/lib/db";
import { dealImage, type DealImage } from "@/lib/images/deal-image";
import { placeholderPath } from "@/lib/pipeline/images";
import { allCategoryPhotos } from "@/lib/public/category-images";
import { officialDeals } from "@/lib/public/deals";
import { prerenderNeedsDatabase } from "@/lib/public/isr";
import { resolveCardImage, categoryLedger, comparePair, latestByKind, trendingReviews, trustStats, freshDealRows } from "@/lib/public/queries";
import { categoryName, subcategoryName } from "@/lib/taxonomy/definitions";
import { themeStyle } from "@/lib/taxonomy/themes";
import { dateline, money } from "@/lib/util/format";
import "./home.css";

/** Cached home page: regenerated at most every 5 minutes and purged whenever content is published or changes. */
export const revalidate = 300;
export const metadata: Metadata = { alternates: { canonical: "/" } };

const style = (slug: string | null | undefined) => themeStyle(slug) as React.CSSProperties;
/** Spec rows a source stated; a row with nothing to say is left out rather than shown as "Not available". */
function SpecRows({ rows }: { rows: Array<[string, string | null | undefined]> }) {
  const known = rows.filter(([, v]) => v);
  return known.length ? (
    <>
      {known.map(([label, value]) => (
        <Fragment key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </Fragment>
      ))}
    </>
  ) : (
    <>
      <dt>Details</dt>
      <dd className="na">See the review</dd>
    </>
  );
}

/** How many cards each homepage rail holds (the rest are one click away on /deals). */
/** Cards per homepage rail (every item is on /deals and /coupons): a lighter homepage, faster first paint. */
const RAIL_SIZE = 8;

/**
 * Each offer's product photo from the brand's own product page (lib/images/deal-image.ts decides what
 * qualifies). None: the card shows a neutral brand monogram, never another product's photo.
 */
async function dealImagesFor(offerIds: string[]): Promise<Map<string, DealImage>> {
  const out = new Map<string, DealImage>();
  if (!offerIds.length) return out;
  const rows = await db.commerceOffer.findMany({ where: { id: { in: offerIds } }, select: { id: true, product: { select: { canonicalUrl: true, data: true, brand: { select: { officialDomain: true } } } } } });
  for (const r of rows) {
    const img = dealImage(r.product);
    if (img) out.set(r.id, img);
  }
  return out;
}

export default async function Home() {
  await prerenderNeedsDatabase();
  // Photos depend only on the static taxonomy, so they load alongside the database queries.
  const [reviews, guides, comparisons, ledger, deals, trending, pair, stats, photos, verified] = await Promise.all([
    latestByKind("REVIEW", 6),
    latestByKind(["AI_GUIDE", "BUYING_GUIDE"], 3),
    latestByKind("COMPARISON", 3),
    categoryLedger(),
    freshDealRows({ take: 6 }),
    trendingReviews(7, 6),
    comparePair(),
    trustStats(),
    allCategoryPhotos(),
    officialDeals().catch(() => ({ drops: [], codes: [], checkedAt: null })),
  ]);
  // Deals and coupons: ACTIVE drops and public codes (official, or the Feedico feed) from officialDeals(), the same list /deals shows; nothing when none.
  const railDrops = verified.drops.slice(0, RAIL_SIZE);
  const railCodes = verified.codes.slice(0, RAIL_SIZE);
  const dealImages = await dealImagesFor(railDrops.map((d) => d.id)).catch(() => new Map<string, DealImage>());
  const lead = reviews[0];
  const leadImage = lead ? await resolveCardImage(lead) : null;
  const heroDeal = deals[0];
  const specSource = pair?.[0];
  const activeCats = ledger.filter((c) => c.reviews + c.comparisons + c.guides > 0);
  // Editorial lists; a review already shown in "Worth buying now" is not repeated under "Most read".
  const shownIds = new Set(reviews.slice(0, 5).map((r) => r.id));
  const mostRead = trending.map((t) => t.review).filter((r) => !shownIds.has(r.id)).slice(0, 3);
  const readCols = [
    { key: "read", title: "Most read this week", items: mostRead, href: null, more: "" },
    { key: "guides", title: "Buying guides", items: guides, href: "/guides", more: "All guides" },
    { key: "cmp", title: "Comparisons", items: comparisons, href: "/reviews?type=comparison", more: "All comparisons" },
  ].filter((c) => c.items.length > 0);
  const tickerItems: TickerItem[] = [
    // At most 16 items (6 reviews, 4 prices, 2 guides, 4 categories): the ticker is a teaser, not an index.
    ...reviews.slice(0, 6).map((r) => ({ key: `r-${r.id}`, href: `/review/${r.slug}`, label: "Latest review", text: r.productName, slug: r.categorySlug })),
    ...deals.slice(0, 4).map((d) => ({ key: `d-${d.offerId}`, href: `/review/${d.review.slug}#deal`, label: "Current price", text: `${d.review.productName}${money(d.price, d.currency) ? ` ${money(d.price, d.currency)}` : ""}`, slug: d.review.categorySlug })),
    ...guides.slice(0, 2).map((g) => ({ key: `g-${g.id}`, href: `/review/${g.slug}`, label: g.kind === "AI_GUIDE" ? "Guide" : "Buying guide", text: g.productName, slug: g.categorySlug })),
    ...activeCats.slice(0, 4).map((c) => ({ key: `c-${c.slug}`, href: `/category/${c.slug}`, label: c.reviews ? `${c.reviews} ${c.reviews === 1 ? "review" : "reviews"}` : "Category", text: c.name, slug: c.slug })),
  ];

  return (
    <main className="home">

      {/* ── The statement ── */}
      <section className="tear-hero" aria-labelledby="hero-title">
        <div className="wrap">
          <div className="hero-dateline">
            <span className="label">Edition of {dateline(new Date())}</span>
            <span className="label muted">
              {stats.published} {stats.published === 1 ? "review" : "reviews"}
              {stats.comparisons ? `, ${stats.comparisons} ${stats.comparisons === 1 ? "comparison" : "comparisons"}` : ""} published, {stats.pricedProducts} with a current price
            </span>
          </div>
          <h1 id="hero-title" className="statement">
            <span className="line">Buy less.</span>{" "}
            <span className="line indent">Buy right.</span>
          </h1>
          <div className="hero-body">
            <div className="hero-copy">
              <p className="lede">A buying guide for everything you buy: reviews filed by what you need, comparisons built only from facts we hold, and prices shown only while recently checked.</p>
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
                  <span className="n">{stats.pricedProducts}</span>
                  <span className="label muted">Products with a current price</span>
                </li>
                <li>
                  <span className="n">{stats.pricesCheckedThisWeek}</span>
                  <span className="label muted">Prices checked this week</span>
                </li>
              </ul>
              <SponsoredSlot position="HOME_HERO" />
            </div>

            <Collage label="On the cutting table">
              {lead ? (
                <Link className="clip photo crop" href={`/review/${lead.slug}`} data-depth="1.2" data-cursor="Read" style={style(lead.categorySlug)}>
                  <span className="tape" aria-hidden="true" />
                  <SafeImg src={leadImage!.url} alternates={leadImage!.alternates} fallback={placeholderPath(lead.categorySlug)} alt="" width={380} height={285} />
                  <span className="clip-body">
                    {categoryName(lead.categorySlug) && <span className="cat-tag">{categoryName(lead.categorySlug)}</span>}
                    <span className="clip-title">{lead.productName}</span>
                    <span className="label muted">{dateline(lead.sourcePublishedAt ?? lead.publishedAt) ? `Latest review, ${dateline(lead.sourcePublishedAt ?? lead.publishedAt)}` : "Latest review"}</span>
                  </span>
                </Link>
              ) : (
                <div className="clip note" data-depth="1">
                  <span className="label muted">Status</span>
                  The first reviews are on their way. They appear here once they pass our editorial checks.
                </div>
              )}
              {heroDeal ? (
                <Link className="clip deal" href={`/review/${heroDeal.review.slug}#deal`} data-depth="0.7" data-cursor="Prices" style={style(heroDeal.review.categorySlug)}>
                  <span className="clip-body">
                    <TrustLabel kind="checked">Price checked</TrustLabel>
                    <span className="price">{money(heroDeal.price, heroDeal.currency)}</span>
                    <span className="clip-title" style={{ fontSize: 15 }}>
                      {heroDeal.review.productName}
                    </span>
                    <span className="label muted">
                      {heroDeal.seller}, checked {dateline(heroDeal.observedAt)}
                    </span>
                  </span>
                </Link>
              ) : (
                <div className="clip deal" data-depth="0.7" style={{ borderTopColor: "var(--rule-strong)" }}>
                  <span className="clip-body">
                    <TrustLabel kind="none">No current prices yet</TrustLabel>
                    <span className="clip-title" style={{ fontSize: 15 }}>
                      We show a price only while we have checked it recently.
                    </span>
                  </span>
                </div>
              )}
              {specSource ? (
                <Link className="clip spec" href={`/review/${specSource.slug}`} data-depth="1.6" data-cursor="Read" style={style(specSource.categorySlug)}>
                  <span className="clip-body">
                    <span className="label">Spec sheet: {specSource.productName}</span>
                    <dl>
                      <SpecRows rows={[["Brand", specSource.brand], ["Type", subcategoryName(specSource.categorySlug, specSource.subcategorySlug) ?? specSource.entities?.deviceType], ["Platform", specSource.entities?.platform]]} />
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

      {/* ── Worth buying now: the newest reviews ── */}
      <section className="section" aria-labelledby="now-title">
        <div className="wrap">
          <SectionHeader id="now-title" label={`${stats.published} published`} title="Worth buying now" action={reviews.length ? <Link className="arrow-link" href="/reviews">All reviews</Link> : undefined}>
            The newest reviews from named publishers, by the source’s own date.
          </SectionHeader>
          {lead ? (
            <div className="lead-grid">
              <FeatureStory review={lead} image={leadImage ?? undefined} />
              <ul className="story-list" aria-label="More reviews">
                {reviews.slice(1, 5).map((r) => (
                  <li key={r.id}>
                    <ReviewCard review={r} variant="row" />
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <EmptyState title="The first reviews are on their way." label="Reviews" compact action={<Link className="btn" href="/about">How reviews get here</Link>}>
              Every review comes from a named publisher and passes our checks before it’s published. Nothing here is a placeholder.
            </EmptyState>
          )}
        </div>
      </section>

      {/* ── Verified deals + latest coupons: the same data and rules as /deals; absent without any ── */}
      {railDrops.length + railCodes.length > 0 && (
        <section className="section home-deals" aria-labelledby="verified-deals-title">
          <div className="wrap">
            <SectionHeader id="verified-deals-title" label={`${verified.drops.length + verified.codes.length} current`} title="Deals and coupons" action={<Link className="arrow-link" href="/deals">All deals</Link>}>
              Price drops checked on the brand’s official site within the last 48 hours: in stock, unexpired, with the saving worked out from the page’s own prices. Coupons from brands’ own sites, or listed by the Feedico affiliate feed (marked “Via Feedico”).
            </SectionHeader>
            {railDrops.length > 0 && (
              <HomeRail id="home-price-drops" label="Price drops" title={`Price drops (${verified.drops.length})`}>
                {railDrops.map((d) => (
                  <li key={d.id}>
                    <HomeDealCard d={d} image={dealImages.get(d.id)} />
                  </li>
                ))}
              </HomeRail>
            )}
            {railCodes.length > 0 && (
              <HomeRail
                id="home-coupons"
                label="Latest coupons"
                title="Latest coupons"
                action={
                  <Link className="arrow-link" href="/coupons">
                    All {verified.codes.length} coupons
                  </Link>
                }
              >
                {railCodes.map((c) => (
                  <li key={c.id}>
                    <HomeCouponCard c={c} />
                  </li>
                ))}
              </HomeRail>
            )}
          </div>
        </section>
      )}

      {/* ── Category issues ── */}
      <section className="section tight home-issues" aria-labelledby="cats-title">
        <div className="wrap">
          <SectionHeader id="cats-title" label={`${ledger.filter((c) => c.reviews + c.comparisons + c.guides > 0).length} categories`} title="Browse by category">
            Swipe or scroll sideways. Each category is an issue with its own colour.
          </SectionHeader>
        </div>
        <ul className="issue-rail" aria-label="Categories">
          {/* Only categories with published content (same rule as the global nav); issue numbers run in order. */}
          {ledger
            .filter((c) => c.reviews + c.comparisons + c.guides > 0)
            .map((c, i) => ({ ...c, issue: i + 1 }))
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
                        <dt>Prices</dt>
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

      {/* ── Editorial: most read, buying guides and comparisons as compact lists ── */}
      {readCols.length > 0 && (
        <section className="section" aria-labelledby="read-title">
          <div className="wrap">
            <SectionHeader id="read-title" label="Guides and comparisons" title="Before you buy" />
            <div className="home-cols">
              {readCols.map((col) => (
                <div key={col.key} className="home-col">
                  <div className="home-col-head">
                    <h3>{col.title}</h3>
                    {col.href && (
                      <Link className="arrow-link" href={col.href}>
                        {col.more}
                      </Link>
                    )}
                  </div>
                  <ul className="story-list" aria-label={col.title}>
                    {col.items.map((r) => (
                      <li key={r.id}>
                        <ReviewCard review={r} variant="row" />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── How we work: the three rules, in one band (the full method is on /about) ── */}
      <section className="section home-rules" aria-labelledby="trust-title">
        <div className="wrap">
          <div className="home-rules-head">
            <h2 id="trust-title">What you can rely on</h2>
            <div className="btnrow">
              <Link className="btn small" href="/about">
                Read our method
              </Link>
              <Link className="btn small primary" href="/match" data-cursor="Start">
                Find my match
              </Link>
            </div>
          </div>
          <ul className="principles">
            <li>
              <h3>Nothing invented</h3>
              <p>Prices, sellers and availability are what the seller’s own page stated when we checked. Missing information is shown as missing.</p>
            </li>
            <li>
              <h3>Ratings only when they exist</h3>
              <p>We show a rating only when the original reviewer gave one. Our own guides never carry a rating.</p>
            </li>
            <li>
              <h3>Commission never picks the seller</h3>
              <p>
                Sellers are listed only for the exact product, ordered by price, never by payout. <Link href="/disclosure">How we make money</Link>
              </p>
            </li>
          </ul>
        </div>
      </section>
    </main>
  );
}
