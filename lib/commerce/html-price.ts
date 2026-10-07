/**
 * HTML price-block fallback (lower confidence, conservative). Used only when neither the page's
 * JSON-LD nor its Shopify product JSON states a previous price.
 *
 * The product page function collects the page's MAIN price block raw: the smallest visible element
 * group near the primary h1 / product form that shows the structured current price, and inside it
 * every <s>/<del>/<strike> and every element marked as a previous price ("was", "reg", "regular",
 * "original", "compare", "list price", "msrp" …) with its label text. This module decides, server-side:
 *
 *  - the block must show the current price, equal to the structured (JSON-LD/meta/Shopify) price, and
 *    not merely as a marked previous price (a block whose "Regular price" is the structured price shows
 *    another current price: it is not used);
 *  - a comparison amount must parse cleanly with a currency marker of the same currency, be above
 *    the current price (and not absurdly so: at most 5×), and appear in the block's own text;
 *  - an MSRP / "suggested" / RRP label is never a previous price (owner rule);
 *  - several different accepted amounts are ambiguous: none is used.
 *
 * listPriceType: "StrikethroughPrice" for <s>/<del>/<strike> (or a line-through style), else "WasPrice" ("was") or
 * "RegularPrice" ("reg", "regular", "original", "compare", "list price"). Confidence 0.8.
 * A promotion end date is read only from the block, only as a full date with a year.
 */

export type RawPriceComparison = { tag?: string; text?: string; cls?: string; aria?: string; label?: string; /** Struck through by markup or by style (text-decoration: line-through). */ struck?: boolean };
export type RawPriceBlock = { text?: string; comparisons?: RawPriceComparison[] };

export type HtmlListPriceType = "StrikethroughPrice" | "WasPrice" | "RegularPrice";

export type PriceBlockResult = {
  /** The block that shows the structured current price was found. */
  matched: boolean;
  listPrice?: number;
  listPriceType?: HtmlListPriceType;
  /** The previous price's own label as the page showed it ("Was", "Regular price" …), when it had one. */
  listPriceLabel?: string;
  confidence?: number;
  /** ISO date (YYYY-MM-DD) of an explicitly stated end, from the block only. */
  priceValidUntil?: string;
  promotionText?: string;
  reasons: string[];
};

export const HTML_PRICE_CONFIDENCE = 0.8;
const MAX_RATIO = 5;

// ── Money ────────────────────────────────────────────────────────────────────

export type MoneyToken = { amount: number; currency: string; raw: string; index: number };

/** Prefix markers → currency. "$" alone is "$" (any dollar; the structured currency decides). */
const PREFIX: Array<[RegExp, string]> = [
  [/^(?:US\$|USD\s?\$?)$/i, "USD"],
  [/^(?:CA\$|C\$|CAD\s?\$?)$/i, "CAD"],
  [/^(?:A\$|AU\$|AUD\s?\$?)$/i, "AUD"],
  [/^(?:NZ\$|NZD\s?\$?)$/i, "NZD"],
  [/^(?:HK\$|HKD\s?\$?)$/i, "HKD"],
  [/^(?:S\$|SGD\s?\$?)$/i, "SGD"],
  [/^(?:MX\$|MXN\s?\$?)$/i, "MXN"],
  [/^R\$$/i, "BRL"],
  [/^\$$/, "$"],
  [/^(?:€|EUR\s?)$/i, "EUR"],
  [/^(?:£|GBP\s?)$/i, "GBP"],
  [/^(?:¥|JPY\s?|CNY\s?)$/i, "JPY"],
  [/^(?:₹|INR\s?)$/i, "INR"],
];
const SUFFIX: Record<string, string> = { usd: "USD", cad: "CAD", aud: "AUD", eur: "EUR", "€": "EUR", gbp: "GBP", "£": "GBP", kr: "SEK", zł: "PLN", chf: "CHF" };

