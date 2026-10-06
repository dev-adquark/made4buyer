/**
 * Factual trust labels. Each one states something the data proves; none of them is a rating.
 *  verified: an offer link reached the retailer on its last check
 *  source:   the text is a review from a named publisher
 *  ai:       our own guide or article (Made4Buyers; never rated)
 *  checked:  when the offer link was last checked
 */
export default function TrustLabel({ kind, children }: { kind: "verified" | "source" | "ai" | "checked" | "none"; children?: React.ReactNode }) {
  const text = children ?? { verified: "Verified offer", source: "Source review", ai: "Guide", checked: "Checked", none: "No verified offer" }[kind];
  return <span className={`trust ${kind}`}>{text}</span>;
}
