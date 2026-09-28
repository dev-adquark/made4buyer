import Link from "next/link";
import { BrandMark } from "./brand-mark";
import type { NavCategory } from "./site-nav";

export default function SiteFooter({ categories }: { categories: NavCategory[] }) {
  return (
    <footer className="site-footer on-ink">
      <div className="container footer-grid">
        <div>
          <Link className="brand" href="/">
            <BrandMark />
            Made4Buyers
          </Link>
          <p style={{ marginTop: 14 }}>We help you find the right technology to buy: reviews sorted by what you need, and offers we check before we show them.</p>
        </div>
        <nav aria-labelledby="f-explore">
          <h2 id="f-explore">Explore</h2>
          <ul>
            <li><Link href="/reviews">Reviews</Link></li>
            <li><Link href="/guides">Buying guides</Link></li>
            <li><Link href="/compare">Comparisons</Link></li>
            <li><Link href="/deals">Verified deals</Link></li>
            <li><Link href="/match">Find my match</Link></li>
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
        <nav aria-labelledby="f-trust">
          <h2 id="f-trust">Trust</h2>
          <ul>
            <li><Link href="/about">How we review</Link></li>
            <li><Link href="/disclosure">Affiliate disclosure</Link></li>
            <li><Link href="/search">Search</Link></li>
          </ul>
        </nav>
        <nav aria-labelledby="f-about">
          <h2 id="f-about">Company</h2>
          <ul>
            <li><Link href="/contact">Contact</Link></li>
            <li><Link href="/privacy">Privacy</Link></li>
            <li><Link href="/terms">Terms</Link></li>
          </ul>
        </nav>
      </div>
      <div className="container footer-bottom">
        <span>© {new Date().getFullYear()} Made4Buyers</span>
        <span>Offer links may earn us a commission. It never changes which offers we show.</span>
      </div>
    </footer>
  );
}
