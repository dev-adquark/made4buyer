import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache, Fragment } from "react";
import Breadcrumbs, { breadcrumbJsonLd, type Crumb } from "@/components/breadcrumbs";
import DealImpression from "@/components/deal-impression";
import JsonLd from "@/components/json-ld";
import { KindPill, kindNoun, ReviewGrid } from "@/components/review-card";
import TrustLabel from "@/components/trust-label";
import { ParallaxFigure, SectionNav } from "@/components/review-chrome";
import { themeStyle } from "@/lib/taxonomy/themes";
import { placeholderPath } from "@/lib/pipeline/images";
import SponsoredSlot from "@/components/sponsored-slot";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { buildPageRenderModel, RENDER_MODEL_VERSION, verifiedDeals, type PageRenderModel, type PublicDeal } from "@/lib/pipeline/render-model";
import { brandPageEligible, latestByKind, relatedReviews } from "@/lib/public/queries";
import { availabilityLabel, dateline, money, shortDate } from "@/lib/util/format";

export const revalidate = 300;

export async function generateStaticParams() {
  return [];
}

const loadPage = cache(async (slug: string) => {
  const review = await db.normalizedReview.findUnique({
    where: { slug },
    select: { id: true, status: true, slug: true, categorySlug: true, subcategorySlug: true, brandSlug: true, renderModel: { select: { model: true, version: true } } },
  });
  if (!review || review.status !== "PUBLISHED") return null;
  // A model stored before the current version (e.g. without text rights) is rebuilt, never trusted.
  const stored = review.renderModel?.version === RENDER_MODEL_VERSION ? (review.renderModel.model as PageRenderModel) : undefined;
  const model = stored ?? (await buildPageRenderModel(review.id));
  return { review, model };
});

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = await loadPage(slug);
  if (!page) return { title: "Review not found", robots: { index: false } };
  const m = page.model;
  const images = m.image.isFallback ? [] : [{ url: m.image.url, width: m.image.width, height: m.image.height, alt: m.image.alt }];
  return {
    title: m.title,
    description: m.metaDescription,
    alternates: { canonical: m.canonicalPath },
    openGraph: { siteName: "Made4Buyers", type: "article", title: m.title, description: m.metaDescription, url: m.canonicalPath, images, publishedTime: (m.kind === "AI_GUIDE" ? m.publishedAt : m.source.publishedAt ?? m.publishedAt) ?? undefined, modifiedTime: m.updatedAt },
    twitter: { card: images.length ? "summary_large_image" : "summary", title: m.title, description: m.metaDescription, images: images.map((i) => i.url) },
  };
}

function structuredData(m: PageRenderModel, deals: PublicDeal[], crumbs: Crumb[]) {
  const site = config.siteUrl();
  const url = new URL(m.canonicalPath, site).toString();
  const publisher = { "@type": "Organization", name: "Made4Buyers", url: site };
  const out: unknown[] = [breadcrumbJsonLd(crumbs, site)];
  const product = { "@type": "Product", name: m.productName, ...(m.brand ? { brand: { "@type": "Brand", name: m.brand } } : {}) };
  // Review markup only for text we publish in full; an excerpt page is an article about the
  // product that cites the original review, never a review of our own.
  const excerpt = m.textRights === "EXCERPT";
  // Review markup only for a single-product review whose full text we publish.
  if (m.rating && !excerpt && m.kind === "REVIEW") {
    out.push({
      "@context": "https://schema.org",
      "@type": "Review",
      name: m.title,
      url,
      itemReviewed: product,
      reviewRating: { "@type": "Rating", ratingValue: m.rating.value, bestRating: m.rating.scale, worstRating: 0 },
      author: m.source.author ? { "@type": "Person", name: m.source.author } : { "@type": "Organization", name: m.source.name },
      publisher,
      datePublished: m.source.publishedAt ?? m.publishedAt ?? undefined,
    });
  } else {
    out.push({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: m.title,
      description: m.metaDescription,
      url,
      mainEntityOfPage: url,
      ...(m.image.isFallback ? {} : { image: [m.image.url] }),
      datePublished: (m.kind === "AI_GUIDE" ? m.publishedAt : m.source.publishedAt ?? m.publishedAt) ?? undefined,
      dateModified: m.updatedAt,
      ...(m.kind === "AI_GUIDE" || excerpt ? { author: publisher } : m.source.author ? { author: { "@type": "Person", name: m.source.author } } : {}),
      publisher,
      about: (m.products ?? []).length > 1 ? m.products.map((p) => ({ "@type": "Thing", name: p.name })) : { "@type": "Thing", name: m.products?.[0]?.name ?? m.productName },
      ...(excerpt && m.source.url ? { isBasedOn: m.source.url, citation: { "@type": "CreativeWork", url: m.source.url, ...(m.source.author ? { author: { "@type": "Person", name: m.source.author } } : {}), publisher: { "@type": "Organization", name: m.source.name } } } : {}),
    });
  }
  // Product + Offer only when a verified offer with a real price exists.
  const priced = m.kind === "REVIEW" ? deals.find((d) => d.isBest && d.price !== null && d.currency) : undefined;
  if (priced) {
    out.push({
      "@context": "https://schema.org",
      ...product,
      offers: {
        "@type": "Offer",
        price: priced.price,
        priceCurrency: priced.currency,
        url,
        ...(priced.availability === "in_stock" ? { availability: "https://schema.org/InStock" } : priced.availability === "out_of_stock" ? { availability: "https://schema.org/OutOfStock" } : {}),
        ...(priced.merchant ? { seller: { "@type": "Organization", name: priced.merchant } } : {}),
      },
    });
  }
  return out;
}

