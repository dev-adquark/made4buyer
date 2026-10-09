import type { NextConfig } from "next";
import { IMAGES_CONFIG } from "./lib/images/remote-patterns";

const isProd = process.env.NODE_ENV === "production";
const analyticsHost = process.env.NEXT_PUBLIC_ANALYTICS_HOST; // optional external analytics origin
// Google Analytics 4 (components/google-analytics.tsx): its origins are allowed only when an id is set.
const ga = /^G-[A-Z0-9]{4,20}$/.test(process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID?.trim() ?? "");
const gaScript = ga ? " https://www.googletagmanager.com" : "";
const gaConnect = ga ? " https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com" : "";

// Next.js injects inline bootstrap scripts, so script-src needs 'unsafe-inline' without nonces;
// everything else is locked to self. Images may be remote (licensed merchant/CDN images).
// No third-party commerce/affiliate script is loaded anywhere, so public and admin pages share one CSP.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}${analyticsHost ? ` ${analyticsHost}` : ""}${gaScript}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:",
  "font-src 'self' data:",
  `connect-src 'self'${analyticsHost ? ` ${analyticsHost}` : ""}${gaConnect}`,
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
    // Off: inlining put the ~93 KB stylesheet into every HTML response three times (a <style> block plus
    // two copies in the RSC payload): 563 KB of HTML on the homepage. A cached stylesheet measured faster
    // (mobile Lighthouse LCP 3.6 s → 3.4 s locally; HTML 306 KB → 36 KB).
    inlineCss: false,
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
  async rewrites() {
    // Common legal-page URLs serve the privacy policy and terms directly (200, canonical /privacy and
    // /terms): link checkers and crawlers that do not follow redirects still find them.
    return [
      ...["/privacy-policy", "/privacy-notice", "/legal/privacy", "/policies/privacy", "/policies/privacy-policy"].map((source) => ({ source, destination: "/privacy" })),
      ...["/terms-of-use", "/terms-of-service", "/terms-and-conditions", "/tos", "/legal/terms", "/policies/terms", "/policies/terms-of-service"].map((source) => ({ source, destination: "/terms" })),
    ];
  },
};

export default nextConfig;
