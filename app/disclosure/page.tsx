import type { Metadata } from "next";

export const metadata: Metadata = { title: "Affiliate disclosure", alternates: { canonical: "/disclosure" } };

export default function Disclosure() {
  return (
    <main className="section">
      <div className="container" style={{ maxWidth: 800 }}>
        <h1>Affiliate disclosure</h1>
        <p>Some links on Made4Buyers are affiliate links. If you buy through one, we may earn a commission at no extra cost to you. Offer links are marked with “View deal”.</p>
        <p>Affiliate relationships do not affect which products are reviewed or how reviews are categorised. Prices and availability are provided by retailers and can change after we check them; always confirm the final price at the retailer.</p>
        <h2>Sponsored placements</h2>
        <p>Paid placements are always labelled “Sponsored” and include the advertiser’s name.</p>
      </div>
    </main>
  );
}
