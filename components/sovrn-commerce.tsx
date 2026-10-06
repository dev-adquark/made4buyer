"use client";

import { usePathname } from "next/navigation";

/**
 * Sovrn Commerce (VigLink) script, only when SOVRN_COMMERCE_SCRIPT=true. Sovrn's Network Quality
 * review needs it installed. It uses the PUBLIC site key (the one in Sovrn's snippet); the secret
 * API key never leaves the server. It is never loaded in admin (here, and the admin CSP in
 * next.config.ts blocks its hosts). "Verified offer" links are internal /go/ redirects that pass
 * link verification first; the script only handles direct links to external merchant sites, such
 * as the labelled "Where to buy" links (lib/public/retailer-links.ts), which never show a price.
 */
export default function SovrnCommerce({ siteKey }: { siteKey: string | null }) {
  const path = usePathname();
  if (!siteKey || path.startsWith("/admin")) return null;
  return (
    <>
      {/* Plain server-rendered tags (Sovrn's own snippet shape) so the install is visible in the page HTML
          to Sovrn's checker; `async` keeps it off the critical path. */}
      <script id="sovrn-commerce-config" dangerouslySetInnerHTML={{ __html: `window.vglnk = { key: ${JSON.stringify(siteKey)} };` }} />
      <script id="sovrn-commerce" src="https://cdn.viglink.com/api/vglnk.js" async />
    </>
  );
}
