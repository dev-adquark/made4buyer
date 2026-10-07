import type { NextConfig } from "next";
import { IMAGES_CONFIG } from "./lib/images/remote-patterns";

const isProd = process.env.NODE_ENV === "production";
const analyticsHost = process.env.NEXT_PUBLIC_ANALYTICS_HOST; // optional external analytics origin

// Next.js injects inline bootstrap scripts, so script-src needs 'unsafe-inline' without nonces;
// everything else is locked to self. Images may be remote (licensed merchant/CDN images).
// No third-party commerce/affiliate script is loaded anywhere, so public and admin pages share one CSP.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}${analyticsHost ? ` ${analyticsHost}` : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:",
  "font-src 'self' data:",
  `connect-src 'self'${analyticsHost ? ` ${analyticsHost}` : ""}`,
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
  // Editorial images (Commons, Pexels) are resized and re-encoded (AVIF/WebP) by the Next.js optimizer:
  // right-sized for each screen and served from our origin (no third-party cookies).
  images: IMAGES_CONFIG,
  env: { IMAGE_OPTIMIZER: "on" },
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ["@prisma/client", "embedded-postgres"],
  experimental: {
    // The stylesheet (~18 KB gzipped) is inlined into the HTML: the first paint no longer waits for a
    // separate render-blocking CSS request, so the hero text paints from the document alone.
    inlineCss: true,
  },
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
