import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { decodeMatchState } from "@/lib/public/listing-routes";
import { CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";
import { MatchView, matchMetadataFor } from "../../match-view";

/** /match?category=…&intent=…&platform=…&tier=… (rewritten here by proxy.ts), cached per set of answers (ISR, 5 minutes, purged on publish). */
export const revalidate = 300;

type Props = { params: Promise<{ state: string }> };
const picksOf = async ({ params }: Props) => decodeMatchState((await params).state, (slug) => CATEGORY_BY_SLUG.has(slug));

export function generateStaticParams(): Array<{ state: string }> {
  return [];
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const picks = await picksOf(props);
  return picks ? matchMetadataFor(picks) : {};
}

export default async function MatchStatePage(props: Props) {
  const picks = await picksOf(props);
  if (!picks) notFound();
  return <MatchView picks={picks} />;
}
