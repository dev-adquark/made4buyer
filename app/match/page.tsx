import type { Metadata } from "next";
import { prerenderNeedsDatabase } from "@/lib/public/isr";
import { MatchView, matchMetadata } from "./match-view";

/** Find my match, first question: static and cached (ISR, 5 minutes, purged on publish). Answers are rewritten by proxy.ts to v/[state]. */
export const revalidate = 300;
export const metadata: Metadata = matchMetadata;

export default async function MatchPage() {
  await prerenderNeedsDatabase();
  return <MatchView picks={{}} />;
}