const MONEY_RE = /(US\$|USD\s?\$?|CA\$|C\$|CAD\s?\$?|A\$|AU\$|AUD\s?\$?|NZ\$|NZD\s?\$?|HK\$|HKD\s?\$?|S\$|SGD\s?\$?|MX\$|MXN\s?\$?|R\$|\$|€|EUR\s?|£|GBP\s?|¥|JPY\s?|CNY\s?|₹|INR\s?)?\s?(\d{1,3}(?:[,.]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s?(USD|CAD|AUD|EUR|€|GBP|£|kr|zł|CHF)?(?![\d%])/gi;

/** "1,299.00" → 1299; "1.299,00" (comma decimals) → null for a dollar amount (another locale's format). */
function parseNumber(s: string, dollar: boolean): number | null {
  const t = s.replace(/\s/g, "");
  let n: number;
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t) || /^\d+(\.\d{1,2})?$/.test(t)) n = Number(t.replace(/,/g, ""));
  else if (!dollar && (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t) || /^\d+(,\d{1,2})?$/.test(t))) n = Number(t.replace(/\./g, "").replace(",", "."));
  else return null;
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/** Every amount in the text that carries a currency marker (prefix or suffix). Bare numbers are not money. */
export function moneyTokens(text: string): MoneyToken[] {
  const out: MoneyToken[] = [];
  for (const m of text.matchAll(MONEY_RE)) {
    const pre = m[1]?.trim();
    const suf = m[3]?.trim().toLowerCase();
    if (!pre && !suf) continue;
    // A percentage or a quantity next to the number is not a price.
    const before = text.slice(Math.max(0, (m.index ?? 0) - 1), m.index ?? 0);
    if (!pre && /[\d.,]/.test(before)) continue;
    let currency = pre ? (PREFIX.find(([re]) => re.test(pre))?.[1] ?? null) : null;
    const sufCur = suf ? (SUFFIX[suf] ?? null) : null;
    if (currency && sufCur && currency !== sufCur && !(currency === "$" && ["USD", "CAD", "AUD"].includes(sufCur))) continue; // "$10 CAD"-style conflicts resolve to the suffix only when compatible
    currency = currency === "$" && sufCur ? sufCur : (currency ?? sufCur);
    if (!currency) continue;
    const amount = parseNumber(m[2], currency === "$" || currency.endsWith("D"));
    if (amount == null) continue;
    out.push({ amount, currency, raw: m[0].trim(), index: m.index ?? 0 });
  }
  return out;
}

/** Same currency: an explicit code must equal the structured currency; a bare "$" is accepted for a dollar currency. */
export function sameCurrency(tokenCurrency: string, structured: string | null | undefined): boolean {
  const s = (structured ?? "").toUpperCase();
  if (!s) return false;
  if (tokenCurrency === "$") return ["USD", "CAD", "AUD", "NZD", "HKD", "SGD", "MXN"].includes(s);
  return tokenCurrency.toUpperCase() === s;
}

const sameAmount = (a: number, b: number) => Math.abs(a - b) < 0.005;
const clean = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");

// ── Labels ───────────────────────────────────────────────────────────────────

