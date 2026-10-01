"use client";

import { usePathname } from "next/navigation";
import Script from "next/script";

/**
 * Sovrn Commerce (VigLink) script, only when SOVRN_COMMERCE_SCRIPT=true. Sovrn's Network Quality
 * review needs it installed. It uses the PUBLIC site key (the one in Sovrn's snippet); the secret
 * API key never leaves the server. It is not loaded in admin. Our own offer links are internal
 * /go/ redirects that pass link verification first; the script only rewrites links to external
 * merchant sites, which never bypass that rule because we don't link to unverified merchants.
 */
export default function SovrnCommerce({ siteKey }: { siteKey: string | null }) {
  const path = usePathname();
  if (!siteKey || path.startsWith("/admin")) return null;
  return (
    <>
      <Script id="sovrn-commerce-config" strategy="lazyOnload">{`window.vglnk = { key: ${JSON.stringify(siteKey)} };`}</Script>
      <Script id="sovrn-commerce" src="https://cdn.viglink.com/api/vglnk.js" strategy="lazyOnload" />
    </>
  );
}
