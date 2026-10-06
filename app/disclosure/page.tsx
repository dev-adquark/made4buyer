import type { Metadata } from "next";

export const metadata: Metadata = { title: "Affiliate disclosure", description: "How Made4Buyers earns money from affiliate links, and why that never changes which products we cover or how.", alternates: { canonical: "/disclosure" } };

export default function Disclosure() {
  return (
    <main className="section doc-page">
      <div className="narrow prose">
        <h1>Affiliate disclosure</h1>
        <p>Some links on Made4Buyers are affiliate links. If you buy through one, we may earn a commission at no extra cost to you.</p>
        <h2>Sovrn Commerce</h2>
        <p>Made4Buyers works with Sovrn Commerce, an affiliate network. Sovrn’s script runs on our public pages and may automatically turn ordinary links to retailers and brands (for example the “Where to buy” links on a review) into affiliate links. If you then buy something, we may earn a commission; the price you pay is the same. Sovrn’s script is never loaded on our admin pages.</p>
        <h2>How offers and links are labelled</h2>
        <p>A “Verified offer” (with a “View deal” button) is shown only after we have checked that its link reaches the retailer. Where there is no verified offer, a review may list “Where to buy” links to the maker’s own site or a retailer, taken from the product pages we used as sources. Those links never show a price and are not deals.</p>
        <p>Affiliate relationships do not affect which products are reviewed, how reviews are categorised or ranked, or which offer is shown. Prices and availability are provided by retailers and can change after we check them; always confirm the final price at the retailer.</p>
        <h2>Sponsored placements</h2>
        <p>Paid placements are always labelled “Sponsored” and include the advertiser’s name.</p>
      </div>
    </main>
  );
}
