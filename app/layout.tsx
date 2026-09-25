import "./globals.css";
import type { Metadata, Viewport } from "next";
import Link from "next/link";
import ExternalAnalytics from "@/components/external-analytics";
import PageViewTracker from "@/components/page-view-tracker";
import { config } from "@/lib/config";
import { CATEGORIES } from "@/lib/taxonomy/definitions";

const NAV = ["laptops", "phones", "ai-tools", "developer-software", "accessories"].map((slug) => CATEGORIES.find((c) => c.slug === slug)!);

export const metadata: Metadata = {
  metadataBase: new URL(config.siteUrl()),
  title: { default: "Made4Buyers — Tech reviews with verified deals", template: "%s | Made4Buyers" },
  description: "Buyer-focused technology reviews, comparisons and offers that are checked before they are shown.",
  openGraph: { siteName: "Made4Buyers", type: "website" },
  twitter: { card: "summary_large_image" },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#ffffff" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header className="site-header">
          <div className="container header-inner">
            <Link className="logo" href="/">
              Made4<span>Buyers</span>
            </Link>
            <nav className="main-nav" aria-label="Categories">
              {NAV.map((c) => (
                <Link key={c.slug} href={`/category/${c.slug}`}>
                  {c.name}
                </Link>
              ))}
              <Link href="/compare">Compare</Link>
            </nav>
            <form className="header-search" action="/search" role="search">
              <label htmlFor="site-search" className="visually-hidden">
                Search reviews
              </label>
              <input id="site-search" name="q" type="search" placeholder="Search reviews…" maxLength={100} />
              <button className="btn" type="submit">
                Search
              </button>
            </form>
          </div>
        </header>
        <PageViewTracker />
        <ExternalAnalytics />
        <div id="main">{children}</div>
        <footer className="site-footer">
          <div className="container">
            <div>© {new Date().getFullYear()} Made4Buyers. Independent technology research.</div>
            <nav aria-label="Footer">
              <Link href="/about">About &amp; methodology</Link>
              <Link href="/disclosure">Affiliate disclosure</Link>
              <Link href="/privacy">Privacy</Link>
              <Link href="/search">Search</Link>
              <Link href="/admin">Admin</Link>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
