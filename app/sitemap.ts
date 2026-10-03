import type { MetadataRoute } from "next";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { eligibleBrands } from "@/lib/public/queries";

export const dynamic = "force-dynamic";

/** Sitemap: static pages + categories and brands with published reviews + PUBLISHED reviews only. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = config.siteUrl();
  const staticEntries: MetadataRoute.Sitemap = ["/", "/about", "/contact", "/disclosure", "/privacy", "/terms"].map((p) => ({ url: `${base}${p}`, changeFrequency: "weekly" }));
  if (!process.env.DATABASE_URL) return staticEntries;
  try {
    const [reviews, categories, brands, guides] = await Promise.all([
      db.normalizedReview.findMany({ where: { status: "PUBLISHED" }, select: { slug: true, updatedAt: true }, orderBy: { publishedAt: "desc" }, take: 45000 }),
      db.normalizedReview.groupBy({ by: ["categorySlug"], where: { status: "PUBLISHED", categorySlug: { not: null } }, _max: { updatedAt: true } }),
      eligibleBrands(),
      db.normalizedReview.count({ where: { status: "PUBLISHED", kind: "AI_GUIDE" } }),
    ]);
    // Hubs are listed only once they have content (empty hubs are noindex).
    const hubs = [...(reviews.length ? ["/reviews"] : []), ...(guides ? ["/guides"] : [])].map((p) => ({ url: `${base}${p}`, lastModified: reviews[0]?.updatedAt, changeFrequency: "daily" as const }));
    return [
      ...staticEntries,
      ...hubs,
      ...categories.map((c) => ({ url: `${base}/category/${c.categorySlug}`, lastModified: c._max.updatedAt ?? undefined, changeFrequency: "daily" as const })),
      ...brands.map((b) => ({ url: `${base}/brand/${b.slug}`, lastModified: b.updatedAt ?? undefined, changeFrequency: "weekly" as const })),
      ...reviews.map((r) => ({ url: `${base}/review/${r.slug}`, lastModified: r.updatedAt, changeFrequency: "weekly" as const })),
    ];
  } catch {
    return staticEntries;
  }
}
