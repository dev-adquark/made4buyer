import type { Metadata } from "next";
import { parseCompareIds } from "@/lib/public/listing-routes";
import { CompareView, compareMetadata } from "../compare-view";

/** A comparison (`/compare?ids=…`, rewritten here by proxy.ts): rendered per request, prices included. */
export const dynamic = "force-dynamic";
export const metadata: Metadata = compareMetadata;

export default async function CompareSelectedPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <CompareView ids={parseCompareIds(await searchParams)} />;
}
