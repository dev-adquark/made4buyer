import type { Metadata } from "next";
import { DEFAULT_GUIDES_STATE } from "@/lib/public/listing-routes";
import { prerenderNeedsDatabase } from "@/lib/public/isr";
import { GuidesView, guidesMetadata } from "./guides-view";

/** Buying guides, page 1: static and cached (ISR, 5 minutes, purged on publish). `?page=` is rewritten by proxy.ts to v/[state]. */
export const revalidate = 300;

export async function generateMetadata(): Promise<Metadata> {
  await prerenderNeedsDatabase();
  return guidesMetadata(DEFAULT_GUIDES_STATE);
}

export default async function GuidesIndex() {
  await prerenderNeedsDatabase();
  return <GuidesView state={DEFAULT_GUIDES_STATE} />;
}
