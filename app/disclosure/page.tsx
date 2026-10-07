import type { Metadata } from "next";
import { activeProviderNames, affiliateProviderActive } from "@/lib/affiliate/provider";

export const metadata: Metadata = { title: "Affiliate disclosure", description: "How Made4Buyers links to retailers, whether we earn anything from those links, and why that never changes which products we cover or how.", alternates: { canonical: "/disclosure" } };

export default function Disclosure() {
  const affiliated = affiliateProviderActive();
  // Amazon's Associates Program requires this exact statement wherever Amazon links are used.
  const amazon = activeProviderNames().includes("amazon");
  return (
    <main className="section doc-page">
      <div className="narrow prose">
        <h1>Affiliate disclosure</h1>
        {affiliated ? (
          <p>Some links to retailers on Made4Buyers are affiliate links. If you buy through one, we may earn a commission at no extra cost to you. Affiliate links are marked as sponsored links in the page code; every other retailer link is a plain link.</p>
        ) : (
          <p>Links to retailers and brands on Made4Buyers are plain links to the retailer’s or maker’s own page. We do not currently use an affiliate program, so we currently earn nothing from retailer links or from purchases you make after following one.</p>
        )}
        {amazon && <p>As an Amazon Associate, Made4Buyers earns from qualifying purchases.</p>}
        <h2>Where prices and links come from</h2>
        <p>Prices, availability and seller links come from our own commerce data: we read the maker’s official product pages and retailer product pages and record what they state, and when. A price is shown only while that observation is recent; otherwise a review says “We couldn’t verify a current price from an authoritative source.” rather than showing an old price. “Where to buy” links point to the maker’s own site or a retailer, taken from the product pages we used as sources; they never show a price on their own.</p>
        <p>How we link to retailers does not affect which products are reviewed, how reviews are categorised or ranked, or which seller is listed. Prices and availability can change after we check them; always confirm the final price at the retailer.</p>
        <h2>Sponsored placements</h2>
        <p>Paid placements are always labelled “Sponsored” and include the advertiser’s name.</p>
      </div>
    </main>
  );
}
