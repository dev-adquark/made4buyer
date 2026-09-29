import type { Metadata } from "next";

export const metadata: Metadata = { title: "Terms of use", alternates: { canonical: "/terms" } };

export default function Terms() {
  return (
    <main className="section">
      <div className="container" style={{ maxWidth: 800 }}>
        <h1>Terms of use</h1>
        <p className="lede">Plain-language terms for using Made4Buyers.</p>
        <h2>Information on this site</h2>
        <p>Reviews summarise content from our publishing partners. Offers, prices and availability come from retailers through our affiliate partner and can change after we check them. Always confirm the final price and terms with the retailer before buying.</p>
        <h2>Affiliate links</h2>
        <p>Some links are affiliate links. We may earn a commission when you buy through them, at no extra cost to you. See the affiliate disclosure for details.</p>
        <h2>Acceptable use</h2>
        <p>Don’t scrape the site at a rate that degrades it for others, attempt to access the admin area without authorisation, or misrepresent our content as your own.</p>
        <h2>Liability</h2>
        <p>Content is provided for general information. Purchases are made with the retailer, whose terms apply to the sale, delivery, returns and warranty.</p>
      </div>
    </main>
  );
}
