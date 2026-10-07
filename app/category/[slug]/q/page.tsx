import type { Metadata } from "next";
import { parseCategoryQuery } from "@/lib/public/listing-routes";
import { CategoryView, categoryMetadata } from "../category-view";

/**
 * Search within a category (`/category/<slug>?q=…`, rewritten here by proxy.ts): free text is not
 * cached as a page, so this renders per request from the original query string, as before.
 */
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { slug } = await params;
  return categoryMetadata(slug, parseCategoryQuery(await searchParams));
}

export default async function CategorySearchPage({ params, searchParams }: Props) {
  const { slug } = await params;
  return <CategoryView slug={slug} state={parseCategoryQuery(await searchParams)} />;
}
