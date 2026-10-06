import { verifiedCouponsFor } from "@/lib/commerce/coupons";
import { displayDate, displayText, displayUrl } from "@/lib/public/display";

/**
 * Promo codes a brand publishes on its own official site, shown only while VERIFIED: found on
 * the brand's official promotions page in a recent crawl and not expired. UNVERIFIED, UNKNOWN,
 * CONFLICTING, INVALID and EXPIRED codes are never shown. Renders nothing when there are none.
 * Every field is shown exactly as stated, or left out when empty.
 */
export default async function VerifiedCoupons({ brandId, merchant, limit = 4, heading = "Codes from the brand" }: { brandId?: string | null; merchant?: string | null; limit?: number; heading?: string }) {
  const now = new Date();
  const rows = await verifiedCouponsFor({ brandId, merchant }, now, limit).catch(() => []);
  // Belt and braces: the status and expiry are re-checked here; one card per (merchant, code).
  const seen = new Set<string>();
  const coupons = rows.filter((c) => {
    const code = displayText(c.code);
    const key = `${c.merchant.toLowerCase()}|${(code ?? "").toUpperCase()}`;
    if (c.status !== "VERIFIED" || !code || !displayText(c.merchant) || (c.expiresAt && c.expiresAt <= now) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!coupons.length) return null;
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <section className="verified-coupons" aria-label={heading}>
      <h2 className="small" style={{ margin: "0 0 8px" }}>
        {heading}
      </h2>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>
        {coupons.map((c) => {
          const expires = displayDate(c.expiresAt);
          const verified = displayDate(c.lastVerifiedAt);
          const source = displayUrl(c.sourceUrl);
          return (
            <li key={c.id} className="card" style={{ padding: 12 }}>
              <div className="verified-head">Published by {c.merchant} on its official site</div>
              <div style={{ fontWeight: 800, fontSize: 18, letterSpacing: "0.04em", marginTop: 4 }}>
                <code>{c.code.trim()}</code>
              </div>
              {displayText(c.discount) && <div>{displayText(c.discount)}</div>}
              {displayText(c.eligibility) && <div className="small muted">{displayText(c.eligibility)}</div>}
              {displayText(c.restrictions) && <div className="small muted">{displayText(c.restrictions)}</div>}
              {(expires || verified) && (
                <div className="small muted">
                  {expires ? `Ends ${fmt(expires)} (as stated by ${c.merchant}). ` : ""}
                  {verified ? (
                    <>
                      Last verified <time dateTime={verified.toISOString()}>{fmt(verified)}</time>.
                    </>
                  ) : null}
                </div>
              )}
              {source && (
                <a className="small" href={source} rel="nofollow noopener" target="_blank">
                  See {c.merchant}&rsquo;s official offers page<span className="visually-hidden"> (opens in a new tab)</span>
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