/** MSRP is never a previous price (owner rule); neither is a "suggested"/RRP price. */
const MSRP = /\b(?:m\.?s\.?r\.?p|rrp|suggested|manufacturer'?s?\s+(?:suggested|list|retail))\b/i;
const WAS = /\bwas\b/i;
const REGULAR = /\b(?:reg|regular|original|orig|compare(?:[\s_-]?at)?|list[\s_-]?price)\b/i;

function comparisonType(c: RawPriceComparison, label: string): HtmlListPriceType | null {
  const tag = clean(c.tag).toLowerCase();
  if (tag === "s" || tag === "del" || tag === "strike" || c.struck === true) return "StrikethroughPrice";
  if (WAS.test(label)) return "WasPrice";
  if (REGULAR.test(label)) return "RegularPrice";
  return null;
}

/** The label words of a comparison (its own text minus the amount, aria-label, class, nearby label). */
function labelOf(c: RawPriceComparison): string {
  return [c.label, c.aria, c.text, (c.cls ?? "").replace(/[-_]/g, " ")].map(clean).filter(Boolean).join(" | ");
}

/** A short human label for the previous price, from the page's own words (e.g. "Was", "Regular price", "Compare at"). */
function displayLabel(c: RawPriceComparison): string | undefined {
  for (const s of [c.label, c.aria, c.text]) {
    const t = clean(s)
      .replace(MONEY_RE, " ")
      .replace(/\s+/g, " ")
      .replace(/[:\s]+$/, "")
      .trim();
    const m = /\b(was|reg(?:ular)?(?: price)?|original(?: price)?|compare(?: at)?(?: price)?|list price)\b/i.exec(t);
    if (m) return m[1].replace(/^./, (x) => x.toUpperCase());
  }
  return undefined;
}

// ── Dates ────────────────────────────────────────────────────────────────────

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** "Oct", "Oct.", "Sept", "October" → 10; anything else → null. */
function monthOf(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, "");
  if (w.length < 3) return null;
  const i = MONTH_NAMES.findIndex((n) => n === w || n.startsWith(w));
  return i >= 0 ? i + 1 : null;
}
const END_KEYWORD = /\b(?:ends?|ending|through|thru|until|till|expires?|valid\s+(?:through|thru|until|till))\b\s*(?:on\s+)?/gi;

function iso(y: number, m: number, d: number): string | null {
  if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** A full date (with a 4-digit year) at the start of `s`: 10/31/2026, Oct 31, 2026, October 31st 2026, 31 October 2026, 2026-10-31. */
export function parseFullDate(s: string): string | null {
  const t = s.trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(t);
  if (m) return iso(Number(m[3]), Number(m[1]), Number(m[2]));
  m = /^(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^([a-z]{3,9}\.?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i.exec(t);
  if (m && monthOf(m[1])) return iso(Number(m[3]), monthOf(m[1])!, Number(m[2]));
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9}\.?),?\s+(\d{4})\b/i.exec(t);
  if (m && monthOf(m[2])) return iso(Number(m[3]), monthOf(m[2])!, Number(m[1]));
  return null;
}

/** An explicitly stated end of the promotion ("ends 10/31/2026", "through Oct 31, 2026", "offer valid until …"); dates without a year are ignored. Several different dates: none. */
export function statedEndDate(text: string): string | null {
  const found = new Set<string>();
  for (const m of text.matchAll(END_KEYWORD)) {
    const rest = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 50);
    const d = parseFullDate(rest) ?? parseFullDate(rest.replace(/^(?:mon|tue|tues|wed|wednes|thu|thur|thurs|fri|sat|satur|sun)(?:day)?\.?,?\s+/i, ""));
    if (d) found.add(d);
  }
  return found.size === 1 ? [...found][0] : null;
}

/** What a line says beyond prices and price labels ("Sale price $999" says nothing more). */
const promoWords = (l: string) =>
  l
    .replace(MONEY_RE, " ")
    .replace(/\b(sale|regular|reg|was|now|price|from|unit|per|each|compare|at|original)\b/gi, " ")
    .replace(/[^a-z0-9%]+/gi, "");

const PROMO = /(\bsave\b|%\s*off|\boff\b|\bsale\b|\bdeal\b|\bends?\b|\bthrough\b|\buntil\b|\blimited[\s-]time\b|\bdiscount\b)/i;

// ── Block evaluation ─────────────────────────────────────────────────────────

/**
 * Evaluates the collected price blocks against the structured current price. Returns the accepted
 * previous price (if any), the stated end date and promotion text of the matching block.
 */
