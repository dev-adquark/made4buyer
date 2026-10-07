import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { decodeCategoryState } from "@/lib/public/listing-routes";
import { CategoryView, categoryMetadata } from "../../category-view";

/**
 * A filtered, typed or paged category listing (no free text), cached per normalized filter state
 * (ISR, 5 minutes, purged on publish and on price changes). Reached only through proxy.ts, which
 * rewrites /category/<slug>?brand=…&page=… here; the browser keeps the public URL.
 */
export const revalidate = 300;

export function generateStaticParams(): Array<{ state: string }> {
  return [];
}

type Params = Promise<{ slug: string; state: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug, state } = await params;
  const s = decodeCategoryState(state);
  if (!s) return { title: "Category not found", robots: { index: false } };
  return categoryMetadata(slug, s);
}

export default async function CategoryStatePage({ params }: { params: Params }) {
  const { slug, state } = await params;
  const s = decodeCategoryState(state);
  if (!s) notFound();
  return <CategoryView slug={slug} state={s} />;
}
