import Link from "next/link";
import CopyCodeButton from "@/components/copy-code-button";
import type { PriceDrop, PromoCode } from "@/lib/public/deals";
import { relativeTime } from "@/lib/public/display";
import { categoryName } from "@/lib/taxonomy/definitions";
import { themeStyle } from "@/lib/taxonomy/themes";

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
/** "Oct 7, 2026, 14:05 UTC": the absolute time next to a relative one. */
const fmtDateTime = (iso: string) => `${new Date(iso).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" })} UTC`;

/** Filter attributes read by <DealsFilter> (space-separated category slugs, brand slug). */
function filterAttrs(categories: string[], brandSlug: string | null) {
  return { "data-deal": "", "data-categories": categories.join(" "), "data-brand": brandSlug ?? "" };
}

/** "3 hours ago" in a <time> carrying the exact instant, followed by the absolute time. */
function Checked({ iso }: { iso: string }) {
  const rel = relativeTime(iso);
  const abs = fmtDateTime(iso);
  return (
    <>
      <time dateTime={iso} title={abs}>
        {rel ?? abs}
      </time>
      {rel && <span className="muted"> · {abs}</span>}
    </>
  );
}

/**
 * One verified price drop: the product, its brand, the current price, the previous price labelled as
 * the page labels it, the saving worked out from those two, what we verified, when we last checked,
 * and a link straight to the seller's page (sponsored only when a provider affiliated it).
 */
export function PriceDropCard({ d, headingLevel = 3 }: { d: PriceDrop; headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  const category = d.categories.map((c) => categoryName(c)).find(Boolean);
  const linkChecked = d.linkCheckedAt ? relativeTime(d.linkCheckedAt) : null;
  const sellerName = d.official ? (d.brandName ?? d.seller) : d.seller;
  return (
    <article className="deal-card no-media" style={themeStyle(d.categories[0]) as React.CSSProperties}>
      <div className="dc-top">
        {category ? <span className="cat-tag">{category}</span> : <span />}
        <span className="trust verified">Verified</span>
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
          <span className="dc-price">
            <span className="visually-hidden">Current price </span>
            {d.priceText}
          </span>
          <span className="dc-was">
            {d.listPriceLabel} <s>{d.listPriceText}</s>
          </span>
          <span className="dc-save">
            You save {d.savingText}
            {d.savingPercent >= 1 ? ` (${d.savingPercent}%)` : ""}
          </span>
          {d.availability && <span className="dc-avail small">{d.availability}</span>}
        </div>
      </div>
      <dl className="dc-facts">
        {d.brandName && (
          <>
            <dt>Brand</dt>
            <dd>{d.brandName}</dd>
          </>
        )}
        {!d.official && (
          <>
            <dt>Seller</dt>
            <dd>{d.seller}</dd>
          </>
        )}
        <dt>Verified</dt>
        <dd>
          {d.verified}
          {d.linkCheckedAt && linkChecked ? (
            <>
              {" "}
              · link checked <time dateTime={d.linkCheckedAt}>{linkChecked}</time>
            </>
          ) : null}
        </dd>
        {d.validUntil && (
          <>
            <dt>Ends</dt>
            <dd>{fmtDate(d.validUntil)} (as stated)</dd>
          </>
        )}
        <dt>Last checked</dt>
        <dd>
          <Checked iso={d.observedAt} />
        </dd>
      </dl>
      <div className="dc-cta">
        <span className="label muted">{d.affiliated ? "Affiliate link" : "Direct link"}</span>
        <a className="btn primary small" href={d.url} rel={d.affiliated ? "sponsored nofollow noopener" : "nofollow noopener"} target="_blank" data-cursor="View">
          View deal
          <span className="visually-hidden">
            {" "}
            on {d.productName} at {sellerName} (opens in a new tab)
          </span>
        </a>
      </div>
    </article>
  );
}

/** One verified promo code from a brand's own official promotions page, discount text exactly as stated. */
export function PromoCodeCard({ c, headingLevel = 3 }: { c: PromoCode; headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  const category = c.categories.map((x) => categoryName(x)).find(Boolean);
  const codeId = `code-${c.id}`;
  return (
    <article className="deal-card no-media" style={themeStyle(c.categories[0]) as React.CSSProperties}>
      <div className="dc-top">
        {category ? <span className="cat-tag">{category}</span> : <span />}
        <span className="trust verified">Verified</span>
      </div>
      <div className="dc-main">
        <div>
          <H style={{ font: "inherit", margin: 0 }}>
            <span className="dc-title">Official promo code from {c.brandName}</span>
          </H>
          <span className="dc-code">
            <code id={codeId}>{c.code}</code>
            <CopyCodeButton code={c.code} targetId={codeId} />
          </span>
          {c.eligibility && <span className="small muted">{c.eligibility}</span>}
          {c.restrictions && <span className="small muted">{c.restrictions}</span>}
        </div>
      </div>
      <dl className="dc-facts">
        <dt>Brand</dt>
        <dd>{c.brandName}</dd>
        {c.discount && (
          <>
            <dt>Offer</dt>
            <dd className="dc-offer">{c.discount}</dd>
          </>
        )}
        {c.expiresAt && (
          <>
            <dt>Expires</dt>
            <dd>{fmtDate(c.expiresAt)} (as stated)</dd>
          </>
        )}
        <dt>Verified</dt>
        <dd>Published on {c.source}</dd>
        {c.lastVerifiedAt && (
          <>
            <dt>Last checked</dt>
            <dd>
              <Checked iso={c.lastVerifiedAt} />
            </dd>
          </>
        )}
      </dl>
      {c.useUrl && (
        <div className="dc-cta">
          <span className="label muted">Direct link</span>
          <a className="btn primary small" href={c.useUrl} rel="nofollow noopener" target="_blank">
            Use code
            <span className="visually-hidden">
              {" "}
              {c.code} on {c.brandName}&rsquo;s official site (opens in a new tab)
            </span>
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
