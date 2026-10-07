import type { Metadata } from "next";
import { prerenderNeedsDatabase } from "@/lib/public/isr";
import { SearchView, searchMetadata } from "./search-view";

/**
 * Search, before a query: static and cached (ISR). `?q=` is rewritten by proxy.ts to q/page.tsx
 * (per request; its content lookups are cached per query in ./data.ts). Search pages are noindex.
 */
export const revalidate = 300;
export const metadata: Metadata = searchMetadata;

export default async function SearchPage() {
  await prerenderNeedsDatabase();
  return <SearchView q="" type={null} />;
}
