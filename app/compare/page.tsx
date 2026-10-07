import type { Metadata } from "next";
import { prerenderNeedsDatabase } from "@/lib/public/isr";
import { tagListingPage } from "@/lib/public/page-cache";
import { CompareView, compareMetadata } from "./compare-view";

/**
 * Compare, nothing selected yet (the product picker): static and cached (ISR, 5 minutes, purged on
 * publish). `?ids=` is rewritten by proxy.ts to q (per request: the table shows live prices).
 */
export const revalidate = 300;
export const metadata: Metadata = compareMetadata;

export default async function ComparePage() {
  await prerenderNeedsDatabase();
  await tagListingPage();
  return <CompareView ids={[]} />;
}
