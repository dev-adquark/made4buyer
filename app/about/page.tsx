import type { Metadata } from "next";

export const metadata: Metadata = { title: "About & methodology", alternates: { canonical: "/about" } };

export default function About() {
  return (
    <main className="section">
      <div className="container" style={{ maxWidth: 800 }}>
        <h1>About Made4Buyers</h1>
        <p className="lede">Made4Buyers organises technology reviews around what buyers need, and shows offers only after they have been verified.</p>
        <h2>How reviews are processed</h2>
        <p>Reviews arrive from our content partners. Each one is checked for completeness, de-duplicated, and classified by category, use case, platform and price tier. When the automatic classification is uncertain, an editor reviews it before publication.</p>
        <h2>How offers are verified</h2>
        <p>Offers come from our affiliate partner. Before an offer is shown, its link is followed to confirm it reaches the expected retailer. Links are re-checked regularly, and an offer that fails a check is hidden until it passes again. If no verified offer exists, the review says so.</p>
        <h2>What we never do</h2>
        <p>We do not invent prices, discounts, availability, ratings or merchants. Images whose licence we cannot confirm are replaced with our own illustrations.</p>
      </div>
    </main>
  );
}
