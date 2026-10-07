import "@/app/deals/deals.css";
import Link from "next/link";
import BrandLogo from "@/components/brand-logo";
import CopyCodeButton from "@/components/copy-code-button";
import type { CurrentPrice, PriceDrop, PromoCode } from "@/lib/public/deals";
import { relativeTime } from "@/lib/public/display";
import { categoryName } from "@/lib/taxonomy/definitions";
import { themeStyle } from "@/lib/taxonomy/themes";

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
/** "Oct 7, 2026, 14:05 UTC": the absolute time next to a relative one. */
const fmtDateTime = (iso: string) => `${new Date(iso).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" })} UTC`;

/**
 * Filter and sort attributes read by <DealsFilter>: space-separated category slugs, brand slug, seller
 * domain, verification kind, and the stated numbers (empty when not stated: such an item is hidden by
 * a filter on that number and sorted last).
 */
type FilterInput = { categories: string[]; brandSlug: string | null; seller?: string | null; kind: "official" | "retailer"; savingPercent?: number | null; saving?: number | null; price?: number | null; checked: string | null };
function filterAttrs(f: FilterInput) {
  const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "");
  return {
    "data-deal": "",
    "data-categories": f.categories.join(" "),
    "data-brand": f.brandSlug ?? "",
    "data-seller": f.seller ?? "",
    "data-kind": f.kind,
    "data-saving-pct": n(f.savingPercent),
    "data-saving": n(f.saving),
    "data-price": n(f.price),
    "data-checked": f.checked ? String(Date.parse(f.checked)) : "",
  };
}

