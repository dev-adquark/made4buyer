import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Anybody, IBM_Plex_Mono, Newsreader, Schibsted_Grotesk } from "next/font/google";
import ExternalAnalytics from "@/components/external-analytics";
import PageViewTracker from "@/components/page-view-tracker";
import RevealProvider from "@/components/reveal-provider";
import SiteFooter from "@/components/site-footer";
import SiteHeader from "@/components/site-header";
import EditorialCursor from "@/components/editorial-cursor";
import SovrnCommerce from "@/components/sovrn-commerce";
import { config } from "@/lib/config";
import { CATEGORIES } from "@/lib/taxonomy/definitions";

const display = Anybody({ subsets: ["latin"], variable: "--font-anybody", display: "swap", axes: ["wdth"] });
const reading = Newsreader({ subsets: ["latin"], variable: "--font-newsreader", display: "swap", style: ["normal", "italic"] });
const ui = Schibsted_Grotesk({ subsets: ["latin"], variable: "--font-schibsted", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], variable: "--font-plex-mono", display: "swap", weight: ["400", "500"] });

export const metadata: Metadata = {
  metadataBase: new URL(config.siteUrl()),
  title: { default: "Made4Buyers — Buy less. Buy right.", template: "%s | Made4Buyers" },
  description: "A universal buying guide: reviews filed by what you need, comparisons built from facts, and offers checked before they are shown.",
  openGraph: { siteName: "Made4Buyers", type: "website" },
  twitter: { card: "summary_large_image" },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#eeebe3" };

// Static taxonomy: the shell never needs the database, so static pages stay static.
const categories = CATEGORIES.map((c) => ({ slug: c.slug, name: c.name, blurb: c.description.replace(/\.$/, ""), subs: c.subcategories.map((s) => ({ slug: s.slug, name: s.name })) }));

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${reading.variable} ${ui.variable} ${mono.variable}`}>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <SiteHeader categories={categories} />
        <PageViewTracker />
        <RevealProvider />
        <ExternalAnalytics />
        <EditorialCursor />
        <SovrnCommerce siteKey={config.sovrn.commerceScript() ? (config.sovrn.siteKey() ?? null) : null} />
        <div id="main">{children}</div>
        <SiteFooter categories={categories} />
      </body>
    </html>
  );
}
