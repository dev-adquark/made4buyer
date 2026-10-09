import { NextResponse, type NextRequest } from "next/server";
import { resolveListingRoute } from "@/lib/public/listing-routes";
import { CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";

/**
 * Listing pages stay cacheable without changing their URLs (see lib/public/listing-routes.ts):
 * a request that carries a filter is rewritten to an internal route; the browser keeps the public
 * URL. The matcher only runs this for requests that carry one of the filter keys (and for direct
 * requests to the internal routes, which get a 404), so default listing views and every other page
 * are served straight from the cache without invoking the proxy.
 */
export function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  const route = resolveListingRoute(pathname, searchParams, (slug) => CATEGORY_BY_SLUG.has(slug));
  if (route.kind === "static") return NextResponse.next();
  const url = request.nextUrl.clone();
  // A path the app does not have: the regular not-found page with a 404 status.
  url.pathname = route.kind === "blocked" ? "/__not-found" : route.pathname;
  return NextResponse.rewrite(url);
}

// Literal values only: the matcher is read at build time.
export const config = {
  matcher: [
    // Category filters, in-category search and paging.
    { source: "/category/:slug", has: [{ type: "query", key: "sub" }] },
    { source: "/category/:slug", has: [{ type: "query", key: "brand" }] },
    { source: "/category/:slug", has: [{ type: "query", key: "intent" }] },
    { source: "/category/:slug", has: [{ type: "query", key: "platform" }] },
    { source: "/category/:slug", has: [{ type: "query", key: "tier" }] },
    { source: "/category/:slug", has: [{ type: "query", key: "q" }] },
    { source: "/category/:slug", has: [{ type: "query", key: "type" }] },
    { source: "/category/:slug", has: [{ type: "query", key: "page" }] },
    { source: "/reviews", has: [{ type: "query", key: "type" }] },
    { source: "/reviews", has: [{ type: "query", key: "page" }] },
    { source: "/guides", has: [{ type: "query", key: "page" }] },
    { source: "/coupons", has: [{ type: "query", key: "page" }] },
    { source: "/match", has: [{ type: "query", key: "category" }] },
    { source: "/match", has: [{ type: "query", key: "intent" }] },
    { source: "/match", has: [{ type: "query", key: "platform" }] },
    { source: "/match", has: [{ type: "query", key: "tier" }] },
    { source: "/compare", has: [{ type: "query", key: "ids" }] },
    { source: "/search", has: [{ type: "query", key: "q" }] },
    // Internal routes (only reachable through the rewrite above).
    "/category/:slug/v/:path*",
    "/category/:slug/q",
    "/reviews/v/:path*",
    "/guides/v/:path*",
    "/coupons/v/:path*",
    "/match/v/:path*",
    "/compare/q",
    "/search/q",
  ],
};