export function evaluatePriceBlocks(blocks: unknown, current: { price: number | null | undefined; currency: string | null | undefined }): PriceBlockResult {
  const reasons: string[] = [];
  const list = Array.isArray(blocks) ? (blocks.filter((b) => b && typeof b === "object") as RawPriceBlock[]) : [];
  const price = typeof current.price === "number" && current.price > 0 ? current.price : null;
  if (!list.length) return { matched: false, reasons: ["no price block"] };
  if (price == null || !current.currency) return { matched: false, reasons: ["no structured current price and currency to compare with"] };

  let matched = false;
  const accepted = new Map<number, { type: HtmlListPriceType; label?: string }>();
  const ends = new Set<string>();
  let promotionText: string | undefined;
  for (const b of list) {
    const text = clean(b.text).slice(0, 2000);
    if (!text) continue;
    // The current price must be shown as the current price: an amount that also appears as a marked
    // previous price (struck through, "Regular price" …) in this block does not count as the current one.
    const previous = new Set<number>();
    for (const c of Array.isArray(b.comparisons) ? b.comparisons : []) {
      const toks = c && typeof c === "object" ? moneyTokens(clean(c.text)) : [];
      if (new Set(toks.map((t) => t.amount)).size === 1) previous.add(toks[0].amount);
    }
    const tokens = moneyTokens(text);
    if (!tokens.some((t) => sameAmount(t.amount, price) && sameCurrency(t.currency, current.currency) && ![...previous].some((a) => sameAmount(a, price)))) {
      reasons.push(tokens.some((t) => sameAmount(t.amount, price)) ? "the structured current price is shown only as a previous price" : "block does not show the structured current price");
      continue;
    }
    matched = true;
    const end = statedEndDate(text);
    if (end) ends.add(end);
    if (!promotionText) {
      const line = (typeof b.text === "string" ? b.text : "").split(/\n+/).map(clean).find((l) => l.length <= 200 && PROMO.test(l) && promoWords(l).length >= 3);
      if (line) promotionText = line;
    }
    for (const c of Array.isArray(b.comparisons) ? b.comparisons : []) {
      if (!c || typeof c !== "object") continue;
      const ctext = clean(c.text);
      const label = labelOf(c);
      if (!ctext || !text.includes(ctext)) {
        reasons.push("comparison text is not inside the price block");
        continue;
      }
      if (MSRP.test(label)) {
        reasons.push(`MSRP/suggested price is not a previous price (${ctext.slice(0, 60)})`);
        continue;
      }
      const amounts = [...new Set(moneyTokens(ctext).map((t) => `${t.amount}|${t.currency}`))];
      if (amounts.length !== 1) {
        reasons.push(amounts.length ? `comparison states ${amounts.length} amounts` : `comparison has no amount with a currency (${ctext.slice(0, 60)})`);
        continue;
      }
      const tok = moneyTokens(ctext)[0];
      if (!sameCurrency(tok.currency, current.currency)) {
        reasons.push(`comparison currency ${tok.currency} is not ${current.currency}`);
        continue;
      }
      if (!(tok.amount > price) || sameAmount(tok.amount, price)) {
        reasons.push(`comparison ${tok.amount} is not above the current price ${price}`);
        continue;
      }
      if (tok.amount > price * MAX_RATIO) {
        reasons.push(`comparison ${tok.amount} is more than ${MAX_RATIO}× the current price`);
        continue;
      }
      const type = comparisonType(c, label);
      if (!type) {
        reasons.push("comparison is not marked as a previous price");
        continue;
      }
      const prev = accepted.get(tok.amount);
      // A struck-through amount is the strongest statement; keep it when the same amount is also labelled.
      if (!prev || (type === "StrikethroughPrice" && prev.type !== "StrikethroughPrice")) accepted.set(tok.amount, { type, label: displayLabel(c) ?? prev?.label });
      else if (!prev.label) prev.label = displayLabel(c);
    }
  }
  const out: PriceBlockResult = { matched, reasons };
  if (ends.size === 1) out.priceValidUntil = [...ends][0];
  if (promotionText) out.promotionText = promotionText;
  if (accepted.size > 1) {
    reasons.push(`ambiguous: ${accepted.size} different previous prices (${[...accepted.keys()].join(", ")})`);
    return out;
  }
  if (accepted.size === 1) {
    const [[amount, a]] = [...accepted.entries()];
    out.listPrice = amount;
    out.listPriceType = a.type;
    if (a.label) out.listPriceLabel = a.label;
    out.confidence = HTML_PRICE_CONFIDENCE;
  }
  return out;
}
