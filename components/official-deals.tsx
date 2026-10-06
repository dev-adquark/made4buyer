import Link from "next/link";
import type { PriceDrop, PromoCode } from "@/lib/public/deals";
import { relativeTime } from "@/lib/public/display";
import { categoryName } from "@/lib/taxonomy/definitions";
import { themeStyle } from "@/lib/taxonomy/themes";

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

/** Filter attributes read by <DealsFilter> (space-separated category slugs, brand slug). */
function filterAttrs(categories: string[], brandSlug: string | null) {
  return { "data-deal": "", "data-categories": categories.join(" "), "data-brand": brandSlug ?? "" };
}

/**
 * One official price drop: the product, who sells it at that price, the current and the stated
 * regular price, the saving computed from the two, when we checked, and where we read it.
 * The link goes straight to the seller's page (sponsored only when a provider affiliated it).
 */
export function PriceDropCard({ d, headingLevel = 3 }: { d: PriceDrop; headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  const checked = relativeTime(d.observedAt);
  const category = d.categories.map((c) => categoryName(c)).find(Boolean);
  return (
    <article className="deal-card no-media" style={themeStyle(d.categories[0]) as React.CSSProperties}>
      <div className="dc-top">
        {category ? <span className="cat-tag">{category}</span> : <span />}
        <span className={`trust ${d.official ? "verified" : "checked"}`}>{d.official ? "Official price" : "Price checked"}</span>
      </div>
      <div className="dc-main">
        <div>
          <H style={{ font: "inherit", margin: 0 }}>
            {d.review ? (
              <Link className="dc-title" href={`/review/${d.review.slug}`} data-cursor="Read">
                {d.productName}
              </Link>
            ) : (
              <span className="dc-title">{d.productName}</span>
            )}
          </H>
          <span className="label muted">{d.label}</span>
          <span className="dc-price">{d.priceText}</span>
          <span className="dc-was">
            Regular price <s>{d.listPriceText}</s>
          </span>
          <span className="dc-save">
            You save {d.savingText}
            {d.savingPercent >= 1 ? ` (${d.savingPercent}%)` : ""}
          </span>
        </div>
      </div>
      <dl className="dc-more">
        <dt>Seller</dt>
        <dd>{d.official ? `${d.brandName} (official store)` : d.seller}</dd>
        {checked && (
          <>
            <dt>Checked</dt>
            <dd>
              <time dateTime={d.observedAt}>{checked}</time>
            </dd>
          </>
        )}
        <dt>Source</dt>
        <dd>{d.source}</dd>
        <dt>Currency</dt>
        <dd>{d.currency}</dd>
      </dl>
      <div className="dc-cta">
        <span className="label muted">{d.affiliated ? "Affiliate link" : "Direct link"}</span>
        <a className="btn primary small" href={d.url} rel={d.affiliated ? "sponsored nofollow noopener" : "nofollow noopener"} target="_blank" data-cursor="View">
          View at {d.official ? `${d.brandName}` : d.seller}
          <span className="visually-hidden"> for {d.productName} (opens in a new tab)</span>
        </a>
      </div>
    </article>
  );
}

/** One VERIFIED promo code from a brand's own official promotions page, discount text exactly as stated. */
export function PromoCodeCard({ c, headingLevel = 3 }: { c: PromoCode; headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  const verified = c.lastVerifiedAt ? relativeTime(c.lastVerifiedAt) : null;
  const category = c.categories.map((x) => categoryName(x)).find(Boolean);
  return (
    <article className="deal-card no-media" style={themeStyle(c.categories[0]) as React.CSSProperties}>
      <div className="dc-top">
        {category ? <span className="cat-tag">{category}</span> : <span />}
        <span className="trust verified">Verified code</span>
      </div>
      <div className="dc-main">
        <div>
          <H style={{ font: "inherit", margin: 0 }}>
            <span className="dc-title">Official promo code from {c.brandName}</span>
          </H>
          <span className="dc-code">
            <code>{c.code}</code>
          </span>
          {c.discount && <span className="dc-save">{c.discount}</span>}
          {c.eligibility && <span className="small muted">{c.eligibility}</span>}
          {c.restrictions && <span className="small muted">{c.restrictions}</span>}
        </div>
      </div>
      <dl className="dc-more">
        {c.expiresAt && (
          <>
            <dt>Ends</dt>
            <dd>{fmtDate(c.expiresAt)} (as stated)</dd>
          </>
        )}
        {verified && c.lastVerifiedAt && (
          <>
            <dt>Checked</dt>
            <dd>
              <time dateTime={c.lastVerifiedAt}>{verified}</time>
            </dd>
          </>
        )}
        <dt>Source</dt>
        <dd>{c.source}</dd>
      </dl>
      {c.sourceUrl && (
        <div className="dc-cta">
          <span className="label muted">Direct link</span>
          <a className="btn small" href={c.sourceUrl} rel="nofollow noopener" target="_blank">
            {c.brandName}&rsquo;s offers page<span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        </div>
      )}
    </article>
  );
}

export function PriceDropGrid({ drops, headingLevel = 3 }: { drops: PriceDrop[]; headingLevel?: 2 | 3 }) {
  if (!drops.length) return null;
  return (
    <ul className="deal-grid">
      {drops.map((d) => (
        <li key={d.id} {...filterAttrs(d.categories, d.brandSlug)}>
          <PriceDropCard d={d} headingLevel={headingLevel} />
        </li>
      ))}
    </ul>
  );
}

export function PromoCodeGrid({ codes, headingLevel = 3 }: { codes: PromoCode[]; headingLevel?: 2 | 3 }) {
  if (!codes.length) return null;
  return (
    <ul className="deal-grid">
      {codes.map((c) => (
        <li key={c.id} {...filterAttrs(c.categories, c.brandSlug)}>
          <PromoCodeCard c={c} headingLevel={headingLevel} />
        </li>
      ))}
    </ul>
  );
}
