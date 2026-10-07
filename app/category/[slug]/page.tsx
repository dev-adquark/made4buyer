import type { Metadata } from "next";
import { DEFAULT_CATEGORY_STATE } from "@/lib/public/listing-routes";
import { CategoryView, categoryMetadata } from "./category-view";

/**
 * Category landing page, unfiltered: static and cached (ISR, 5 minutes, purged on publish and on
 * price changes). It never reads the query string; filtered URLs are rewritten by proxy.ts to
 * v/[state] (cached per filter state) or q (in-category search, per request).
 */
export const revalidate = 300;

export function generateStaticParams(): Array<{ slug: string }> {
  // Rendered on first request, then cached (like review, brand and product pages).
  return [];
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return categoryMetadata(slug, DEFAULT_CATEGORY_STATE);
}

export default async function CategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <CategoryView slug={slug} state={DEFAULT_CATEGORY_STATE} />;
}
