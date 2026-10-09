import Script from "next/script";

/** A GA4 measurement id (G-XXXXXXX); anything else is ignored. */
export function gaMeasurementId(): string | null {
  const id = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID?.trim();
  return id && /^G-[A-Z0-9]{4,20}$/.test(id) ? id : null;
}

/**
 * Google Analytics 4 (gtag.js), only when NEXT_PUBLIC_GA_MEASUREMENT_ID is set. Loaded after the page
 * is interactive, so it never delays the first paint; IP anonymisation is GA4's default.
 */
export default function GoogleAnalytics() {
  const id = gaMeasurementId();
  if (!id) return null;
  return (
    <>
      <Script id="ga4-src" src={`https://www.googletagmanager.com/gtag/js?id=${id}`} strategy="afterInteractive" />
      <Script id="ga4-init" strategy="afterInteractive">
        {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${id}');`}
      </Script>
    </>
  );
}
