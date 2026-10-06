import type { Metadata } from "next";

export const metadata: Metadata = { title: "About & methodology", description: "How Made4Buyers works: where reviews come from, how they are checked, how offers are verified and what we never do.", alternates: { canonical: "/about" } };

export default function About() {
  return (
    <main className="section doc-page">
      <div className="narrow prose">
        <h1>About Made4Buyers</h1>
        <p className="lede">Made4Buyers is a buying guide: it organises reviews around what buyers need, and shows prices only while they have been checked recently.</p>
        <h2>How reviews are processed</h2>
        <p>Reviews arrive from our content partners. Each one is checked for completeness, de-duplicated, and classified by category, use case, platform and price tier. Only recent source reviews (published or updated within the last 7 days) are published automatically, and every page credits its source.</p>
        <h2>How prices are checked</h2>
        <p>Prices and seller links come from our own commerce data: we read the maker’s official product pages and retailer product pages for the exact product and record what they state, and when. A price is shown only while that observation is recent; otherwise the review says “Price currently unavailable”. Links to sellers are plain links to their own pages.</p>
        <h2>How buying guides are written</h2>
        <p>Buying guides are drafted with an AI writing tool. Scheduled guides and articles are published automatically as generated, twice a day; we only prevent repeated topics and images, and no editor reviews them first unless the page says so. Treat any test results, prices or statistics in them as unverified. They never carry a rating, and they are not hands-on reviews.</p>
        <h2>What we never do</h2>
        <p>We do not invent prices, discounts, availability, ratings or merchants. Images whose licence we cannot confirm are replaced with our own illustrations.</p>
      </div>
    </main>
  );
}
