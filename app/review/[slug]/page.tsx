import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import Breadcrumbs, { breadcrumbJsonLd, type Crumb } from "@/components/breadcrumbs";
import DealImpression from "@/components/deal-impression";
import JsonLd from "@/components/json-ld";
import { ReviewGrid } from "@/components/review-card";
import { ParallaxFigure, SectionNav } from "@/components/review-chrome";
import { themeStyle } from "@/lib/taxonomy/themes";
import { placeholderPath } from "@/lib/pipeline/images";
import SponsoredSlot from "@/components/sponsored-slot";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { buildPageRenderModel, verifiedDeals, type PageRenderModel, type PublicDeal } from "@/lib/pipeline/render-model";
import { brandPageEligible, relatedReviews } from "@/lib/public/queries";

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
  const model = (review.renderModel?.model as PageRenderModel | undefined) ?? (await buildPageRenderModel(review.id));
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
    openGraph: { type: "article", title: m.title, description: m.metaDescription, url: m.canonicalPath, images, publishedTime: m.publishedAt ?? undefined, modifiedTime: m.updatedAt },
    twitter: { card: images.length ? "summary_large_image" : "summary", title: m.title, description: m.metaDescription, images: images.map((i) => i.url) },
  };
}

function money(price: number | null, currency: string | null) {
  if (price === null) return null;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).format(price);
  } catch {
    return `${price} ${currency ?? ""}`.trim();
  }
}

const AVAILABILITY: Record<string, string> = { in_stock: "In stock", out_of_stock: "Out of stock", preorder: "Pre-order", unknown: "Availability not reported" };

