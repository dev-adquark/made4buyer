import Link from "next/link";
import type { NavCategory } from "./site-nav";

export default function SiteFooter({ categories }: { categories: NavCategory[] }) {
  return (
    <footer className="site-footer">
      <div className="container footer-grid">
        <div>
          <Link className="logo" href="/">
            <span className="logo-mark" aria-hidden="true" />
            Made4Buyers
          </Link>
          <p className="small">Technology reviews sorted by what you need, with offers we check before we show them.</p>
        </div>
        <nav aria-labelledby="f-explore">
          <h2 id="f-explore">Explore</h2>
          <ul>
            <li><Link href="/reviews">All reviews</Link></li>
            <li><Link href="/deals">Verified deals</Link></li>
            <li><Link href="/compare">Compare products</Link></li>
            <li><Link href="/search">Search</Link></li>
          </ul>
        </nav>
        <nav aria-labelledby="f-cats">
          <h2 id="f-cats">Categories</h2>
          <ul>
            {categories.slice(0, 6).map((c) => (
              <li key={c.slug}>
                <Link href={`/category/${c.slug}`}>{c.name}</Link>
              </li>
            ))}
          </ul>
        </nav>
        <nav aria-labelledby="f-about">
          <h2 id="f-about">Made4Buyers</h2>
          <ul>
            <li><Link href="/about">About &amp; methodology</Link></li>
            <li><Link href="/disclosure">Affiliate disclosure</Link></li>
            <li><Link href="/privacy">Privacy</Link></li>
            <li><Link href="/terms">Terms</Link></li>
            <li><Link href="/contact">Contact</Link></li>
          </ul>
        </nav>
      </div>
      <div className="container footer-bottom">© {new Date().getFullYear()} Made4Buyers. Offer links may earn us a commission; see the affiliate disclosure.</div>
    </footer>
  );
}
