import Script from "next/script";

/**
 * Optional external analytics. Loads only when both NEXT_PUBLIC_ANALYTICS_ID and
 * NEXT_PUBLIC_ANALYTICS_SCRIPT_URL are set (the script origin must also be allowed via
 * NEXT_PUBLIC_ANALYTICS_HOST for the CSP). First-party analytics never depends on it.
 */
export default function ExternalAnalytics() {
  const id = process.env.NEXT_PUBLIC_ANALYTICS_ID;
  const src = process.env.NEXT_PUBLIC_ANALYTICS_SCRIPT_URL;
  if (!id || !src || !/^https:\/\//.test(src)) return null;
  return <Script src={src} strategy="afterInteractive" data-domain={id} data-site-id={id} />;
}
