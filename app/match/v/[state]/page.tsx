import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { decodeMatchState } from "@/lib/public/listing-routes";
import { CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";
import { MatchView, matchMetadata } from "../../match-view";

/** /match?category=…&intent=…&platform=…&tier=… (rewritten here by proxy.ts), cached per set of answers (ISR, 5 minutes, purged on publish). */
export const revalidate = 300;
export const metadata: Metadata = matchMetadata;

export function generateStaticParams(): Array<{ state: string }> {
  return [];
}

export default async function MatchStatePage({ params }: { params: Promise<{ state: string }> }) {
  const picks = decodeMatchState((await params).state, (slug) => CATEGORY_BY_SLUG.has(slug));
  if (!picks) notFound();
  return <MatchView picks={picks} />;
}