/** The whole percent a code's own offer text states ("20% off sitewide" → 20); null when it states none. Never inferred. */
export function statedPercent(text: string | null): number | null {
  const m = text?.match(/(?<![\d.])(\d{1,3}(?:\.\d+)?)\s?%/);
  const n = m ? Math.floor(Number(m[1])) : NaN;
  return n > 0 && n <= 100 ? n : null;
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
            <dd>
              {d.brandSlug && <BrandLogo slug={d.brandSlug} name={d.brandName} height={16} />}
              {d.brandName}
            </dd>
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

/**
 * One promo code from a brand's own official site or store, verified within the coupon window:
 * brand, the offer exactly as stated (only when stated), the code with Copy code, when it was last
 * verified, terms and expiry only when stated, and View offer (the official page that publishes it).
 */
export function PromoCodeCard({ c, headingLevel = 3 }: { c: PromoCode; headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  const codeId = `code-${c.id}`;
  const verified = c.lastVerifiedAt ? relativeTime(c.lastVerifiedAt) : null;
  const terms = [c.eligibility, c.restrictions].filter((x): x is string => Boolean(x));
  return (
    <article className="coupon-card" style={themeStyle(c.categories[0]) as React.CSSProperties}>
      <div className="cc-head">
        <H className="cc-brand">
          <BrandLogo slug={c.brandSlug} name={c.brandName} height={18} />
          {c.brandName}
          <span className="visually-hidden"> promo code</span>
        </H>
        <span className="trust verified">Verified</span>
      </div>
      {c.discount && <p className="cc-offer">{c.discount}</p>}
      <div className="cc-code">
        <span className="cc-code-label">Code</span>
        <code id={codeId}>{c.code}</code>
      </div>
      <p className="cc-meta">
        <span className="cc-check" aria-hidden="true">
          ✓
        </span>{" "}
        {c.lastVerifiedAt ? (
          <>
            Verified{" "}
            <time dateTime={c.lastVerifiedAt} title={fmtDateTime(c.lastVerifiedAt)}>
              {verified ?? fmtDateTime(c.lastVerifiedAt)}
            </time>
          </>
        ) : (
          "Verified"
        )}{" "}
        on {c.verifiedVia.toLowerCase()} · {c.source.replace(/ \(official site\)$/, "")}
      </p>
      {terms.length > 0 && (
        <p className="cc-terms">
          <span className="cc-label">Terms</span> {terms.join(" ")}
        </p>
      )}
      {c.expiresAt && (
        <p className="cc-terms">
          <span className="cc-label">Expires</span> {fmtDate(c.expiresAt)} (as stated)
        </p>
      )}
      <div className="cc-actions">
        <CopyCodeButton code={c.code} targetId={codeId} className="btn small cc-copy" />
        {c.useUrl && (
          <a className="btn primary small" href={c.useUrl} rel="nofollow noopener" target="_blank">
            View offer
            <span className="visually-hidden">
              {" "}
              for {c.code} on {c.brandName}&rsquo;s official site (opens in a new tab)
            </span>
          </a>
        )}
      </div>
    </article>
  );
}

/**
 * A recently verified current price: the price the seller's page states now, with no stated previous
 * price. Labelled as a current price, never as a deal or a saving.
 */
export function CurrentPriceCard({ p, headingLevel = 3 }: { p: CurrentPrice; headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  const category = p.categories.map((c) => categoryName(c)).find(Boolean);
  const sellerName = p.official ? (p.brandName ?? p.seller) : p.seller;
  return (
    <article className="deal-card no-media price-card" style={themeStyle(p.categories[0]) as React.CSSProperties}>
      <div className="dc-top">
        {category ? <span className="cat-tag">{category}</span> : <span />}
        <span className="trust checked">Current price</span>
      </div>
      <div className="dc-main">
        <div>
          <H style={{ font: "inherit", margin: 0 }}>
            {p.review ? (
              <Link className="dc-title" href={`/review/${p.review.slug}`}>
                {p.productName}
              </Link>
            ) : (
              <span className="dc-title">{p.productName}</span>
            )}
          </H>
          <span className="label muted">{p.label}</span>
          <span className="dc-price">
            <span className="visually-hidden">Current price </span>
            {p.priceText}
          </span>
          <span className="small muted">No previous price stated: not a discount.</span>
          {p.availability && <span className="dc-avail small">{p.availability}</span>}
        </div>
      </div>
      <dl className="dc-facts">
        <dt>Verified</dt>
        <dd>{p.verified}</dd>
        <dt>Last checked</dt>
        <dd>
          <Checked iso={p.observedAt} />
        </dd>
      </dl>
      <div className="dc-cta">
        <span className="label muted">{p.affiliated ? "Affiliate link" : "Direct link"}</span>
        <a className="btn small" href={p.url} rel={p.affiliated ? "sponsored nofollow noopener" : "nofollow noopener"} target="_blank">
          View price
          <span className="visually-hidden">
            {" "}
            of {p.productName} at {sellerName} (opens in a new tab)
          </span>
        </a>
      </div>
    </article>
  );
}

export function PriceDropGrid({ drops, headingLevel = 3 }: { drops: PriceDrop[]; headingLevel?: 2 | 3 }) {
  if (!drops.length) return null;
  return (
    <ul className="deal-grid" data-deal-list="">
      {drops.map((d) => (
        <li key={d.id} {...filterAttrs({ categories: d.categories, brandSlug: d.brandSlug, seller: d.sellerDomain, kind: d.verifiedKind, savingPercent: d.savingPercent, saving: d.saving, price: d.price, checked: d.observedAt })}>
          <PriceDropCard d={d} headingLevel={headingLevel} />
        </li>
      ))}
    </ul>
  );
}

export function PromoCodeGrid({ codes, headingLevel = 3 }: { codes: PromoCode[]; headingLevel?: 2 | 3 }) {
  if (!codes.length) return null;
  return (
    <ul className="deal-grid coupon-grid" data-deal-list="">
      {codes.map((c) => (
        <li key={c.id} {...filterAttrs({ categories: c.categories, brandSlug: c.brandSlug, seller: c.sellerDomain, kind: "official", savingPercent: statedPercent(c.discount), checked: c.lastVerifiedAt })}>
          <PromoCodeCard c={c} headingLevel={headingLevel} />
        </li>
      ))}
    </ul>
  );
}

export function CurrentPriceGrid({ prices, headingLevel = 3 }: { prices: CurrentPrice[]; headingLevel?: 2 | 3 }) {
  if (!prices.length) return null;
  return (
    <ul className="deal-grid" data-deal-list="">
      {prices.map((p) => (
        <li key={p.id} {...filterAttrs({ categories: p.categories, brandSlug: p.brandSlug, seller: p.sellerDomain, kind: p.verifiedKind, price: p.price, checked: p.observedAt })}>
          <CurrentPriceCard p={p} headingLevel={headingLevel} />
        </li>
      ))}
    </ul>
  );
}
