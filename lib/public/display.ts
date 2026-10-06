/**
 * Public display sanitizer. Every value a public page renders from stored data goes through one of
 * these helpers. Each returns either a clean, displayable value or `null` — never a placeholder.
 * A `null` means "leave it out": the caller omits the field, or hides the whole section when
 * nothing is left. Nothing here invents, rounds up or defaults a value.
 *
 * Forbidden on public pages (see tests/unit/display.test.ts and tests/integration/public-integrity.test.ts):
 * "null", "nil", "undefined", "NaN", "N/A", "unknown", "$0"/"₹0" for a missing price, an empty
 * currency symbol, an empty link, href="#", placeholder URLs or names.
 */

/** Strings that mean "no value" when stored as text (compared case-insensitively, trimmed). */
const EMPTY_TOKENS = new Set([
  "",
  "null",
  "nil",
  "undefined",
  "nan",
  "n/a",
  "n.a.",
  "n\\a",
  "unknown",
  "not available",
  "not applicable",
  "tbd",
  "tba",
  "-",
  "--",
  "—",
  "–",
  "?",
  "...",
  "…",
  "[object object]",
  "placeholder",
  "lorem ipsum",
  "test",
  "todo",
]);

/** A displayable string, or null for empty/placeholder values. Numbers are stringified only when finite. */
export function displayText(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v === "bigint") return String(v);
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  if (EMPTY_TOKENS.has(s.toLowerCase())) return null;
  // A value made only of punctuation/symbols ("$", "—", "***") says nothing.
  if (!/[\p{L}\p{N}]/u.test(s)) return null;
  return s;
}

/** True when displayText would render something. */
export function hasText(v: unknown): boolean {
  return displayText(v) !== null;
}

/** First displayable value of several candidates, or null. */
export function firstText(...vs: unknown[]): string | null {
  for (const v of vs) {
    const t = displayText(v);
    if (t) return t;
  }
  return null;
}

let ISO_CURRENCIES: Set<string> | null = null;
function isoCurrencies(): Set<string> {
  if (!ISO_CURRENCIES) {
    try {
      ISO_CURRENCIES = new Set((Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("currency"));
    } catch {
      ISO_CURRENCIES = new Set(["USD", "EUR", "GBP", "INR", "CAD", "AUD", "JPY", "CNY", "CHF", "SEK", "NOK", "DKK", "NZD", "SGD", "HKD", "MXN", "BRL", "ZAR", "KRW", "PLN"]);
    }
  }
  return ISO_CURRENCIES;
}

/** A valid ISO 4217 currency code (upper-cased), or null. Symbols ("$") and empty values are not codes. */
export function displayCurrency(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const c = v.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) && isoCurrencies().has(c) ? c : null;
}

/** A finite, strictly positive amount, or null. Numeric strings are accepted ("19.99"); anything else is not. */
export function displayAmount(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * A formatted price, or null unless the amount is a finite number > 0 and the currency a valid
 * ISO 4217 code. Never "$0", never a bare symbol, never a guessed currency.
 */
export function displayPrice(amount: unknown, currency: unknown, locale = "en-US"): string | null {
  const a = displayAmount(amount);
  const c = displayCurrency(currency);
  if (a === null || c === null) return null;
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: c }).format(a);
  } catch {
    return null;
  }
}

/** Hosts that are never a real destination: documentation/reserved names and local addresses. */
const PLACEHOLDER_HOST = /(^|\.)(example\.(com|net|org)|example|invalid|localhost|local|test|localdomain|internal)$/i;

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/** An absolute public http(s) URL, or null (relative links, "#", javascript:, placeholder hosts, IP literals). */
export function displayUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.startsWith("#")) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || !host.includes(".") || isIpLiteral(host) || PLACEHOLDER_HOST.test(host)) return null;
  return u.toString();
}

/** A valid date (Date, ISO string or epoch ms) between 1990 and one year ahead, or null. */
export function displayDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? new Date(v.getTime()) : typeof v === "string" || typeof v === "number" ? new Date(v) : null;
  if (!d) return null;
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  if (t < Date.UTC(1990, 0, 1) || t > Date.now() + 366 * 86_400_000) return null;
  return d;
}

/** A finite number (optionally > 0 / within bounds), or null. Numeric strings are accepted. */
export function displayNumber(v: unknown, opts: { min?: number; max?: number; positive?: boolean } = {}): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n)) return null;
  if (opts.positive && n <= 0) return null;
  if (opts.min !== undefined && n < opts.min) return null;
  if (opts.max !== undefined && n > opts.max) return null;
  return n;
}

/** The list without empty entries (null/undefined/placeholder strings), or null when nothing is left. */
export function nonEmpty<T>(list: ReadonlyArray<T | null | undefined> | null | undefined): T[] | null {
  if (!Array.isArray(list)) return null;
  const out = list.filter((x): x is T => x != null && (typeof x !== "string" || displayText(x) !== null) && (typeof x !== "number" || Number.isFinite(x)));
  return out.length ? out : null;
}

