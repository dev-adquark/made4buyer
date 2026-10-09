import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy policy", description: "What Made4Buyers collects, why, how long it is kept and which third parties are involved.", alternates: { canonical: "/privacy" } };

export default function Privacy() {
  return (
    <main className="section doc-page">
      <div className="narrow prose">
        <h1>Privacy policy</h1>
        <p>We measure how the site is used with first-party analytics: page views, offer impressions, offer clicks, searches and comparisons. Events are tied to a random identifier stored in a first-party cookie (<code>m4b_sid</code>); we do not collect names, email addresses or payment details from visitors.</p>
        <p>When you follow an offer link you leave Made4Buyers, and the retailer’s privacy policy applies.</p>
        <p>Operators deploying this platform must configure retention, consent and data-subject request handling appropriate to their jurisdiction.</p>
      </div>
    </main>
  );
}
