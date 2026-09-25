import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Figtree } from "next/font/google";
import ExternalAnalytics from "@/components/external-analytics";
import PageViewTracker from "@/components/page-view-tracker";
import RevealProvider from "@/components/reveal-provider";
import SiteFooter from "@/components/site-footer";
import SiteHeader from "@/components/site-header";
import { config } from "@/lib/config";
import { CATEGORIES } from "@/lib/taxonomy/definitions";

const display = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-bricolage", display: "swap", weight: ["600", "700", "800"] });
const body = Figtree({ subsets: ["latin"], variable: "--font-figtree", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(config.siteUrl()),
  title: { default: "Made4Buyers — Tech reviews with verified deals", template: "%s | Made4Buyers" },
  description: "Buyer-focused technology reviews, comparisons and offers that are checked before they are shown.",
  openGraph: { siteName: "Made4Buyers", type: "website" },
  twitter: { card: "summary_large_image" },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0d1142" };

// Static taxonomy: the shell never needs the database, so static pages stay static.
const categories = CATEGORIES.map((c) => ({ slug: c.slug, name: c.name, blurb: c.description.replace(/\.$/, "") }));

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <SiteHeader categories={categories} />
        <PageViewTracker />
        <RevealProvider />
        <ExternalAnalytics />
        <div id="main">{children}</div>
        <SiteFooter categories={categories} />
      </body>
    </html>
  );
}