/** "3 hours ago" style label for a past observation, or null for an invalid/future date. */
export function relativeTime(v: unknown, now = Date.now()): string | null {
  const d = displayDate(v);
  if (!d) return null;
  const diff = now - d.getTime();
  if (diff < -5 * 60_000) return null;
  const min = Math.max(0, Math.floor(diff / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} ${min === 1 ? "minute" : "minutes"} ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(h / 24);
  return `${days} days ago`;
}

/**
 * Visible text that must never reach a public page. Used by the integration and E2E checks.
 * "$0", "$0.00", "₹0": a zero price ("$0.99" is a real price and is not matched).
 */
export const FORBIDDEN_PUBLIC_TOKENS = /\b(null|undefined|NaN)\b|\bN\/A\b|\bnil\b|(?:\$|₹|€|£)\s?0(?:[.,]0+)?(?![\d.,])/;

/**
 * Removes empty values from JSON-LD before it is serialised: null, undefined, NaN, empty or
 * placeholder strings, empty arrays and objects left with nothing but their "@type". Then drops
 * any Offer without a positive price and ISO currency, and any AggregateRating without a real
 * ratingValue and ratingCount/reviewCount (and a Product left without a name).
 */
export function pruneJsonLd<T>(data: T): T | undefined {
  return prune(data) as T | undefined;
}

function prune(v: unknown): unknown {
  if (v == null) return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    // Schema URLs ("https://schema.org/InStock") and @context are kept as they are.
    return displayText(v) === null && !/^https?:\/\//.test(v) ? undefined : v.trim();
  }
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : undefined;
  if (Array.isArray(v)) {
    const out = v.map(prune).filter((x) => x !== undefined);
    return out.length ? out : undefined;
  }
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const p = prune(x);
      if (p !== undefined) out[k] = p;
    }
    const keys = Object.keys(out).filter((k) => k !== "@type" && k !== "@context");
    if (!keys.length) return undefined;
    const type = out["@type"];
    if (type === "Offer" || type === "AggregateOffer") {
      const price = type === "Offer" ? displayAmount(out.price) : displayAmount(out.lowPrice);
      if (price === null || !displayCurrency(out.priceCurrency)) return undefined;
    }
    if (type === "AggregateRating") {
      const value = displayNumber(out.ratingValue, { positive: true });
      const count = displayNumber(out.ratingCount ?? out.reviewCount, { positive: true });
      if (value === null || count === null) return undefined;
    }
    if (type === "Rating" && displayNumber(out.ratingValue) === null) return undefined;
    // A Review must say what it reviews.
    if (type === "Review" && !out.itemReviewed) return undefined;
    if ((type === "Product" || type === "Thing" || type === "Brand" || type === "Organization" || type === "Person") && !displayText(out.name)) return undefined;
    // A ListItem must keep a position and either a name or an item.
    if (type === "ListItem" && (displayNumber(out.position) === null || (!out.name && !out.item))) return undefined;
    return out;
  }
  return undefined;
}

/** Click-tracking parameters: never part of a destination's identity. */
const TRACKING_PARAM = /^(utm_[a-z0-9_]+|gclid|gclsrc|dclid|fbclid|msclkid|yclid|twclid|ttclid|li_fat_id|mc_[a-z0-9_]+|_ga|_gl|_hsenc|_hsmi|mkt_tok|igshid|si|spm)$/i;
/** Affiliate/referral parameters: kept only when a real affiliate provider generated the link. */
const AFFILIATE_PARAM = /^(tag|ref|ref_|ascsubtag|linkcode|linkid|camp|creative|irclickid|irgwc|clickid|cjevent|aff(_?id)?|affiliate(_?id)?|subid|sub_id|afftrack|partner(_?id)?|pid|clickref)$/i;

/**
 * The canonical form of a destination URL, used to recognise the same link twice: lower-case
 * host without "www.", no fragment, no tracking parameters (utm_*, gclid, fbclid, mc_*, …), no
 * repeated parameters (first value wins), parameters sorted, no trailing slash. Affiliate
 * parameters are kept only when `keepAffiliateParams` (a real provider is configured); with
 * provider "none" they are someone else's tracking and are dropped. Null for a non-http(s) URL.
 */
export function canonicalDestination(v: unknown, opts: { keepAffiliateParams?: boolean } = {}): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  const seen = new Set<string>();
  const kept: Array<[string, string]> = [];
  for (const [k, val] of u.searchParams) {
    const key = k.toLowerCase();
    if (TRACKING_PARAM.test(key)) continue;
    if (AFFILIATE_PARAM.test(key) && !opts.keepAffiliateParams) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push([k, val]);
  }
  kept.sort(([a], [b]) => a.localeCompare(b));
  u.search = new URLSearchParams(kept).toString();
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  // https and http versions of one page are the same destination.
  return u.toString().replace(/^http:\/\//, "https://");
}

/** Shown wherever a review has no fresh, verified price (review page, compare). */
export const NO_VERIFIED_PRICE = "We couldn't verify a current price from an authoritative source.";
/** Shown on /deals (and its rails) when there is no verified deal. */
export const NO_VERIFIED_OFFER = "No verified offer is available right now.";
