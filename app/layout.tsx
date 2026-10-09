import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Anybody, IBM_Plex_Mono, Newsreader, Schibsted_Grotesk } from "next/font/google";
import ExternalAnalytics from "@/components/external-analytics";
import GoogleAnalytics from "@/components/google-analytics";
import PageViewTracker from "@/components/page-view-tracker";
import RevealProvider from "@/components/reveal-provider";
import SiteFooter from "@/components/site-footer";
import SiteHeader from "@/components/site-header";
import EditorialCursor from "@/components/editorial-cursor";
import { CategoryNamesProvider } from "@/components/category-names";
import JsonLd from "@/components/json-ld";
import { config } from "@/lib/config";
import { gscVerificationMetadata } from "@/lib/gsc";
import { CATEGORIES, DEPARTMENTS } from "@/lib/taxonomy/definitions";

// Every face uses a hand-measured local fallback (app/globals.css, "M4B … Fallback", Arial/Times
// on desktop and iOS, Roboto/Noto Serif on Android) instead of next/font's automatic Arial/Times
// one, which assumes the default width and weight: with the condensed Anybody, bold Schibsted and
// Plex Mono that reflowed the page on swap (review page CLS 0.28).
const display = Anybody({ subsets: ["latin"], variable: "--font-anybody", display: "swap", preload: false, axes: ["wdth"], adjustFontFallback: false, fallback: ["M4B Display Fallback", "M4B Display Fallback Roboto", "Arial", "sans-serif"] });
// No face is preloaded: with display "swap" every text paints at once in its measured fallback, and
// each preload (the display face alone is 57 KB) competes with the document, CSS and scripts on the
// critical path, which Lighthouse counts into the LCP (3.4 s → 3.2 s without it). The measured
// fallbacks keep the swap shift-free.
const reading = Newsreader({ subsets: ["latin"], variable: "--font-newsreader", display: "swap", style: ["normal", "italic"], preload: false, adjustFontFallback: false, fallback: ["M4B Read Fallback", "M4B Read Fallback Noto", "Georgia", "serif"] });
const ui = Schibsted_Grotesk({ subsets: ["latin"], variable: "--font-schibsted", display: "swap", preload: false, adjustFontFallback: false, fallback: ["M4B UI Fallback", "M4B UI Fallback Roboto", "Arial", "sans-serif"] });
const mono = IBM_Plex_Mono({ subsets: ["latin"], variable: "--font-plex-mono", display: "swap", weight: ["400", "500"], preload: false, adjustFontFallback: false, fallback: ["M4B Mono Fallback", "ui-monospace", "monospace"] });

export const metadata: Metadata = {
  metadataBase: new URL(config.siteUrl()),
  title: { default: "Made4Buyers — Buy less. Buy right.", template: "%s | Made4Buyers" },
  description: "A universal buying guide: reviews filed by what you need, comparisons built from facts, and offers checked before they are shown.",
  openGraph: { siteName: "Made4Buyers", type: "website" },
  twitter: { card: "summary_large_image" },
  ...gscVerificationMetadata(),
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#eeebe3" };

// Static taxonomy: the shell never needs the database, so static pages stay static.
// Legacy (superseded) subcategories keep working URLs but are not shown in navigation.
const categories = CATEGORIES.map((c, i) => ({
  slug: c.slug,
  name: c.name,
  blurb: c.description.replace(/\.$/, ""),
  issue: i + 1,
  department: c.department,
  departmentName: DEPARTMENTS.find((d) => d.slug === c.department)?.name ?? "",
  subs: c.subcategories.filter((s) => !s.legacy).map((s) => ({ slug: s.slug, name: s.name })),
}));

// Slug → name for client search UIs (keeps lib/taxonomy/definitions out of the client bundle).
const categoryNames: Record<string, string> = Object.fromEntries(CATEGORIES.map((c) => [c.slug, c.name]));

/**
 * Site-wide schema.org in <head> (crawlers and SEO checkers read it there): the WebSite with its
 * search action, and the Organization that publishes it. Page-specific JSON-LD stays on its page.
 */
function siteJsonLd() {
  const site = config.siteUrl();
  return {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Organization", "@id": `${site}/#organization`, name: "Made4Buyers", url: site, logo: `${site}/icon.svg` },
      { "@type": "WebSite", "@id": `${site}/#website`, name: "Made4Buyers", url: site, publisher: { "@id": `${site}/#organization` }, inLanguage: "en", potentialAction: { "@type": "SearchAction", target: `${site}/search?q={search_term_string}`, "query-input": "required name=search_term_string" } },
    ],
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${reading.variable} ${ui.variable} ${mono.variable}`}>
      <head>
        <JsonLd data={siteJsonLd()} />
      </head>
      <body>
        <CategoryNamesProvider names={categoryNames}>
          <a className="skip-link" href="#main">
            Skip to content
          </a>
          <SiteHeader categories={categories} />
          <PageViewTracker />
          <RevealProvider />
          <ExternalAnalytics />
          <GoogleAnalytics />
          <EditorialCursor />
          <div id="main">{children}</div>
          <SiteFooter categories={categories} />
        </CategoryNamesProvider>
      </body>
    </html>
  );
}