/** A verbatim sentence from the text, shown as a pull quote (never written by us). */
function pullQuote(paragraphs: string[]): { text: string; after: number } | null {
  if (paragraphs.length < 3) return null;
  for (let i = 1; i < paragraphs.length - 1; i++) {
    const sentence = paragraphs[i].match(/[^.!?]+[.!?]/g)?.map((x) => x.trim()).find((x) => x.length >= 60 && x.length <= 180 && !x.startsWith("## "));
    if (sentence) return { text: sentence, after: Math.min(1, paragraphs.length - 2) };
  }
  return null;
}

export default async function ReviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await loadPage(slug);
  if (!page) notFound();
  const { review, model: m } = page;
  const isGuide = m.kind === "AI_GUIDE";
  const [deals, related, brand, guidesRaw] = await Promise.all([verifiedDeals(review.id), relatedReviews(review, 3), brandPageEligible(review.brandSlug), m.category ? latestByKind("AI_GUIDE", 4, m.category.slug) : Promise.resolve([])]);
  const guides = guidesRaw.filter((g) => g.id !== review.id).slice(0, 3);
  const crumbs: Crumb[] = [{ name: "Home", href: "/" }];
  if (m.category) crumbs.push({ name: m.category.name, href: `/category/${m.category.slug}` });
  if (m.category && m.subcategory) crumbs.push({ name: m.subcategory.name, href: `/category/${m.category.slug}?sub=${m.subcategory.slug}` });
  crumbs.push({ name: m.productName, href: m.canonicalPath });
  const best = deals.find((d) => d.isBest) ?? deals[0];
  const alternates = deals.filter((d) => d !== best);
  const published = m.publishedAt ? new Date(m.publishedAt) : null;
  const sourceDate = m.source.publishedAt ? new Date(m.source.publishedAt) : null;
  const fact = (label: string) => m.keyEntities.find((e) => e.label === label)?.value ?? null;
  const specs: Array<[string, string | null]> = [
    ["Brand", m.brand ?? fact("Brand")],
    ["Product", fact("Product") ?? m.productName],
    ["Model", fact("Model")],
    ["Type", m.subcategory?.name ?? fact("Type")],
    ["Platform", m.platforms.map((p) => p.name).join(", ") || fact("Platform")],
    ["Best for", m.intents.map((i) => i.name).join(", ") || fact("Best for")],
    ["Price tier", m.priceTier?.name ?? null],
  ];
  // Device spec rows we don't extract yet are listed honestly as not available, never guessed.
  if (m.category && ["laptops", "phones", "tablets"].includes(m.category.slug)) for (const label of ["Processor", "Memory", "Display", "Battery"]) specs.push([label, fact(label)]);
  const quote = pullQuote(m.bodyParagraphs);
  const considerations = m.category && (m.intents.length > 0 || m.platforms.length > 0 || m.priceTier);
  const sections = [
    { id: "review", label: isGuide || m.kind === "BUYING_GUIDE" ? "Guide" : m.kind === "COMPARISON" ? "Comparison" : "Review" },
    ...(m.products?.length ? [{ id: "products", label: m.kind === "COMPARISON" ? "Products compared" : "Product" }] : []),
    { id: "facts", label: "Key facts" },
    ...(considerations ? [{ id: "considerations", label: "Buying considerations" }] : []),
    { id: "deal", label: best ? "Verified offer" : "Offer" },
    ...(related.length ? [{ id: "alternatives", label: "Alternatives" }] : []),
    ...(guides.length ? [{ id: "guides", label: "Guides" }] : []),
  ];

  return (
    <main style={themeStyle(m.category?.slug) as React.CSSProperties}>
      {structuredData(m, deals, crumbs).map((d, i) => (
        <JsonLd key={i} data={d} />
      ))}
      <div className="progress-bar" aria-hidden="true" />
      <header className="article-hero">
        <div className="wrap">
          <Breadcrumbs items={crumbs} />
          <div className="ah-grid">
            <div>
              <div className="meta-row">
                {m.category && <span className="cat-tag">{m.category.name}</span>}
                <KindPill kind={m.kind} />
                {best && <TrustLabel kind="verified" />}
              </div>
              <h1>{m.title}</h1>
              <p className="lede">{m.summary}</p>
              <div className="btnrow">
                {best ? (
                  <a className="btn primary" href="#deal" data-cursor="View deal">
                    {money(best.price, best.currency) ? `See the verified offer, ${money(best.price, best.currency)}` : "See the verified offer"}
                  </a>
                ) : null}
                <Link className="btn" href={`/compare?ids=${review.id}`} data-cursor="Compare">
                  Compare with others
                </Link>
              </div>
            </div>
            <ParallaxFigure src={m.image.url} fallback={placeholderPath(m.category?.slug)} alt={m.image.alt} width={m.image.width} height={m.image.height} caption={m.image.attribution} captionUrl={m.image.attributionUrl} illustrative={m.image.subject === "ILLUSTRATIVE"} />
          </div>
          <dl className="article-meta">
            <div>
              <dt>Product</dt>
              <dd>
                {m.brand && !m.productName.startsWith(m.brand) ? `${m.brand} ` : ""}
                {m.productName}
              </dd>
            </div>
            <div>
              <dt>{isGuide ? "Written by" : "Source"}</dt>
              <dd>{isGuide ? "Made4Buyers, AI-assisted" : m.source.author ? `${m.source.name}, ${m.source.author}` : m.source.name}</dd>
            </div>
            <div>
              <dt>{isGuide ? "Published" : "Reviewed"}</dt>
              <dd>
                {isGuide ? (
                  published ? <time dateTime={published.toISOString()}>{dateline(published)}</time> : <span className="na">Not available</span>
                ) : sourceDate ? (
                  <time dateTime={sourceDate.toISOString()}>{dateline(sourceDate)}</time>
                ) : (
                  <span className="na">Not available</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Rating</dt>
              <dd>{m.rating ? `${m.rating.value} / ${m.rating.scale}, by ${m.source.name}` : <span className="na">{isGuide ? "Guides are never rated" : "Not given by the source"}</span>}</dd>
            </div>
            <div>
              <dt>Offer</dt>
              <dd>{best ? `Verified ${dateline(best.verifiedAt)}` : <span className="na">No verified offer</span>}</dd>
            </div>
          </dl>
        </div>
      </header>
      <SectionNav items={sections} />
      <div className="wrap doc-layout">
        <article className="doc-main">
          <section id="review" aria-labelledby="review-heading">
            <h2 id="review-heading" className="visually-hidden">
              {isGuide ? "Guide" : "Review"}
            </h2>
            {isGuide ? (
              <aside className="kind-banner ai" aria-label="How this guide was written">
                <div>
                  <strong>AI-assisted buying guide.</strong>
                  This guide was drafted with an AI writing tool and read and approved by a Made4Buyers editor before publishing. It is not a hands-on review: we haven’t tested this product. Offers, when shown, come only from links we’ve verified.
                </div>
              </aside>
            ) : (
              <aside className="kind-banner review" aria-label="About this review">
                <div>
                  <strong>
                    {m.kind === "COMPARISON" ? "Comparison" : m.kind === "BUYING_GUIDE" ? "Buying guide" : "Review"} from {m.source.name}.
                  </strong>
                  {m.source.author ? `Written by ${m.source.author}. ` : ""}We summarise and file it for buyers, and add offers only after checking their links.
                </div>
              </aside>
            )}
            {m.textRights === "EXCERPT" && (
              <div className="callout" style={{ marginBottom: 26 }}>
                <span className="label muted">Excerpt</span>
                <p className="prose" style={{ fontFamily: "var(--f-read)", fontSize: 19, margin: "0 0 10px" }}>
                  {m.summary}
                </p>
                <p style={{ margin: 0 }}>
                  This is a short excerpt. The full {kindNoun(m.kind)} belongs to {m.source.name}
                  {m.source.url ? (
                    <>
                      :{" "}
                      <a href={m.source.url} rel="noopener" target="_blank" data-cursor="Read" data-track="outbound" data-review-id={m.reviewId} data-kind="source">
                        read it on {m.source.name}
                        <span className="visually-hidden"> (opens in a new tab)</span>
                      </a>
                      .
                    </>
                  ) : (
                    "."
                  )}
                </p>
              </div>
            )}
            <div className="prose">
              {m.bodyParagraphs.map((p, i) => (
                <Fragment key={i}>
                  {p.startsWith("## ") ? <h2>{p.slice(3)}</h2> : <p>{p}</p>}
                  {quote && i === quote.after && (
                    <blockquote className="pullquote" aria-hidden="true">
                      <p style={{ margin: 0, fontSize: "inherit", lineHeight: "inherit" }}>{quote.text}</p>
                      <footer>{isGuide ? "From this guide" : `From the review, ${m.source.name}`}</footer>
                    </blockquote>
                  )}
                </Fragment>
              ))}
            </div>
            {isGuide ? (
              <p className="small muted">Drafted with an AI writing tool and edited by Made4Buyers.</p>
            ) : (
              <p className="small muted">
                Source:{" "}
                {m.source.url ? (
                  <a href={m.source.url} rel="nofollow noopener" target="_blank">
                    {m.source.name}
                  </a>
                ) : (
                  m.source.name
                )}
                {m.source.author ? `, by ${m.source.author}` : ""}
                {m.source.publishedAt ? `, originally published ${shortDate(m.source.publishedAt)}` : ""}
                {published ? `; added to Made4Buyers ${shortDate(published)}` : ""}.
              </p>
            )}
          </section>

          {m.products?.length > 0 && (
            <section id="products" aria-labelledby="products-heading">
              <h2 id="products-heading">{m.kind === "COMPARISON" ? `Products compared (${m.products.length})` : m.products.length > 1 ? "Products covered" : "Product"}</h2>
              <ul className="entity-list">
                {m.products.map((p) => (
                  <li key={p.slug}>
                    <Link href={`/product/${p.slug}`}>{p.name}</Link>
                    {p.brand && <span> · {p.brand}</span>}
                  </li>
                ))}
              </ul>
              {m.kind === "COMPARISON" && <p className="muted small">Each product links to everything we have filed about it. We don’t pick a winner the source didn’t.</p>}
            </section>
          )}

          <section id="facts" aria-labelledby="facts-heading">
            <h2 id="facts-heading">Key facts</h2>
            <table className="spec-table">
              <caption className="visually-hidden">Key facts about {m.productName}</caption>
              <tbody>
                {specs.map(([label, value]) => (
                  <tr key={label}>
                    <th scope="row">{label}</th>
                    <td>{value || <span className="na">Not available</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {considerations && m.category && (
            <section id="considerations" aria-labelledby="cons-heading">
              <h2 id="cons-heading">Buying considerations</h2>
              <p className="muted">How we filed this product. Each link shows other reviewed {m.category.name.toLowerCase()} that share it.</p>
              <dl className="facts" style={{ fontSize: 16, gap: "12px 18px" }}>
                {m.intents.length > 0 && (
                  <>
                    <dt>Good fit for</dt>
                    <dd>
                      <ul className="chips" style={{ margin: 0 }}>
                        {m.intents.map((t) => (
                          <li key={t.slug}>
                            <Link className="chip" href={`/category/${m.category!.slug}?intent=${t.slug}`}>
                              {t.name}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </>
                )}
                {m.platforms.length > 0 && (
                  <>
                    <dt>Works with</dt>
                    <dd>
                      <ul className="chips" style={{ margin: 0 }}>
                        {m.platforms.map((t) => (
                          <li key={t.slug}>
                            <Link className="chip" href={`/category/${m.category!.slug}?platform=${t.slug}`}>
                              {t.name}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </>
                )}
                {m.priceTier && (
                  <>
                    <dt>Price tier</dt>
                    <dd>
                      <Link className="chip" href={`/category/${m.category.slug}?tier=${m.priceTier.slug}`}>
                        {m.priceTier.name}
                      </Link>
                    </dd>
                  </>
                )}
              </dl>
            </section>
          )}

          {related.length > 0 && (
            <section id="alternatives" aria-labelledby="alt-heading">
              <h2 id="alt-heading">Alternatives to consider</h2>
              <ReviewGrid reviews={related} />
              <div className="btnrow">
                <Link className="btn primary" href={`/compare?ids=${[review.id, ...related.slice(0, 2).map((r) => r.id)].join(",")}`}>
                  Compare {m.productName} with these
                </Link>
              </div>
            </section>
          )}

          {guides.length > 0 && (
            <section id="guides" aria-labelledby="guides-heading">
              <h2 id="guides-heading">Related buying guides</h2>
              <ReviewGrid reviews={guides} />
            </section>
          )}

          <nav className="btnrow" aria-label="Related pages">
            {m.category && (
              <Link className="btn" href={`/category/${m.category.slug}`}>
                All {m.category.name.toLowerCase()}
              </Link>
            )}
            {brand.eligible && m.brand && m.brandSlug && (
              <Link className="btn" href={`/brand/${m.brandSlug}`}>
                More from {m.brand}
              </Link>
            )}
          </nav>
        </article>

        <aside className="doc-aside" aria-label="Offer and product details">
          <section id="deal" className={`panel${best ? " offer-panel" : ""}`} aria-labelledby="deal-heading">
            <h2 id="deal-heading" className={best ? "visually-hidden" : undefined}>
              {best ? "Verified offer" : "Offer"}
            </h2>
            {best ? (
              <>
                <DealImpression linkId={best.linkId} reviewId={review.id} categorySlug={m.category?.slug}>
                  <div className="verified-head">Verified offer</div>
                  {money(best.price, best.currency) ? <div className="price">{money(best.price, best.currency)}</div> : <div className="small" style={{ marginTop: 8 }}>Price shown at the retailer</div>}
                  <div className="merchant">{best.merchant ?? "Retailer not reported"}</div>
                  <div className="small muted">{availabilityLabel(best.availability)}</div>
                  <a className="btn primary large" href={`/go/${best.linkId}`} rel="sponsored nofollow noopener" target="_blank">
                    View deal<span className="visually-hidden"> for {m.productName} at {best.merchant ?? "the retailer"} (opens in a new tab)</span>
                  </a>
                </DealImpression>
                <p className="small muted" style={{ margin: "12px 0 0" }}>
                  Link checked <time dateTime={best.verifiedAt}>{shortDate(best.verifiedAt)}</time>. Prices and availability can change at the retailer.
                </p>
                {alternates.length > 0 && (
                  <div style={{ marginTop: 14 }}>
                    <h3 style={{ font: "700 15px var(--font-body)", margin: "0 0 4px" }}>Other verified offers</h3>
                    {alternates.map((d) => (
                      <DealImpression key={d.linkId} linkId={d.linkId} reviewId={review.id} categorySlug={m.category?.slug}>
                        <div className="offer-alt">
                          <div>
                            <div className="small" style={{ fontWeight: 700 }}>
                              {d.merchant ?? "Retailer not reported"}
                            </div>
                            <div className="small muted">{money(d.price, d.currency) ?? "Price at retailer"}</div>
                          </div>
                          <a className="btn small" href={`/go/${d.linkId}`} rel="sponsored nofollow noopener" target="_blank">
                            View<span className="visually-hidden"> offer at {d.merchant ?? "the retailer"} (opens in a new tab)</span>
                          </a>
                        </div>
                      </DealImpression>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="no-offer" role="status">
                <strong>No verified offer currently available.</strong>
                <p>We only show a deal after confirming its link reaches the retailer.</p>
              </div>
            )}
            <p className="disclosure">
              Made4Buyers may earn a commission from qualifying purchases made through offer links. <Link href="/disclosure">Affiliate disclosure</Link>
            </p>
          </section>
          <SponsoredSlot position="REVIEW_SIDEBAR" categorySlug={m.category?.slug} />
        </aside>
      </div>
      {best && (
        <aside className="sticky-offer" aria-label="Verified offer shortcut">
          <div>
            <div style={{ fontWeight: 800 }}>{money(best.price, best.currency) ?? "Verified offer"}</div>
            <div className="small">{best.merchant ?? "Retailer not reported"}</div>
          </div>
          <a className="btn light" href={`/go/${best.linkId}`} rel="sponsored nofollow noopener" target="_blank">
            View deal<span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        </aside>
      )}
    </main>
  );
}
