import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache, Fragment } from "react";
import Breadcrumbs, { breadcrumbJsonLd, type Crumb } from "@/components/breadcrumbs";
import DealImpression from "@/components/deal-impression";
import JsonLd from "@/components/json-ld";
import { KindPill, kindNoun, ReviewGrid } from "@/components/review-card";
import { ParallaxFigure, SectionNav } from "@/components/review-chrome";
import { themeStyle } from "@/lib/taxonomy/themes";
import { placeholderPath } from "@/lib/pipeline/images";
import SponsoredSlot from "@/components/sponsored-slot";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import VerifiedCoupons from "@/components/verified-coupons";
import { buildPageRenderModel, currentProductData, dedupeRetailerLinks, RENDER_MODEL_VERSION, type PageRenderModel } from "@/lib/pipeline/render-model";
import { displayDate, displayNumber, displayText, displayUrl, NO_VERIFIED_PRICE } from "@/lib/public/display";
import { commerceBrandIdForReview, freshOffersForReview, offerIsFresh, type PublicOffer } from "@/lib/public/offers";
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

/** schema.org availability for a stored availability value; undefined when it is not stated. */
function schemaAvailability(v: string | null): string | undefined {
  const k = (v ?? "").toLowerCase().replace(/^https?:\/\/schema\.org\//, "").replace(/[\s_-]/g, "");
  if (k === "instock") return "https://schema.org/InStock";
  if (k === "outofstock" || k === "soldout") return "https://schema.org/OutOfStock";
  if (k === "preorder") return "https://schema.org/PreOrder";
  if (k === "backorder") return "https://schema.org/BackOrder";
  return undefined;
}

function structuredData(m: PageRenderModel, offers: PublicOffer[], crumbs: Crumb[]) {
  const site = config.siteUrl();
  const url = new URL(m.canonicalPath, site).toString();
  const publisher = { "@type": "Organization", name: "Made4Buyers", url: site };
  const out: unknown[] = [breadcrumbJsonLd(crumbs, site)];
  const brand = displayText(m.brand);
  const product = { "@type": "Product", name: displayText(m.productName), ...(brand ? { brand: { "@type": "Brand", name: brand } } : {}) };
  const author = displayText(m.source.author);
  const sourceUrl = displayUrl(m.source.url);
  const rating = validRating(m.rating);
  // Review markup only for text we publish in full; an excerpt page is an article about the
  // product that cites the original review, never a review of our own.
  const excerpt = m.textRights === "EXCERPT";
  // Review markup only for a single-product review whose full text we publish.
  if (rating && !excerpt && m.kind === "REVIEW" && product.name) {
    out.push({
      "@context": "https://schema.org",
      "@type": "Review",
      name: m.title,
      url,
      itemReviewed: product,
      reviewRating: { "@type": "Rating", ratingValue: rating.value, bestRating: rating.scale, worstRating: 0 },
      author: author ? { "@type": "Person", name: author } : { "@type": "Organization", name: displayText(m.source.name) },
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
      ...(m.kind === "AI_GUIDE" || excerpt ? { author: publisher } : author ? { author: { "@type": "Person", name: author } } : {}),
      publisher,
      about: (m.products ?? []).length > 1 ? m.products.map((p) => ({ "@type": "Thing", name: p.name })) : { "@type": "Thing", name: m.products?.[0]?.name ?? m.productName },
      ...(excerpt && sourceUrl ? { isBasedOn: sourceUrl, citation: { "@type": "CreativeWork", url: sourceUrl, ...(author ? { author: { "@type": "Person", name: author } } : {}), publisher: { "@type": "Organization", name: displayText(m.source.name) } } } : {}),
    });
  }
  // Product + Offer only when a fresh observed price exists (no priceValidUntil: we never invent one).
  const priced = m.kind === "REVIEW" ? offers.find((o) => money(o.price, o.currency) !== null && displayUrl(o.url) && offerIsFresh(o)) : undefined;
  if (priced && product.name) {
    const availability = schemaAvailability(priced.availability);
    out.push({
      "@context": "https://schema.org",
      ...product,
      offers: {
        "@type": "Offer",
        price: priced.price,
        priceCurrency: priced.currency,
        url: displayUrl(priced.url),
        ...(availability ? { availability } : {}),
        seller: { "@type": "Organization", name: displayText(priced.seller) },
      },
    });
  }
  return out;
}

/** A rating only when both numbers are real: a positive scale and a value within it. */
function validRating(r: PageRenderModel["rating"]): { value: number; scale: number } | null {
  const scale = displayNumber(r?.scale, { positive: true });
  const value = scale === null ? null : displayNumber(r?.value, { min: 0, max: scale });
  return scale !== null && value !== null ? { value, scale } : null;
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
  const [liveOffers, commerceBrandId, related, brand, guidesRaw] = await Promise.all([m.kind === "REVIEW" ? freshOffersForReview(review.id) : Promise.resolve([]), m.kind === "REVIEW" ? commerceBrandIdForReview(review.id, m.brand) : Promise.resolve(null), relatedReviews(review, 3), brandPageEligible(review.brandSlug), m.category ? latestByKind("AI_GUIDE", 4, m.category.slug) : Promise.resolve([])]);
  const guides = guidesRaw.filter((g) => g.id !== review.id).slice(0, 3);
  const crumbs: Crumb[] = [{ name: "Home", href: "/" }];
  if (m.category) crumbs.push({ name: m.category.name, href: `/category/${m.category.slug}` });
  if (m.category && m.subcategory) crumbs.push({ name: m.subcategory.name, href: `/category/${m.category.slug}?sub=${m.subcategory.slug}` });
  crumbs.push({ name: m.productName, href: m.canonicalPath });
  // Live offers at request time; a price is shown only while its observation is fresh.
  // Only offers with a usable public link; a price only with a real amount and ISO currency.
  // An offer without a verified price is not listed (plain seller links appear under "Where to buy").
  const offers = liveOffers.filter((o) => offerIsFresh(o) && displayUrl(o.url) && displayText(o.seller) && money(o.price, o.currency) !== null);
  const priced = offers;
  const best = priced[0] ?? null;
  const bestPrice = best ? money(best.price, best.currency) : null;
  const retailerLinks = dedupeRetailerLinks(m.retailerLinks ?? [], offers).filter((l) => displayUrl(l.url) && displayText(l.label));
  const rating = validRating(m.rating);
  const sourceName = displayText(m.source.name);
  const sourceAuthor = displayText(m.source.author);
  const sourceUrl = displayUrl(m.source.url);
  const summary = displayText(m.summary);
  const pros = (m.highlights?.pros ?? []).filter((t) => displayText(t));
  const cons = (m.highlights?.cons ?? []).filter((t) => displayText(t));
  const published = displayDate(m.publishedAt);
  const sourceDate = displayDate(m.source.publishedAt);
  const fact = (label: string) => displayText(m.keyEntities.find((e) => e.label === label)?.value);
  // Key facts: values a source stated (with provenance), never guessed. Rows that cannot apply
  // (a platform for a kettle, a model for a category guide) are left out instead of "Not available".
  const pd = currentProductData(m.productData);
  const pv = (k: string) => {
    const f = pd?.fields[k];
    if (!f || f.value == null) return null;
    const v = displayText(Array.isArray(f.value) ? f.value.map((x) => displayText(x)).filter(Boolean).join(", ") : typeof f.value === "number" ? displayNumber(f.value) : f.value);
    if (!v) return null;
    return f.unit && displayText(f.unit) && k !== "price" && !/^\//.test(f.unit) && !v.toLowerCase().endsWith(f.unit.toLowerCase()) ? `${v} ${f.unit}` : v;
  };
  const via = (k: string) => {
    const f = pd?.fields[k];
    return displayText(f?.sourceName) && f ? `${f.source === "MANUFACTURER" ? "Manufacturer" : f.source === "RETAILER" ? "Retailer" : f.source === "STRUCTURED_FEED" ? "Product feed" : "Source"}: ${f.sourceName}${dateline(f.observedAt) ? `, checked ${dateline(f.observedAt)}` : ""}` : null;
  };
  // Guides, roundups and comparisons cover several products: single-product rows don't apply.
  const categoryLevel = (!m.products?.some((p) => p.role === "PRIMARY") && isGuide) || m.kind === "BUYING_GUIDE" || m.kind === "COMPARISON";
  const compared = (m.products ?? []).filter((p) => p.role === "COMPARED" || p.role === "MENTIONED").map((p) => p.name);
  const same = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
  const typeName = m.subcategory?.name ?? fact("Type");
  const platformApplies = pd ? pd.platform !== "NOT_APPLICABLE" : Boolean(m.platforms.length || fact("Platform"));
  // A stated price fact is shown only with a valid ISO currency (money() returns null otherwise).
  const priceText = pd?.fields.price ? money(Number(pd.fields.price.value), pd.fields.price.unit ?? (pd.fields.currency?.value as string | undefined) ?? null) : null;
  type Row = [label: string, value: string | null, note?: string | null];
  const specs: Row[] = categoryLevel
    ? [
        [m.kind === "COMPARISON" ? "Compares" : "Covers", m.kind === "COMPARISON" && compared.length ? compared.join(" vs ") : m.productName],
        ...(m.brand && m.kind === "BUYING_GUIDE" ? [["Brand", m.brand] as Row] : []),
        ...(m.kind === "BUYING_GUIDE" && compared.length ? [["Products", compared.join(", ")] as Row] : []),
        ...(m.category && !same(m.category.name, m.productName) ? [["Category", m.category.name] as Row] : []),
        ...(typeName && !same(typeName, m.productName) && !same(typeName, m.category?.name) ? [["Type", typeName] as Row] : []),
        ...(m.intents.length ? [["Best for", m.intents.map((i) => i.name).join(", ")] as Row] : []),
      ]
    : [
        ["Brand", pv("brand") ?? m.brand ?? fact("Brand"), pv("brand") ? via("brand") : null],
        ["Product", fact("Product") ?? m.productName],
        ["Model", pv("model") ?? pv("mpn") ?? fact("Model"), pv("model") ? via("model") : pv("mpn") ? via("mpn") : null],
        ...(typeName && !same(typeName, m.productName) ? [["Type", typeName] as Row] : []),
        ...(platformApplies ? [["Platform", m.platforms.map((p) => p.name).join(", ") || pv("operatingSystem") || fact("Platform"), !m.platforms.length && pv("operatingSystem") ? via("operatingSystem") : null] as Row] : []),
        ...(pv("manufacturer") && !same(pv("manufacturer"), pv("brand") ?? m.brand) ? [["Made by", pv("manufacturer"), via("manufacturer")] as Row] : []),
        ...(pv("productFamily") ? [["Product family", pv("productFamily"), via("productFamily")] as Row] : []),
        ...(pv("releaseDate") ? [["Released", pv("releaseDate"), via("releaseDate")] as Row] : []),
        ["Best for", m.intents.map((i) => i.name).join(", ") || fact("Best for")],
        // Only from a current, verified price against the category's published bands (methodology in Admin).
        ["Price tier", pd?.priceTier ? pd.priceTier.tier.charAt(0).toUpperCase() + pd.priceTier.tier.slice(1) : null, pd?.priceTier ? pd.priceTier.methodology : null],
        ...(priceText ? [["Price", priceText, via("price")] as Row] : []),
        ...(["availability", "capacity", "weight", "dimensions", "color", "material", "warranty"] as const).flatMap((k) => (pv(k) ? [[k[0].toUpperCase() + k.slice(1), pv(k), via(k)] as Row] : [])),
      ];
  // Device rows appear only when a source stated them.
  if (!categoryLevel && m.category && ["laptops", "phones", "tablets"].includes(m.category.slug)) for (const label of ["Processor", "Memory", "Display", "Battery"]) if (fact(label)) specs.push([label, fact(label)]);
  // A row with nothing to say is left out (never "Not available"); the section hides when empty.
  const shownSpecs = specs.flatMap(([label, value, note]) => {
    const v = displayText(value);
    return v ? [[label, v, displayText(note)] as Row] : [];
  });
  const quote = pullQuote(m.bodyParagraphs);
  const considerations = m.category && (m.intents.length > 0 || m.platforms.length > 0 || m.priceTier);
  const sections = [
    { id: "review", label: isGuide || m.kind === "BUYING_GUIDE" ? "Guide" : m.kind === "COMPARISON" ? "Comparison" : "Review" },
    ...(m.products?.length ? [{ id: "products", label: m.kind === "COMPARISON" ? "Products compared" : "Product" }] : []),
    ...(shownSpecs.length ? [{ id: "facts", label: "Key facts" }] : []),
    ...(considerations ? [{ id: "considerations", label: "Buying considerations" }] : []),
    { id: "deal", label: "Where to buy" },
    ...(related.length ? [{ id: "alternatives", label: "Alternatives" }] : []),
    ...(guides.length ? [{ id: "guides", label: "Guides" }] : []),
  ];

  return (
    <main style={themeStyle(m.category?.slug) as React.CSSProperties}>
      {structuredData(m, offers, crumbs).map((d, i) => (
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
                <KindPill kind={m.kind} articleType={m.articleType} />
              </div>
              <h1>{m.title}</h1>
              {summary && <p className="lede">{summary}</p>}
              <div className="btnrow">
                {bestPrice ? (
                  <a className="btn primary" href="#deal" data-cursor="Prices">
                    {`See prices, from ${bestPrice}`}
                  </a>
                ) : null}
                <Link className="btn" href={`/compare?ids=${review.id}`} data-cursor="Compare">
                  Compare with others
                </Link>
              </div>
            </div>
            <ParallaxFigure src={m.image.url} fallback={placeholderPath(m.category?.slug)} alt={m.image.alt} width={m.image.width} height={m.image.height} caption={m.image.attribution} captionUrl={m.image.attributionUrl} illustrative={m.image.subject === "ILLUSTRATIVE" || m.image.isFallback} />
          </div>
          <dl className="article-meta">
            <div>
              <dt>Product</dt>
              <dd>
                {displayText(m.brand) && !m.productName.startsWith(m.brand!) ? `${m.brand} ` : ""}
                {m.productName}
              </dd>
            </div>
            {(isGuide || sourceName) && (
              <div>
                <dt>{isGuide ? "Written by" : "Source"}</dt>
                <dd>{isGuide ? "Made4Buyers" : sourceAuthor ? `${sourceName}, ${sourceAuthor}` : sourceName}</dd>
              </div>
            )}
            {(isGuide ? published : sourceDate) && (
              <div>
                <dt>{isGuide ? "Published" : "Reviewed"}</dt>
                <dd>
                  <time dateTime={(isGuide ? published : sourceDate)!.toISOString()}>{dateline(isGuide ? published : sourceDate)}</time>
                </dd>
              </div>
            )}
            <div>
              <dt>Rating</dt>
              <dd>{rating ? `${rating.value} / ${rating.scale}${sourceName ? `, by ${sourceName}` : ""}` : <span className="na">{isGuide ? "Guides are never rated" : "Not given by the source"}</span>}</dd>
            </div>
            {m.kind === "REVIEW" && (
              <div>
                <dt>Price</dt>
                <dd>{best && bestPrice ? [bestPrice, displayText(best.seller) && `at ${best.seller}`, dateline(best.observedAt) && `checked ${dateline(best.observedAt)}`].filter(Boolean).join(" ").replace(/ checked/, ", checked") : <span className="na">{NO_VERIFIED_PRICE}</span>}</dd>
              </div>
            )}
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
            {isGuide ? null : (
              <aside className="kind-banner review" aria-label="About this review">
                <div>
                  <strong>
                    {m.kind === "COMPARISON" ? "Comparison" : m.kind === "BUYING_GUIDE" ? "Buying guide" : "Review"}
                    {sourceName ? ` from ${sourceName}` : ""}.
                  </strong>
                  {sourceAuthor ? `Written by ${sourceAuthor}. ` : ""}We summarise and file it for buyers, and show prices only while recently checked.
                </div>
              </aside>
            )}
            {m.textRights === "EXCERPT" && (
              <div className="callout" style={{ marginBottom: 26 }}>
                <span className="label muted">Excerpt</span>
                {summary && (
                  <p className="prose" style={{ fontFamily: "var(--f-read)", fontSize: 19, margin: "0 0 10px" }}>
                    {summary}
                  </p>
                )}
                <p style={{ margin: 0 }}>
                  This is a short excerpt. The full {kindNoun(m.kind)} belongs to {sourceName ?? "its original publisher"}
                  {sourceUrl ? (
                    <>
                      :{" "}
                      <a href={sourceUrl} rel="noopener" target="_blank" data-cursor="Read" data-track="outbound" data-review-id={m.reviewId} data-kind="source">
                        read it on {sourceName ?? "the publisher's site"}
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
                      <footer>{isGuide ? "From this guide" : sourceName ? `From the review, ${sourceName}` : "From the review"}</footer>
                    </blockquote>
                  )}
                </Fragment>
              ))}
            </div>
            {isGuide ? (
              <p className="small muted">Drafted with an AI writing tool and edited by Made4Buyers.</p>
            ) : (
              sourceName && (
                <p className="small muted">
                  Source:{" "}
                  {sourceUrl ? (
                    <a href={sourceUrl} rel="nofollow noopener" target="_blank">
                      {sourceName}
                    </a>
                  ) : (
                    sourceName
                  )}
                  {sourceAuthor ? `, by ${sourceAuthor}` : ""}
                  {shortDate(sourceDate) ? `, originally published ${shortDate(sourceDate)}` : ""}
                  {shortDate(published) ? `; added to Made4Buyers ${shortDate(published)}` : ""}.
                </p>
              )
            )}
          </section>

          {m.products?.length > 0 && (
            <section id="products" aria-labelledby="products-heading">
              <h2 id="products-heading">{m.kind === "COMPARISON" ? `Products compared (${m.products.length})` : m.products.length > 1 ? "Products covered" : "Product"}</h2>
              <ul className="entity-list">
                {m.products.map((p) => (
                  <li key={p.slug}>
                    <Link href={`/product/${p.slug}`}>{p.name}</Link>
                    {displayText(p.brand) && <span> · {p.brand}</span>}
                  </li>
                ))}
              </ul>
              {m.kind === "COMPARISON" && <p className="muted small">Each product links to everything we have filed about it. We don’t pick a winner the source didn’t.</p>}
            </section>
          )}

          {shownSpecs.length > 0 && (
            <section id="facts" aria-labelledby="facts-heading">
              <h2 id="facts-heading">Key facts</h2>
              <table className="spec-table">
                <caption className="visually-hidden">Key facts about {m.productName}</caption>
                <tbody>
                  {shownSpecs.map(([label, value, note]) => (
                    <tr key={label}>
                      <th scope="row">{label}</th>
                      <td>
                        {value}
                        {note && <div className="small muted">{note}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {(pros.length > 0 || cons.length > 0) && (
            <section id="pros-cons" aria-labelledby="pc-heading">
              <h2 id="pc-heading">Pros and cons</h2>
              {sourceName && <p className="muted small">As listed by {sourceName} in its review.</p>}
              <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                {pros.length > 0 && (
                  <div>
                    <h3 style={{ margin: "0 0 6px" }}>Pros</h3>
                    <ul>{pros.map((t) => <li key={t}>{t}</li>)}</ul>
                  </div>
                )}
                {cons.length > 0 && (
                  <div>
                    <h3 style={{ margin: "0 0 6px" }}>Cons</h3>
                    <ul>{cons.map((t) => <li key={t}>{t}</li>)}</ul>
                  </div>
                )}
              </div>
            </section>
          )}

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
            {brand.eligible && displayText(m.brand) && m.brandSlug && (
              <Link className="btn" href={`/brand/${m.brandSlug}`}>
                More from {m.brand}
              </Link>
            )}
          </nav>
        </article>

        <aside className="doc-aside" aria-label="Offer and product details">
          <section id="deal" className="panel" aria-labelledby="deal-heading">
            <h2 id="deal-heading">Where to buy</h2>
            {priced.length === 0 && (
              <div className="no-offer" role="status">
                <strong>{m.kind === "REVIEW" ? NO_VERIFIED_PRICE : "Prices appear on each product’s own review."}</strong>
                <p>{m.kind === "REVIEW" ? "We show a price only while we have recently checked it at the maker or a retailer, and never an older one." : "This page covers several products; prices appear on each product’s own review."}</p>
              </div>
            )}
            {offers.length > 0 && (
              <ul className="offer-list" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
                {offers.map((o) => (
                  <li key={o.id}>
                    <DealImpression offerId={o.id} reviewId={review.id} categorySlug={m.category?.slug}>
                      <div className="offer-alt">
                        <div>
                          <div className="small" style={{ fontWeight: 700 }}>
                            {o.seller}
                            {o.sellerType === "MANUFACTURER" && <span className="muted"> · official store</span>}
                          </div>
                          {money(o.price, o.currency) && (
                            <div className="small">
                              <strong>{money(o.price, o.currency)}</strong> at {o.seller}
                              {shortDate(o.observedAt) && (
                                <>
                                  {" "}
                                  · checked <time dateTime={o.observedAt}>{shortDate(o.observedAt)}</time>
                                </>
                              )}
                            </div>
                          )}
                          {money(o.price, o.currency) && availabilityLabel(o.availability) && <div className="small muted">{availabilityLabel(o.availability)}</div>}
                        </div>
                        <a className="btn small" href={`/go/${o.id}`} rel={o.affiliated ? "sponsored nofollow noopener" : "nofollow noopener"} target="_blank">
                          View<span className="visually-hidden"> {m.productName} at {o.seller} (opens in a new tab)</span>
                        </a>
                      </div>
                    </DealImpression>
                  </li>
                ))}
              </ul>
            )}
            {priced.length > 0 && <p className="small muted" style={{ margin: "12px 0 0" }}>Prices and availability can change at the seller; always confirm the final price there.</p>}
            {/* Direct links built only from stored URLs: never a price on their own. */}
            {retailerLinks.length > 0 && (
              <div className="where-to-buy">
                <h3>{offers.length ? "More places to look" : "Where to buy"}</h3>
                <ul>
                  {retailerLinks.map((l) => (
                    <li key={l.url}>
                      <a href={l.url} rel="nofollow noopener" target="_blank">
                        {l.label}
                        <span className="visually-hidden"> (opens in a new tab)</span>
                      </a>
                      {l.kind === "official" && displayText(l.merchant) && <span className="small muted"> · {l.merchant}</span>}
                    </li>
                  ))}
                </ul>
                <p className="small muted">Links go to the retailer or the maker&rsquo;s site.</p>
              </div>
            )}
            {m.kind === "REVIEW" && (commerceBrandId || m.brand) && <VerifiedCoupons brandId={commerceBrandId} merchant={commerceBrandId ? null : m.brand} />}
            <p className="disclosure">
              {offers.some((o) => o.affiliated) ? "Made4Buyers may earn a commission from purchases made through some links on this page." : "Links to sellers are plain links; we earn nothing from them."} <Link href="/disclosure">Affiliate disclosure</Link>
            </p>
          </section>
          <SponsoredSlot position="REVIEW_SIDEBAR" categorySlug={m.category?.slug} />
        </aside>
      </div>
    </main>
  );
}
