import type { MetadataRoute } from "next";
import { config } from "@/lib/config";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", // /search and /compare stay crawlable so crawlers can read their noindex.
    disallow: ["/admin", "/api/", "/go/"] },
    sitemap: `${config.siteUrl()}/sitemap.xml`,
  };
}
