import type { Metadata } from "next";
import Link from "next/link";
import Breadcrumbs from "@/components/breadcrumbs";
import { DealCard, dealRowShowable } from "@/components/deal-ledger";
import DealsFilter from "@/components/deals-filter";
import EmptyState from "@/components/empty-state";
import JsonLd from "@/components/json-ld";
import { PriceDropGrid, PromoCodeGrid } from "@/components/official-deals";
import SectionHeader from "@/components/section-header";
import { config } from "@/lib/config";
import { officialDeals, type OfficialDeals } from "@/lib/public/deals";
import { NO_VERIFIED_OFFER } from "@/lib/public/display";
import { prerenderNeedsDatabase } from "@/lib/public/isr";
import { freshDealRows } from "@/lib/public/queries";
import { categoryName } from "@/lib/taxonomy/definitions";
import { dateline } from "@/lib/util/format";

/**
 * Deals: official price drops and official promo codes, read by the commerce engine from brands'
 * own sites (lib/public/deals.ts), plus recently checked prices for reviewed products. Cached (ISR,
 * 5 minutes; the data is tagged "deals" so the commerce engine can refresh it on demand). Filters
 * run in the browser so the page stays cacheable.
 */
export const revalidate = 300;

export async function generateMetadata(): Promise<Metadata> {
  await prerenderNeedsDatabase();
  const { drops, codes } = await officialDeals();
  return {
    title: "Deals",
    description: "Official price drops and promo codes read from brands’ own sites, each with the date we checked it. Only verified, current offers are listed.",
    alternates: { canonical: "/deals" },
    // An empty deals page is not a useful search result.
    robots: drops.length + codes.length === 0 ? { index: false, follow: true } : undefined,
  };
}

/** ItemList of Product + Offer, only for fresh priced drops (no priceValidUntil: none is stated). */
function dealsJsonLd(deals: OfficialDeals, site: string) {
  if (!deals.drops.length) return null;
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Official price drops",
    url: new URL("/deals", site).toString(),
    itemListElement: deals.drops.slice(0, 50).map((d, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "Product",
        name: d.productName,
        ...(d.brandName ? { brand: { "@type": "Brand", name: d.brandName } } : {}),
        ...(d.review ? { url: new URL(`/review/${d.review.slug}`, site).toString() } : {}),
        offers: { "@type": "Offer", price: d.price, priceCurrency: d.currency, url: d.url, seller: { "@type": "Organization", name: d.official ? d.brandName : d.seller } },
      },
    })),
  };
}

function options(entries: Array<[string, string]>): Array<{ value: string; label: string; count: number }> {
  const counts = new Map<string, { label: string; count: number }>();
  for (const [value, label] of entries) counts.set(value, { label, count: (counts.get(value)?.count ?? 0) + 1 });
  return [...counts.entries()].map(([value, { label, count }]) => ({ value, label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export default async function Deals() {
  await prerenderNeedsDatabase();
  const [deals, priceRows] = await Promise.all([officialDeals(), freshDealRows({ take: 60 })]);
  const { drops, codes, checkedAt } = deals;
  const prices = priceRows.filter(dealRowShowable);
  const site = config.siteUrl();
  const ld = dealsJsonLd(deals, site);
  const categoryOptions = options([
    ...drops.flatMap((d) => d.categories.map((c) => [c, categoryName(c) ?? ""] as [string, string])),
    ...codes.flatMap((c) => c.categories.map((x) => [x, categoryName(x) ?? ""] as [string, string])),
    ...prices.flatMap((p) => (p.review.categorySlug ? [[p.review.categorySlug, categoryName(p.review.categorySlug) ?? ""] as [string, string]] : [])),
  ]).filter((o) => o.label);
  const brandOptions = options([...drops.flatMap((d) => (d.brandSlug && d.brandName ? [[d.brandSlug, d.brandName] as [string, string]] : [])), ...codes.map((c) => [c.brandSlug, c.brandName] as [string, string])]);
  const nothing = drops.length + codes.length === 0;

  return (
    <main id="deals-root">
      {ld && <JsonLd data={ld} />}
      <section className="page-hero">
        <div className="wrap">
          <div className="ph-top">
            <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Deals", href: "/deals" }]} />
            {dateline(checkedAt) && <span className="label muted">Last check {dateline(checkedAt)}</span>}
          </div>
          <h1>
            Deals.
            <span style={{ display: "block", fontSize: "0.4em", lineHeight: 0.95, marginTop: "0.14em", fontVariationSettings: "\"wdth\" 88", letterSpacing: "0.005em" }}>Official and verified, or not listed.</span>
          </h1>
          <p className="lede">Price drops and promo codes read from brands’ own sites. A price drop is listed only when the seller’s page states both the current price and a higher regular price; the saving is worked out from those two numbers. Every offer says when we checked it, and nothing older than 48 hours is shown.</p>
          {!nothing && <DealsFilter categories={categoryOptions} brands={brandOptions} />}
        </div>
      </section>

      {nothing && (
        <section className="section" aria-label="Deals">
          <div className="wrap">
            <EmptyState title={NO_VERIFIED_OFFER} label="Deals" action={<Link className="btn" href="/reviews">Browse all reviews</Link>}>
              We list a deal only when a brand’s own site states it and we have checked it recently. New offers appear here automatically once verified.
            </EmptyState>
          </div>
        </section>
      )}

      {drops.length > 0 && (
        <section className="section" aria-labelledby="drops-title" data-deal-section="">
          <div className="wrap">
            <SectionHeader id="drops-title" label={`${drops.length} verified`} title="Official price drops">
              Current price and regular price as stated on the seller’s page, biggest saving first.
            </SectionHeader>
            <PriceDropGrid drops={drops} />
            <p className="muted" data-deal-empty="" hidden>
              {NO_VERIFIED_OFFER}
            </p>
          </div>
        </section>
      )}

      {codes.length > 0 && (
        <section className="section" aria-labelledby="codes-title" data-deal-section="">
          <div className="wrap">
            <SectionHeader id="codes-title" label={`${codes.length} verified`} title="Official promo codes">
              Codes published by the brand on its own site, still listed there at our last check and not expired. The discount is quoted exactly as the brand states it.
            </SectionHeader>
            <PromoCodeGrid codes={codes} />
            <p className="muted" data-deal-empty="" hidden>
              {NO_VERIFIED_OFFER}
            </p>
          </div>
        </section>
      )}

      {prices.length > 0 && (
        <section className="section tight" aria-labelledby="prices-title" data-deal-section="">
          <div className="wrap">
            <SectionHeader id="prices-title" label={`${prices.length} current`} title="Current prices on reviewed products">
              Recently checked prices at the maker’s store or a retailer, for products we have reviews of. Not necessarily a discount.
            </SectionHeader>
            <ul className="deal-grid">
              {prices.map((d) => (
                <li key={d.offerId} data-deal="" data-categories={d.review.categorySlug ?? ""} data-brand={d.review.brandSlug ?? ""}>
                  <DealCard d={d} />
                </li>
              ))}
            </ul>
            <p className="muted" data-deal-empty="" hidden>
              No current price matches this filter.
            </p>
          </div>
        </section>
      )}

      <section className="section tight" aria-label="About these offers">
        <div className="wrap">
          <p className="small muted">
            Prices and codes can change at the seller; always confirm the final price there. Links go directly to the seller unless marked as affiliate links. <Link href="/disclosure">Affiliate disclosure</Link>
          </p>
        </div>
      </section>
    </main>
  );
}
