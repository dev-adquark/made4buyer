import { pruneJsonLd } from "@/lib/public/display";

/**
 * Serialises JSON-LD safely (escapes "<" so data can never close the script element). Every block
 * is pruned first: no null/empty/placeholder fields, no Offer without a positive price and ISO
 * currency, no AggregateRating without a stored rating value and count. Renders nothing when
 * nothing real is left.
 */
export default function JsonLd({ data }: { data: unknown }) {
  const clean = pruneJsonLd(data);
  if (clean === undefined) return null;
  const json = JSON.stringify(clean).replace(/</g, "\\u003c");
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
