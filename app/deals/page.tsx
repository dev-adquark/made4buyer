import type { Metadata } from "next";
import Link from "next/link";
import Breadcrumbs from "@/components/breadcrumbs";
import DealsFilter from "@/components/deals-filter";
import EmptyState from "@/components/empty-state";
import JsonLd from "@/components/json-ld";
import { CurrentPriceGrid, PriceDropGrid, PromoCodeGrid } from "@/components/official-deals";
import SectionHeader from "@/components/section-header";
import { couponMaxAgeDays } from "@/lib/commerce/deal-status";
import { config } from "@/lib/config";
import { officialDeals, recentlyVerifiedPrices, type OfficialDeals } from "@/lib/public/deals";
import { NO_VERIFIED_OFFER } from "@/lib/public/display";
import { prerenderNeedsDatabase } from "@/lib/public/isr";
import { categoryName } from "@/lib/taxonomy/definitions";
import { dateline } from "@/lib/util/format";
import "./deals.css";

/**
 * Deals, in three sections, every item verified (lib/public/deals.ts; the rules live in
 * lib/commerce/deal-status.ts):
 *   - Verified price drops: the page states a current and a higher previous price, checked within 48 h.
 *   - Latest verified coupons: codes on the brand's own site, verified within the last 7 days.
 *   - Recently verified: current prices checked within 48 h whose page states no previous price
 *     (labelled as prices, never as deals).
 * Cached (ISR, 5 minutes; the data is tagged "deals" so the commerce engine refreshes it on demand).
 * Filters and sorting run in the browser over the cached data so the page stays cacheable.
 */
export const revalidate = 300;

export async function generateMetadata(): Promise<Metadata> {
  await prerenderNeedsDatabase();
  const { drops, codes } = await officialDeals();
  return {
    title: "Deals",
    description: "Verified price drops, coupons verified in the last 7 days, and recently checked prices from brands’ own sites and confirmed retailers. Only verified, current offers are listed.",
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
    name: "Verified price drops",
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
  for (const [value, label] of entries) if (value && label) counts.set(value, { label, count: (counts.get(value)?.count ?? 0) + 1 });
  return [...counts.entries()].map(([value, { label, count }]) => ({ value, label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export default async function Deals() {
  await prerenderNeedsDatabase();
  const [deals, prices] = await Promise.all([officialDeals(), recentlyVerifiedPrices().catch(() => [])]);
  const { drops, codes } = deals;
  const checkedAt = [deals.checkedAt, ...prices.map((p) => p.observedAt)].filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
  const site = config.siteUrl();
  const ld = dealsJsonLd(deals, site);
  const windowDays = couponMaxAgeDays();
  const all = [...drops, ...codes, ...prices];
  const categoryOptions = options(all.flatMap((d) => d.categories.map((c) => [c, categoryName(c) ?? ""] as [string, string])));
  const brandOptions = options(all.flatMap((d) => (d.brandSlug && d.brandName ? [[d.brandSlug, d.brandName] as [string, string]] : [])));
  const sellerOptions = options([
    ...drops.map((d) => [d.sellerDomain ?? "", d.official ? `${d.brandName ?? d.seller} (official)` : d.seller] as [string, string]),
    ...prices.map((p) => [p.sellerDomain ?? "", p.official ? `${p.brandName ?? p.seller} (official)` : p.seller] as [string, string]),
    ...codes.map((c) => [c.sellerDomain ?? "", `${c.brandName} (official)`] as [string, string]),
  ]);
  // No price drop and no coupon: the page says so plainly (current prices, if any, still follow; they are not deals).
  const noDeals = drops.length + codes.length === 0;

  return (
    <main id="deals-root" className="deals-page">
      {ld && <JsonLd data={ld} />}
      <section className="page-hero">
        <div className="wrap">
          <div className="ph-top">
            <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Deals", href: "/deals" }]} />
            {dateline(checkedAt) && <span className="label muted">Last check {dateline(checkedAt)}</span>}
          </div>
          <h1>
            Deals.
            <span className="deals-sub">Official and verified, or not listed.</span>
          </h1>
          <p className="lede">Price drops, coupons and current prices read from brands’ own sites and confirmed retailers. A price drop is listed only when the seller’s page states both the current price and a higher previous price; a coupon only when the brand’s own site published it within the last {windowDays} days. Every item says when we checked it.</p>
          {!noDeals && (
            <nav className="deals-jump" aria-label="Deal sections">
              <a href="#drops">Price drops ({drops.length})</a>
              <a href="#coupons">Coupons ({codes.length})</a>
              <a href="#recent">Recently verified ({prices.length})</a>
            </nav>
          )}
          {all.length > 0 && <DealsFilter categories={categoryOptions} brands={brandOptions} sellers={sellerOptions} total={all.length} />}
        </div>
      </section>

      {noDeals && (
        <section className="section" aria-label="Deals">
          <div className="wrap">
            <EmptyState title={NO_VERIFIED_OFFER} label="Deals" action={<Link className="btn" href="/reviews">Browse all reviews</Link>}>
              We list a deal only when a brand’s own site or a confirmed retailer states it and we have checked it recently. New offers appear here automatically once verified.
            </EmptyState>
          </div>
        </section>
      )}

      {!noDeals && (
        <>
          <section id="drops" className="section deals-section" aria-labelledby="drops-title" data-deal-section="">
            <div className="wrap">
              <SectionHeader id="drops-title" label={`${drops.length} verified`} title="Verified price drops">
                The current price and the previous price exactly as the seller’s page states them, read from the brand’s official site (or a retailer, for a product confirmed on the official site), in stock and checked within 48 hours. Never a manufacturer’s suggested price, never a refurbished item.
              </SectionHeader>
              {drops.length ? <PriceDropGrid drops={drops} /> : <p className="deals-empty">No verified price drop right now. Drops appear here once a seller’s page states a lower price than its own previous price.</p>}
              <p className="deals-empty" data-deal-empty="" hidden>
                No price drop matches these filters.
              </p>
            </div>
          </section>

          <section id="coupons" className="section deals-section" aria-labelledby="codes-title" data-deal-section="">
            <div className="wrap">
              <SectionHeader id="codes-title" label={`${codes.length} verified in the last ${windowDays} days`} title="Latest verified coupons">
                Codes published by the brand on its own site, verified there within the last {windowDays} days, started and not expired. The offer, terms and expiry are quoted exactly as the brand states them, and left out when it states none.
              </SectionHeader>
              {codes.length ? <PromoCodeGrid codes={codes} /> : <p className="deals-empty">No coupon was verified on a brand’s own site in the last {windowDays} days. Older codes are not listed.</p>}
              <p className="deals-empty" data-deal-empty="" hidden>
                No coupon matches these filters.
              </p>
            </div>
          </section>
        </>
      )}

      {(!noDeals || prices.length > 0) && (
        <section id="recent" className="section tight deals-section" aria-labelledby="prices-title" data-deal-section="">
          <div className="wrap">
            <SectionHeader id="prices-title" label={`${prices.length} current`} title="Recently verified">
              Current prices checked within 48 hours on the brand’s site or a confirmed retailer, where the page states no previous price. These are prices, not discounts.
            </SectionHeader>
            {prices.length ? <CurrentPriceGrid prices={prices} /> : <p className="deals-empty">No other recently checked price right now.</p>}
            <p className="deals-empty" data-deal-empty="" hidden>
              No current price matches these filters.
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
