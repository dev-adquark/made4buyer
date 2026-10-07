import type { Metadata } from "next";
import { rawParam, searchQueryText } from "@/lib/public/listing-routes";
import { SearchView, searchMetadata, searchType } from "../search-view";

/** Search results (`/search?q=…&type=…`, rewritten here by proxy.ts): rendered per request. */
export const dynamic = "force-dynamic";
export const metadata: Metadata = searchMetadata;

export default async function SearchResultsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  return <SearchView q={searchQueryText(sp)} type={searchType(rawParam(sp, "type"))} />;
}
