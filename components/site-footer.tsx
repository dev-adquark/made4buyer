import Link from "next/link";
import { Wordmark } from "./brand-mark";
import type { NavCategory } from "./site-nav";
import { visibleNavCategories } from "@/lib/public/nav-categories";

/** `taxonomy` is the full category list; only categories with published content are linked. */
export default async function SiteFooter({ categories: taxonomy }: { categories: NavCategory[] }) {
  const categories = await visibleNavCategories(taxonomy);
  return (
    <footer className="site-footer on-dark">
      <div className="wrap colophon-statement">
        <p className="label muted" style={{ marginBottom: 18 }}>
          Made4Buyers, the buyer’s tear-sheet
        </p>
        <p className="big">
          Make better <span>buying</span> decisions.
        </p>
      </div>
      <div className="wrap footer-grid">
        <div>
          <Link className="brand" href="/">
            <Wordmark />
          </Link>
          <p style={{ marginTop: 14, maxWidth: "40ch" }}>Reviews sorted by what you need, comparisons built only from facts we hold, and offers we check before we show them.</p>
          <p className="footer-disclosure">
            <strong>Affiliate disclosure.</strong> Some offer links earn us a commission if you buy. It never decides which offer we show, and every offer link is checked first.{" "}
            <Link href="/disclosure">Read the disclosure</Link>
          </p>
        </div>
        <nav aria-labelledby="f-explore">
          <h2 id="f-explore">Explore</h2>
          <ul>
            <li><Link href="/reviews">Reviews</Link></li>
            <li><Link href="/deals">Deals</Link></li>
            <li><Link href="/compare">Compare</Link></li>
            <li><Link href="/guides">Guides</Link></li>
            <li><Link href="/match">Find my match</Link></li>
            <li><Link href="/search">Search</Link></li>
          </ul>
        </nav>
        {categories.length > 0 && (
        <nav aria-labelledby="f-cats">
          <h2 id="f-cats">Categories</h2>
          <ul>
            {/* One entry point per department keeps the footer short as categories grow. */}
            {categories.filter((c, i, all) => all.findIndex((x) => x.department === c.department) === i).map((c) => (
              <li key={c.slug}>
                <Link href={`/category/${c.slug}`}>{c.name}</Link>
              </li>
            ))}
          </ul>
        </nav>
        )}
        <nav aria-labelledby="f-company">
          <h2 id="f-company">Company</h2>
          <ul>
            <li><Link href="/about">About &amp; method</Link></li>
            <li><Link href="/contact">Contact</Link></li>
            <li><Link href="/privacy">Privacy</Link></li>
            <li><Link href="/terms">Terms</Link></li>
            <li><Link href="/disclosure">Affiliate disclosure</Link></li>
          </ul>
        </nav>
      </div>
      <div className="wrap footer-bottom">
        <span>© {new Date().getFullYear()} Made4Buyers</span>
        <span>No invented reviews, prices or ratings</span>
      </div>
    </footer>
  );
}
