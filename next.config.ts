import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";
const analyticsHost = process.env.NEXT_PUBLIC_ANALYTICS_HOST; // optional external analytics origin
// Sovrn Commerce (VigLink) script, only when explicitly enabled (needed for Sovrn site approval).
const sovrnCommerce = ["1", "true", "yes", "on"].includes((process.env.SOVRN_COMMERCE_SCRIPT ?? "").toLowerCase());
// Sovrn Commerce link rewriting: vglnk.js loads Sovrn's commerce-js runtime, which calls *.sovrn.co.
// Sovrn's browser-side price-comparison widget (comparisons.sovrn.com/js) stays blocked: offers are
// shown only from the server-side verified-offer pipeline.
const extraScript = [analyticsHost, sovrnCommerce && "https://cdn.viglink.com https://commerce-js.sovrn.co"].filter(Boolean).join(" ");
const extraConnect = [analyticsHost, sovrnCommerce && "https://*.viglink.com https://*.sovrn.co"].filter(Boolean).join(" ");

// Next.js injects inline bootstrap scripts, so script-src needs 'unsafe-inline' without nonces;
// everything else is locked to self. Images may be remote (licensed merchant/CDN images).
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}${extraScript ? ` ${extraScript}` : ""}`,
  `style-src 'self' 'unsafe-inline'${sovrnCommerce ? " https://commerce-js.sovrn.co" : ""}`,
  "img-src 'self' https: data:",
  "font-src 'self' data:",
  `connect-src 'self'${extraConnect ? ` ${extraConnect}` : ""}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  ...(isProd ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }] : []),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ["@prisma/client", "embedded-postgres"],
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/admin/:path*", headers: [{ key: "Cache-Control", value: "no-store" }, { key: "X-Robots-Tag", value: "noindex, nofollow" }] },
      { source: "/api/admin/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
  async redirects() {
    // Legacy review URLs → canonical /review/{slug}.
    return [{ source: "/reviews/:slug", destination: "/review/:slug", permanent: true }];
  },
};

export default nextConfig;
