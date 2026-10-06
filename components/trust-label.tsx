/**
 * Factual trust labels. Each one states something the data proves; none of them is a rating.
 *  verified: legacy label (no longer used on public pages)
 *  source:   the text is a review from a named publisher
 *  ai:       our own guide or article (Made4Buyers; never rated)
 *  checked:  a price observed recently at the seller
 */
export default function TrustLabel({ kind, children }: { kind: "verified" | "source" | "ai" | "checked" | "none"; children?: React.ReactNode }) {
  const text = children ?? { verified: "Verified offer", source: "Source review", ai: "Guide", checked: "Checked", none: "No current price" }[kind];
  return <span className={`trust ${kind}`}>{text}</span>;
}
