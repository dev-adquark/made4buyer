import type { Metadata } from "next";
import Link from "next/link";
import Breadcrumbs from "@/components/breadcrumbs";
import EmptyState from "@/components/empty-state";
import { PromoCodeGrid } from "@/components/official-deals";
import { couponMaxAgeDays } from "@/lib/commerce/deal-status";
import { officialDeals } from "@/lib/public/deals";
import type { CouponsState } from "@/lib/public/listing-routes";
import { tagListingPage } from "@/lib/public/page-cache";
import "../deals/deals.css";

/*
 * Every current US coupon, newest first, 60 per page. Rendered by page.tsx (page 1) and
 * v/[state]/page.tsx (?page=N, rewritten there by proxy.ts); both cached (ISR). The data is the same
 * cached list /deals and the homepage show (officialDeals(): the public coupon rule, tagged "deals",
 * so a Feedico sync or a coupon crawl refreshes it).
 */

export const COUPONS_PER_PAGE = 60;

export async function couponsMetadata(state: CouponsState): Promise<Metadata> {
  const { codes } = await officialDeals();
  return {
    title: "Coupons",
    description: "Current US promo codes: from the Feedico affiliate feed (listed within the last 14 days) and from brands’ own sites. Expired codes are not listed.",
    alternates: { canonical: "/coupons" },
    robots: codes.length === 0 || state.noindex ? { index: false, follow: true } : undefined,
  };
}

export async function CouponsView({ state }: { state: CouponsState }) {
  await tagListingPage({ commerce: true });
  const { codes } = await officialDeals();
  const pages = Math.max(1, Math.ceil(codes.length / COUPONS_PER_PAGE));
  const page = Math.min(state.page, pages);
  const shown = codes.slice((page - 1) * COUPONS_PER_PAGE, page * COUPONS_PER_PAGE);
  const feed = codes.filter((c) => c.viaFeed).length;
  const official = codes.length - feed;
  const lede = codes.length
    ? [
        `${codes.length} current US coupons, newest first.`,
        feed ? `${feed} come from the Feedico affiliate feed (marked Via Feedico): listed by an affiliate network within the last 14 days, not checked on the merchant’s own site.` : "",
        official ? `${official} ${official === 1 ? "was" : "were"} published on the brand’s own site and verified there within the last ${couponMaxAgeDays()} days (marked Verified).` : "",
        "Expired and not-yet-started codes are not listed.",
      ].filter(Boolean).join(" ")
    : "No current coupon right now. Codes appear here once a brand’s own site or the Feedico affiliate feed lists them.";
  const href = (p: number) => (p > 1 ? `/coupons?page=${p}` : "/coupons");
  return (
    <main className="deals-page">
      <section className="page-hero">
        <div className="wrap">
          <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Coupons", href: "/coupons" }]} />
          <h1>Coupons</h1>
          <p className="lede">{lede}</p>
        </div>
      </section>
      <section className="section deals-section" aria-labelledby="coupons-title">
        <div className="wrap">
          <h2 id="coupons-title" className="visually-hidden">
            {codes.length > COUPONS_PER_PAGE ? `Coupons, page ${page} of ${pages}` : "Coupons"}
          </h2>
          {shown.length ? <PromoCodeGrid codes={shown} headingLevel={3} /> : <EmptyState title="No current coupon right now.">Codes appear here once a brand’s own site or the Feedico affiliate feed lists them.</EmptyState>}
          {pages > 1 && (
            <nav className="pagination" aria-label="Pagination">
              {page > 1 && (
                <Link className="btn" href={href(page - 1)}>
                  Previous page
                </Link>
              )}
              <span className="muted">
                Page {page} of {pages}
              </span>
              {page < pages && (
                <Link className="btn" href={href(page + 1)}>
                  Next page
                </Link>
              )}
            </nav>
          )}
        </div>
      </section>
    </main>
  );
}