function structuredData(m: PageRenderModel, deals: PublicDeal[], crumbs: Crumb[]) {
  const site = config.siteUrl();
  const url = new URL(m.canonicalPath, site).toString();
  const publisher = { "@type": "Organization", name: "Made4Buyers", url: site };
  const out: unknown[] = [breadcrumbJsonLd(crumbs, site)];
  const product = { "@type": "Product", name: m.productName, ...(m.brand ? { brand: { "@type": "Brand", name: m.brand } } : {}) };
  if (m.rating) {
    out.push({
      "@context": "https://schema.org",
      "@type": "Review",
      name: m.title,
      url,
      itemReviewed: product,
      reviewRating: { "@type": "Rating", ratingValue: m.rating.value, bestRating: m.rating.scale, worstRating: 0 },
      author: m.source.author ? { "@type": "Person", name: m.source.author } : { "@type": "Organization", name: m.source.name },
      publisher,
      datePublished: m.publishedAt ?? undefined,
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
      datePublished: m.publishedAt ?? undefined,
      dateModified: m.updatedAt,
      ...(m.source.author ? { author: { "@type": "Person", name: m.source.author } } : {}),
      publisher,
      about: { "@type": "Thing", name: m.productName },
    });
  }
  // Product + Offer only when a verified offer with a real price exists.
  const priced = deals.find((d) => d.isBest && d.price !== null && d.currency);
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

export default async function ReviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await loadPage(slug);
  if (!page) notFound();
  const { review, model: m } = page;
  const [deals, related, brand] = await Promise.all([verifiedDeals(review.id), relatedReviews(review, 3), brandPageEligible(review.brandSlug)]);
  const crumbs: Crumb[] = [{ name: "Home", href: "/" }];
  if (m.category) crumbs.push({ name: m.category.name, href: `/category/${m.category.slug}` });
  if (m.category && m.subcategory) crumbs.push({ name: m.subcategory.name, href: `/category/${m.category.slug}?sub=${m.subcategory.slug}` });
  crumbs.push({ name: m.productName, href: m.canonicalPath });
  const best = deals.find((d) => d.isBest) ?? deals[0];
  const alternates = deals.filter((d) => d !== best);
  const published = m.publishedAt ? new Date(m.publishedAt) : null;
  const sections = [
    { id: "review", label: "Review" },
    { id: "deal", label: best ? "Verified offer" : "Offer" },
    ...(m.keyEntities.length ? [{ id: "facts", label: "Key facts" }] : []),
    ...(related.length ? [{ id: "related", label: "Related" }] : []),
  ];

  return (
    <main style={themeStyle(m.category?.slug) as React.CSSProperties}>
      {structuredData(m, deals, crumbs).map((d, i) => (
        <JsonLd key={i} data={d} />
      ))}
      <header className="review-hero">
        <div className="container review-hero-inner">
          <div>
            <Breadcrumbs items={crumbs} />
            <div className="meta-row">
              {m.category && <span className="pill">{m.category.name}</span>}
              {m.subcategory && <span className="pill plain">{m.subcategory.name}</span>}
              {best && <span className="pill verified">Verified offer</span>}
            </div>
            <h1>{m.title}</h1>
            <p className="lede">{m.summary}</p>
            <p className="small muted">
              {m.brand ? `${m.brand} ` : ""}
              {m.productName}
              {published && (
                <>
                  {" "}
                  — reviewed <time dateTime={published.toISOString()}>{published.toLocaleDateString("en-US", { dateStyle: "long" })}</time>
                </>
              )}
            </p>
            <div className="btnrow">
              {best ? (
                <a className="btn primary" href="#deal">
                  See the verified offer
                </a>
              ) : null}
              <Link className="btn" href={`/compare?ids=${review.id}`}>
                Compare with others
              </Link>
            </div>
          </div>
          <ParallaxFigure src={m.image.url} fallback={placeholderPath(m.category?.slug)} alt={m.image.alt} width={m.image.width} height={m.image.height} caption={m.image.attribution} captionUrl={m.image.attributionUrl} />
        </div>
      </header>
      <SectionNav items={sections} />
      <div className="container review-layout">
        <article className="review-article">
          <section id="review" aria-labelledby="review-heading">
            <h2 id="review-heading" className="visually-hidden">
              Review
            </h2>
            <div className="review-body">
              {m.bodyParagraphs.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
            <p className="small muted">
              Source: {m.source.url ? <a href={m.source.url} rel="nofollow noopener" target="_blank">{m.source.name}</a> : m.source.name}
              {m.source.author ? `, by ${m.source.author}` : ""}
              {m.source.publishedAt ? `, originally published ${new Date(m.source.publishedAt).toLocaleDateString("en-US", { dateStyle: "medium" })}` : ""}.
            </p>
            <nav className="btnrow" aria-label="Related pages">
              {m.category && (
                <Link className="btn" href={`/category/${m.category.slug}`}>
                  All {m.category.name.toLowerCase()} reviews
                </Link>
              )}
              {brand.eligible && m.brand && m.brandSlug && (
                <Link className="btn" href={`/brand/${m.brandSlug}`}>
                  More from {m.brand}
                </Link>
              )}
            </nav>
          </section>
          {related.length > 0 && (
            <section id="related" aria-labelledby="related-heading" style={{ marginTop: 32 }}>
              <h2 id="related-heading">Related reviews</h2>
              <ReviewGrid reviews={related} />
            </section>
          )}
        </article>

        <aside className="aside-stack" aria-label="Offer and product details">
          <section id="deal" className={`panel ${best ? "deal-panel" : ""}`} aria-labelledby="deal-heading">
            <h2 id="deal-heading" className={best ? "visually-hidden" : undefined}>
              {best ? "Verified offer" : "Offer"}
            </h2>
            {best ? (
              <>
                <DealImpression linkId={best.linkId} reviewId={review.id} categorySlug={m.category?.slug}>
                  <div className="verified-head">Verified offer</div>
                  {money(best.price, best.currency) ? <div className="price">{money(best.price, best.currency)}</div> : <div className="small" style={{ marginTop: 8 }}>Price shown at the retailer</div>}
                  <div className="merchant">{best.merchant ?? "Retailer"}</div>
                  <div className="small muted">{AVAILABILITY[best.availability ?? "unknown"] ?? best.availability}</div>
                  <a className="btn primary large" href={`/go/${best.linkId}`} rel="sponsored nofollow noopener" target="_blank">
                    View deal<span className="visually-hidden"> for {m.productName} at {best.merchant ?? "the retailer"} (opens in a new tab)</span>
                  </a>
                </DealImpression>
                <p className="small muted" style={{ marginBottom: 0 }}>
                  Link checked <time dateTime={best.verifiedAt}>{new Date(best.verifiedAt).toLocaleDateString("en-US", { dateStyle: "medium" })}</time>. Prices and availability can change at the retailer.
                </p>
                {alternates.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <h3 style={{ fontSize: 16 }}>Other verified offers</h3>
                    {alternates.map((d) => (
                      <DealImpression key={d.linkId} linkId={d.linkId} reviewId={review.id} categorySlug={m.category?.slug}>
                        <div className="deal-alt">
                          <div>
                            <div className="small" style={{ fontWeight: 700 }}>{d.merchant ?? "Retailer"}</div>
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
              <div className="no-deal" role="status">
                <strong>No verified offer available right now.</strong>
                <p className="small">We only show a deal after confirming its link reaches the retailer.</p>
              </div>
            )}
            <p className="disclosure">
              Made4Buyers may earn a commission from qualifying purchases made through offer links. <Link href="/disclosure">Affiliate disclosure</Link>
            </p>
          </section>
          {m.keyEntities.length > 0 && (
            <section id="facts" className="panel" aria-labelledby="facts-heading">
              <h2 id="facts-heading">Key facts</h2>
              <dl className="entity-list">
                {m.keyEntities.map((e) => (
                  <div key={e.label} style={{ display: "contents" }}>
                    <dt>{e.label}</dt>
                    <dd>{e.value}</dd>
                  </div>
                ))}
                {m.priceTier && (
                  <>
                    <dt>Price tier</dt>
                    <dd>{m.priceTier.name}</dd>
                  </>
                )}
              </dl>
              {(m.intents.length > 0 || m.platforms.length > 0) && m.category && (
                <ul className="chips" aria-label="Find similar">
                  {m.intents.map((t) => (
                    <li key={t.slug}>
                      <Link className="chip neutral" href={`/category/${m.category!.slug}?intent=${t.slug}`}>
                        {t.name}
                      </Link>
                    </li>
                  ))}
                  {m.platforms.map((t) => (
                    <li key={t.slug}>
                      <Link className="chip neutral" href={`/category/${m.category!.slug}?platform=${t.slug}`}>
                        {t.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          <SponsoredSlot position="REVIEW_SIDEBAR" categorySlug={m.category?.slug} />
        </aside>
      </div>
      {best && (
        <aside className="sticky-cta" aria-label="Verified offer shortcut">
          <div>
            <div style={{ fontWeight: 800 }}>{money(best.price, best.currency) ?? "Verified offer"}</div>
            <div className="small">{best.merchant ?? "Retailer"}</div>
          </div>
          <a className="btn primary" href={`/go/${best.linkId}`} rel="sponsored nofollow noopener" target="_blank">
            View deal<span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        </aside>
      )}
    </main>
  );
}
