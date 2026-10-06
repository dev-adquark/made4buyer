import { verifiedCouponsFor } from "@/lib/commerce/coupons";

/**
 * Promo codes a brand publishes on its own official site, shown only while VERIFIED: found on
 * the brand's official promotions page in a recent crawl and not expired. UNVERIFIED, UNKNOWN,
 * CONFLICTING, INVALID and EXPIRED codes are never shown. Renders nothing when there are none.
 */
export default async function VerifiedCoupons({ brandId, merchant, limit = 4, heading = "Codes from the brand" }: { brandId?: string | null; merchant?: string | null; limit?: number; heading?: string }) {
  const coupons = await verifiedCouponsFor({ brandId, merchant }, new Date(), limit).catch(() => []);
  if (!coupons.length) return null;
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <section className="verified-coupons" aria-label={heading}>
      <h2 className="small" style={{ margin: "0 0 8px" }}>
        {heading}
      </h2>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>
        {coupons.map((c) => (
          <li key={c.id} className="card" style={{ padding: 12 }}>
            <div className="verified-head">Published by {c.merchant} on its official site</div>
            <div style={{ fontWeight: 800, fontSize: 18, letterSpacing: "0.04em", marginTop: 4 }}>
              <code>{c.code}</code>
            </div>
            {c.discount && <div>{c.discount}</div>}
            {c.eligibility && <div className="small muted">{c.eligibility}</div>}
            {c.restrictions && <div className="small muted">{c.restrictions}</div>}
            <div className="small muted">
              {c.expiresAt ? `Ends ${fmt(c.expiresAt)} (as stated by ${c.merchant}). ` : ""}
              {c.lastVerifiedAt ? (
                <>
                  Last verified <time dateTime={c.lastVerifiedAt.toISOString()}>{fmt(c.lastVerifiedAt)}</time>.
                </>
              ) : null}
            </div>
            <a className="small" href={c.sourceUrl} rel="nofollow noopener" target="_blank">
              See {c.merchant}&rsquo;s official offers page<span className="visually-hidden"> (opens in a new tab)</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
