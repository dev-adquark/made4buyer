import BrandLogo from "@/components/brand-logo";
import CopyCodeButton from "@/components/copy-code-button";
import type { PromoCode } from "@/lib/public/deals";
import { relativeTime } from "@/lib/public/display";
import { themeStyle } from "@/lib/taxonomy/themes";

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * Compact homepage card for one verified promo code (the same PromoCode /deals lists): brand, the
 * offer exactly as the brand states it, the code with Copy, when it was verified, and the brand's
 * own offers page.
 */
export default function HomeCouponCard({ c }: { c: PromoCode }) {
  const codeId = `home-code-${c.id}`;
  const when = c.viaFeed ? (c.checkedAt ?? null) : c.lastVerifiedAt;
  const checked = when ? relativeTime(when) : null;
  return (
    <article className="hc-card" style={themeStyle(c.categories[0]) as React.CSSProperties}>
      <span className="hd-brand">
        <BrandLogo slug={c.brandSlug} name={c.brandName} height={16} />
        {c.brandName}
      </span>
      <h3 className="hc-offer">{c.discount ?? `Promo code from ${c.brandName}`}</h3>
      <span className="hc-code">
        <code id={codeId}>{c.code}</code>
        <CopyCodeButton code={c.code} targetId={codeId} />
      </span>
      {c.expiresAt && <span className="hc-exp">Ends {fmtDate(c.expiresAt)} (as stated)</span>}
      <p className="hd-verify">
        {c.viaFeed ? <span className="trust checked">Via Feedico</span> : <span className="trust verified">Verified</span>}
        {checked && when && (
          <span>
            Checked{" "}
            <time dateTime={when} title={when}>
              {checked}
            </time>
          </span>
        )}
      </p>
      {c.useUrl && (
        <div className="hd-cta">
          <a className="btn small" href={c.useUrl} rel="nofollow noopener" target="_blank" draggable={false}>
            View offer
            <span className="visually-hidden">
              {" "}
              for code {c.code} on {c.brandName}&rsquo;s {c.viaFeed ? "website" : "official site"} (opens in a new tab)
            </span>
          </a>
        </div>
      )}
    </article>
  );
}
