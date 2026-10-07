import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { hostAllowed, normalizeUrl } from "@/lib/pipeline/apify";
import { commerceAudit } from "./audit";
import { CODE_SHAPE, findCodesInText } from "./page-functions/coupon";

/**
 * Coupons from brands' own official promotions pages.
 *
 * normalizeCoupons turns one page's raw evidence (lib/commerce/page-functions/coupon.ts) into
 * coupon records using only what the page states: the discount text is quoted as written, a
 * discount type is set only when that text says so, and a start/expiry date only when the page
 * states a full, parseable date. verifyCoupon decides the status from first-party evidence;
 * upsertCoupons and recordDisappearances write it. Rows are never deleted.
 */

export const COUPON_STATUSES = ["VERIFIED", "UNVERIFIED", "EXPIRED", "INVALID", "CONFLICTING", "UNKNOWN"] as const;
export type CouponStatus = (typeof COUPON_STATUSES)[number];
export type DiscountType = "PERCENT" | "AMOUNT" | "FREE_SHIPPING" | "OTHER";

export type CouponCandidate = { code: string; context: string; element: string; expiresText?: string; discountText?: string };
export type CouponRawPage = { m4bCoupon: 1; url: string; title: string | null; candidates: CouponCandidate[]; jsonLd: unknown[] };
export type CouponBrand = { id?: string | null; name: string; officialDomain: string; market?: string | null };

export type NormalizedCoupon = {
  merchant: string;
  code: string;
  title: string | null;
  description: string | null;
  discount: string | null;
  discountType: DiscountType | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  eligibility: string | null;
  restrictions: string | null;
  sourceUrl: string;
  merchantUrl: string | null;
  /** The page is on the brand's own official domain. */
  firstParty: boolean;
  /** How the code was marked: an explicit promo-code element/attribute, a "Use code X" phrase, or JSON-LD. */
  evidence: "MARKED" | "TEXT" | "JSONLD";
  /** The surrounding evidence actually presents it as a promotion (otherwise the status is UNKNOWN). */
  sufficient: boolean;
  /** Set when two observations of the same code in one crawl disagree on discount or expiry. */
  conflict: string | null;
};

export type NormalizeResult = { coupons: NormalizedCoupon[]; dropped: Array<{ code: string; reason: string }> };

// ── Raw shape ────────────────────────────────────────────────────────────

const s = (v: unknown, max = 300) => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, max) : undefined);

/** Validates a dataset item produced by COUPON_PAGE_FUNCTION; anything else is null. */
export function parseCouponPage(item: unknown): CouponRawPage | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  if (o.m4bCoupon !== 1 || !s(o.url, 2000)) return null;
  const candidates: CouponCandidate[] = [];
  for (const c of Array.isArray(o.candidates) ? o.candidates.slice(0, 50) : []) {
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, unknown>;
    const code = s(r.code, 40);
    if (!code) continue;
    candidates.push({ code, context: s(r.context) ?? "", element: s(r.element) ?? "", ...(s(r.expiresText, 120) ? { expiresText: s(r.expiresText, 120) } : {}), ...(s(r.discountText, 120) ? { discountText: s(r.discountText, 120) } : {}) });
  }
  return { m4bCoupon: 1, url: s(o.url, 2000)!, title: s(o.title) ?? null, candidates, jsonLd: Array.isArray(o.jsonLd) ? o.jsonLd.slice(0, 20) : [] };
}

// ── Codes ────────────────────────────────────────────────────────────────

/** Words that appear next to "code" on promo pages but are never codes themselves. */
const NOT_CODES = new Set(
  (
    "CODE CODES PROMO PROMOS COUPON COUPONS DISCOUNT OFFER OFFERS DEAL DEALS SALE SALES SAVE SAVING SAVINGS FREE SHOP NOW OFF ONLY " +
    "APPLY APPLIED ENTER USE USED HERE BELOW ABOVE CHECKOUT CART BAG TERMS DETAILS EXCLUSIONS VALID INVALID EXPIRED SHIPPING DELIVERY " +
    "ORDER ORDERS NONE NULL UNDEFINED TRUE FALSE NAN COPY COPIED REVEAL SHOW HIDE GET CLICK LEARN MORE SIGNUP SIGN LOGIN EMAIL " +
    "NEWSLETTER REQUIRED NEEDED AUTOMATIC AUTOMATICALLY ONLINE STORE STORES TODAY LIMITED TIME WITH YOUR THIS THAT FROM WHEN " +
    "SUBMIT SEARCH MENU CLOSE OPEN CANCEL CONTINUE NEXT BACK HOME HELP INFO ITEM ITEMS PRICE PRICES TOTAL MEMBER MEMBERS " +
    "STUDENT STUDENTS MILITARY ZIP POSTAL PIN PASSWORD USERNAME ACCOUNT GIFT CARD CARDS HTML JSON NEW"
  ).split(" "),
);

/** Uppercase CSS class / utility / unit tokens (BTN-PRIMARY, COL-MD-6, 100PX, FFFFFF …). */
const CLASS_LIKE = [/^(?:BTN|COL|ROW|JS|IS|HAS|MT|MB|ML|MR|PT|PB|PL|PR|PX|PY|MX|MY|ICON|FA|TEXT|BG|FLEX|GRID|NAV|CSS|SVG|IMG|H|W)-/, /^\d+(?:PX|EM|REM|VH|VW|PT|MS|DPI)$/, /^([A-Z0-9])\1+$/];

/** Why a token is not a promo code, or null when it plausibly is one. */
export function notACodeReason(code: string): string | null {
  if (!CODE_SHAPE.test(code)) return "not 4–20 uppercase letters, digits or dashes with a letter";
  if (code.includes("--")) return "malformed";
  if (NOT_CODES.has(code)) return "common word";
  if (CLASS_LIKE.some((re) => re.test(code))) return "CSS/class-like token";
  return null;
}

// ── Stated facts (quoted, never inferred) ─────────────────────────────────

const DISCOUNT_PATTERNS: Array<{ re: RegExp; type: DiscountType }> = [
  { re: /\b(?:save\s+)?(?:up\s+to\s+)?\d{1,3}(?:\.\d+)?\s?%\s*off\b/gi, type: "PERCENT" },
  { re: /\bsave\s+(?:(?:an\s+)?(?:extra|additional)\s+)?(?:up\s+to\s+)?\d{1,3}(?:\.\d+)?\s?%/gi, type: "PERCENT" },
  { re: /(?:\bsave\s+(?:(?:an\s+)?(?:extra|additional)\s+)?(?:up\s+to\s+)?)?(?:[$£€]\s?\d[\d,]*(?:\.\d{2})?|\b\d[\d,]*(?:\.\d{2})?\s?(?:USD|dollars))\s*off\b/gi, type: "AMOUNT" },
  { re: /\bsave\s+(?:(?:an\s+)?(?:extra|additional)\s+)?(?:up\s+to\s+)?[$£€]\s?\d[\d,]*(?:\.\d{2})?/gi, type: "AMOUNT" },
  { re: /\bfree\s+(?:standard\s+|ground\s+|2-day\s+|two-day\s+|express\s+|next-day\s+)?(?:shipping|delivery)\b/gi, type: "FREE_SHIPPING" },
  { re: /\b(?:buy\s+one,?\s+get\s+one(?:\s+free|\s+\d{1,3}\s?%\s*off)?|BOGO|free\s+gift(?:\s+with\s+(?:any\s+)?purchase)?)\b/gi, type: "OTHER" },
];

/** The discount the text states nearest to the code, exactly as written, and its type. */
export function statedDiscount(text: string, code?: string): { discount: string; type: DiscountType } | null {
  const at = code ? text.indexOf(code) : -1;
  let best: { discount: string; type: DiscountType; dist: number } | null = null;
  for (const { re, type } of DISCOUNT_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const i = m.index ?? 0;
      const dist = at < 0 ? i : Math.min(Math.abs(i - at), Math.abs(i + m[0].length - at));
      if (!best || dist < best.dist) best = { discount: m[0].trim(), type, dist };
    }
  }
  return best ? { discount: best.discount, type: best.type } : null;
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const MONTH = String.raw`(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)`;
const DATE_FORMS: Array<{ re: RegExp; ymd: (m: RegExpMatchArray, market: string) => [number, number, number] | null }> = [
  { re: /\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?)?\b/, ymd: (m) => [+m[1], +m[2] - 1, +m[3]] },
  { re: new RegExp(String.raw`\b${MONTH}\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b`, "i"), ymd: (m) => [+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]] },
  { re: new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH}\.?,?\s+(\d{4})\b`, "i"), ymd: (m) => [+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]] },
  {
    re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/,
    ymd: (m, market) => {
      const a = +m[1];
      const b = +m[2];
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      // Numeric dates are read month-first only for the US market; elsewhere only when unambiguous.
      if (market === "US") return [y, a - 1, b];
      if (a > 12) return [y, b - 1, a];
      if (b > 12 || a === b) return [y, a - 1, b];
      return null;
    },
  },
];

/** A full date (with a year) stated at the start of `text`; null when absent, partial or impossible. */
export function parseStatedDate(text: string, { endOfDay = false, market = "US" }: { endOfDay?: boolean; market?: string } = {}): Date | null {
  let found: { index: number; date: Date } | null = null;
  for (const form of DATE_FORMS) {
    const m = text.match(form.re);
    if (!m || (found && (m.index ?? 0) >= found.index)) continue;
    // An ISO timestamp with a time is taken as stated.
    if (form === DATE_FORMS[0] && m[4]) {
      const d = new Date(m[0].replace(" ", "T") + (m[7] ? "" : "Z"));
      if (!Number.isNaN(d.getTime())) found = { index: m.index ?? 0, date: d };
      continue;
    }
    const ymd = form.ymd(m, market);
    if (!ymd) continue;
    const [y, mo, d] = ymd;
    if (y < 2000 || y > 2100 || mo < 0 || mo > 11 || d < 1 || d > 31) continue;
    const date = new Date(Date.UTC(y, mo, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0));
    if (date.getUTCMonth() !== mo || date.getUTCDate() !== d) continue; // 31 Feb etc.
    found = { index: m.index ?? 0, date };
  }
  return found?.date ?? null;
}

const EXPIRY_WORDS = /\b(?:expires?|expiring|expiration(?:\s+date)?|exp\.|ends?|ending|valid\s+(?:through|thru|until|till|to)|good\s+(?:through|thru|until)|through|thru|until|till)\b\s*(?:on\s+)?:?/gi;
const START_WORDS = /\b(?:starts?|starting|begins?|beginning|valid\s+from|available\s+from|effective(?:\s+from)?|from)\b\s*(?:on\s+)?:?/gi;

/** The date a keyword ("Expires", "Valid through", "Starts" …) introduces, within 40 characters. */
function dateAfter(text: string, words: RegExp, opts: { endOfDay: boolean; market: string }): Date | null {
  for (const m of text.matchAll(words)) {
    const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 40);
    const d = parseStatedDate(after, opts);
    if (d) return d;
  }
  return null;
}

export function statedExpiry(text: string, market = "US"): Date | null {
  return dateAfter(text, EXPIRY_WORDS, { endOfDay: true, market });
}
export function statedStart(text: string, market = "US"): Date | null {
  return dateAfter(text, START_WORDS, { endOfDay: false, market });
}

const sentences = (text: string) => text.split(/(?<=[.!?;])\s+|\s+[|•·]\s+/).map((x) => x.trim()).filter(Boolean);
const ELIGIBILITY = /\b(?:new\s+customers?|first[-\s](?:time\s+)?(?:order|purchase|customers?)|members?\s+only|for\s+members|students?|military|teachers?|on\s+orders?\s+(?:of|over|above)\s+[$£€]?\s?\d|minimum\s+(?:purchase|order|spend)|when\s+you\s+spend|subscribers?)\b/i;
const RESTRICTIONS = /\b(?:exclusions?\s+apply|excludes?|excluding|not\s+valid|cannot\s+be\s+combined|can't\s+be\s+combined|not\s+combinable|one\s+(?:use\s+)?per\s+(?:customer|order|household)|while\s+supplies\s+last|limit\s+\d|limited\s+to|restrictions?\s+apply|select(?:ed)?\s+(?:items|styles|products)\s+only)\b/i;
const PROMO_WORDS = /promo|coupon|code|discount|\boff\b|save|offer|deal|checkout|free\s+shipping/i;

function statedSentence(text: string, re: RegExp): string | null {
  const hit = sentences(text).find((x) => re.test(x));
  return hit ? hit.slice(0, 200) : null;
}

function nodeTypes(n: Record<string, unknown>): string[] {
  return ([] as unknown[]).concat(n["@type"] ?? []).map((t) => String(t).toLowerCase());
}

// ── Normalization ────────────────────────────────────────────────────────

type Draft = Omit<NormalizedCoupon, "conflict"> & { conflict: string | null };

/** Builds coupon records from one page's raw evidence. Pure. */
export function normalizeCoupons(rawInput: unknown, brand: CouponBrand): NormalizeResult {
  const raw = parseCouponPage(rawInput);
  const dropped: NormalizeResult["dropped"] = [];
  if (!raw) return { coupons: [], dropped: [{ code: "", reason: "not a Made4Buyers coupon page item" }] };
  const sourceUrl = normalizeUrl(raw.url) ?? raw.url;
  const firstParty = hostAllowed(sourceUrl, [brand.officialDomain]);
  let merchantUrl: string | null = null;
  try {
    merchantUrl = firstParty ? new URL(sourceUrl).origin : `https://${brand.officialDomain.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`;
  } catch {
    merchantUrl = null;
  }
  const market = brand.market ?? "US";
  const byCode = new Map<string, Draft>();

  const add = (code: string, d: Omit<Draft, "merchant" | "code" | "sourceUrl" | "merchantUrl" | "firstParty" | "conflict">) => {
    const reason = notACodeReason(code);
    if (reason) {
      if (!dropped.some((x) => x.code === code)) dropped.push({ code, reason });
      return;
    }
    const prev = byCode.get(code);
    if (!prev) {
      byCode.set(code, { merchant: brand.name, code, sourceUrl, merchantUrl, firstParty, conflict: null, ...d });
      return;
    }
    // Same code stated twice on the page: fill gaps; disagreement on what it gives or when it ends is a conflict.
    const clash: string[] = [];
    if (prev.discount && d.discount && prev.discount.toLowerCase() !== d.discount.toLowerCase()) clash.push(`discount "${prev.discount}" vs "${d.discount}"`);
    if (prev.expiresAt && d.expiresAt && prev.expiresAt.getTime() !== d.expiresAt.getTime()) clash.push(`expiry ${prev.expiresAt.toISOString()} vs ${d.expiresAt.toISOString()}`);
    if (clash.length && !prev.conflict) prev.conflict = `${sourceUrl} states ${clash.join("; ")}`;
    for (const k of ["title", "description", "discount", "discountType", "startsAt", "expiresAt", "eligibility", "restrictions"] as const) if (prev[k] == null && d[k] != null) (prev as Record<string, unknown>)[k] = d[k];
    if (!prev.sufficient && d.sufficient) {
      prev.sufficient = true;
      prev.evidence = d.evidence;
    }
  };

  for (const c of raw.candidates) {
    const code = c.code.replace(/^["“'‘]+|["”'’.,;:!]+$/g, "");
    const context = c.context;
    // The discount and dates come from the page's own words around the code; the page function's hints are a fallback.
    const disc = statedDiscount(context, code) ?? (c.discountText ? statedDiscount(c.discountText) : null);
    const expiresAt = statedExpiry(context, market) ?? (c.expiresText ? statedExpiry(c.expiresText, market) : null);
    const textual = findCodesInText(context).includes(code);
    const marked = /data-(?:code|promo|coupon|discount)|input/i.test(c.element);
    const titleSentence = sentences(context).find((x) => x.includes(code)) ?? null;
    add(code, {
      title: titleSentence ? titleSentence.slice(0, 160) : null,
      description: context || null,
      discount: disc?.discount ?? null,
      discountType: disc?.type ?? null,
      startsAt: statedStart(context, market),
      expiresAt,
      eligibility: statedSentence(context, ELIGIBILITY),
      restrictions: statedSentence(context, RESTRICTIONS),
      evidence: textual ? "TEXT" : marked ? "MARKED" : "TEXT",
      sufficient: textual || (marked && PROMO_WORDS.test(context)),
    });
  }

  // JSON-LD offers: only an explicitly named code field, or a "Use code X" phrase in the offer's own text.
  for (const node of raw.jsonLd) {
    if (!node || typeof node !== "object") continue;
    const n = node as Record<string, unknown>;
    if (!nodeTypes(n).some((t) => /offer|promotion|saleevent|discount/.test(t))) continue;
    const name = s(n.name, 200) ?? null;
    const text = [name, s(n.description, 600)].filter(Boolean).join(". ");
    const fieldCodes = ["couponCode", "promoCode", "promotionCode", "discountCode", "code"].map((k) => s(n[k], 40)).filter((x): x is string => Boolean(x));
    const codes = [...new Set([...fieldCodes, ...findCodesInText(text)])];
    const iso = (v: unknown, endOfDay: boolean) => {
      const t = s(v, 40);
      return t ? parseStatedDate(t, { endOfDay, market }) : null;
    };
    const disc = statedDiscount(text);
    for (const code of codes) {
      add(code, {
        title: name,
        description: s(n.description) ?? null,
        discount: disc?.discount ?? null,
        discountType: disc?.type ?? null,
        startsAt: iso(n.validFrom, false) ?? iso(n.startDate, false),
        expiresAt: iso(n.validThrough, true) ?? iso(n.endDate, true),
        eligibility: statedSentence(text, ELIGIBILITY),
        restrictions: statedSentence(text, RESTRICTIONS),
        evidence: "JSONLD",
        sufficient: true,
      });
    }
  }
  return { coupons: [...byCode.values()], dropped };
}

/** The same code published on two first-party pages of one crawl with different terms → conflict on both. */
export function markCrossPageConflicts(coupons: NormalizedCoupon[]): NormalizedCoupon[] {
  const groups = new Map<string, NormalizedCoupon[]>();
  for (const c of coupons) if (c.firstParty) groups.set(`${c.merchant}|${c.code}`, [...(groups.get(`${c.merchant}|${c.code}`) ?? []), c]);
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const discounts = new Set(list.map((c) => c.discount?.toLowerCase()).filter(Boolean));
    const expiries = new Set(list.map((c) => c.expiresAt?.getTime()).filter((x) => x !== undefined));
    if (discounts.size > 1 || expiries.size > 1) {
      const note = `Official pages disagree: ${list.map((c) => `${c.sourceUrl} (${c.discount ?? "no discount stated"}${c.expiresAt ? `, ends ${c.expiresAt.toISOString().slice(0, 10)}` : ""})`).join(" vs ")}`;
      for (const c of list) c.conflict ??= note;
    }
  }
  return coupons;
}

// ── Verification ─────────────────────────────────────────────────────────

export type CouponObservation = {
  firstParty: boolean;
  /** The code was found on its source page in the latest crawl of that page. */
  seenInLatestCrawl: boolean;
  sufficient: boolean;
  conflict: string | null;
  expiresAt: Date | null;
  /** Consecutive crawls of the source page, since the code was last seen, that did not contain it. */
  consecutiveMisses: number;
  previousStatus?: string | null;
  sourceUrl: string;
  observedAt: Date;
};

/**
 * Status rules. `evidence` undefined means "keep the stored evidence" (a single missed crawl).
 *   EXPIRED      the stated expiry has passed
 *   INVALID      gone from the official page on 2 consecutive crawls
 *   CONFLICTING  first-party observations disagree on discount or expiry
 *   UNVERIFIED   not first-party (third-party page)
 *   UNKNOWN      first-party, but the evidence does not present it as a promotion
 *   VERIFIED     on the brand's official page in the latest crawl and not expired
 */
export function verifyCoupon(o: CouponObservation, now = new Date()): { status: CouponStatus; evidence?: string } {
  if (o.expiresAt && o.expiresAt.getTime() < now.getTime()) return { status: "EXPIRED", evidence: `Expiry stated on ${o.sourceUrl} (${o.expiresAt.toISOString()}) has passed` };
  if (!o.seenInLatestCrawl && o.consecutiveMisses >= 2) return { status: "INVALID", evidence: `No longer published on ${o.sourceUrl}: absent from ${o.consecutiveMisses} consecutive crawls (checked ${now.toISOString()})` };
  if (!o.seenInLatestCrawl) {
    // One missed crawl is not yet proof it was withdrawn: keep what we had.
    const prev = COUPON_STATUSES.find((x) => x === o.previousStatus);
    return { status: prev ?? "UNKNOWN" };
  }
  if (o.conflict) return { status: "CONFLICTING", evidence: o.conflict };
  if (!o.firstParty) return { status: "UNVERIFIED", evidence: `Seen on ${o.sourceUrl}, a page not on the merchant's official domain; not confirmed by the merchant` };
  if (!o.sufficient) return { status: "UNKNOWN", evidence: `Found on ${o.sourceUrl} at ${o.observedAt.toISOString()}, but the page does not present it as a promotion` };
  return { status: "VERIFIED", evidence: `Published on ${o.sourceUrl} at ${o.observedAt.toISOString()}` };
}

// ── Persistence ──────────────────────────────────────────────────────────

/** Evidence prefix written by Admin → Coupons → Mark invalid. */
export const ADMIN_INVALID_PREFIX = "Marked invalid by ";

export type UpsertSummary = { created: number; updated: number; statuses: Partial<Record<CouponStatus, number>>; /** Rows created or whose status changed. */ changed: number };

/** COUPON_EXPIRED / COUPON_INVALIDATED for a real status change (no event for an unchanged observation). */
async function auditStatusChange(id: string, code: string, from: string | null | undefined, to: string, evidence?: string | null) {
  if (from === to) return;
  const action = to === "EXPIRED" ? "COUPON_EXPIRED" : to === "INVALID" ? "COUPON_INVALIDATED" : null;
  if (action) await commerceAudit(action, "commerce_coupon", id, { before: { status: from ?? null }, after: { status: to }, metadata: { code, evidence: evidence ?? null } });
}

/** Writes coupons observed in one crawl (unique merchant+code+sourceUrl). Never deletes. */
export async function upsertCoupons(input: { brandId: string | null; coupons: NormalizedCoupon[]; observedAt: Date; rawIds?: Record<string, string>; now?: Date }): Promise<UpsertSummary> {
  const now = input.now ?? new Date();
  const out: UpsertSummary = { created: 0, updated: 0, statuses: {}, changed: 0 };
  for (const c of input.coupons) {
    const where = { merchant_code_sourceUrl: { merchant: c.merchant, code: c.code, sourceUrl: c.sourceUrl } };
    const existing = await db.commerceCoupon.findUnique({ where, select: { id: true, status: true, verificationEvidence: true } });
    // An admin's "mark invalid" is final: later sightings update the observation, not the verdict.
    const adminInvalid = existing?.status === "INVALID" && (existing.verificationEvidence ?? "").startsWith(ADMIN_INVALID_PREFIX);
    const v = adminInvalid ? { status: "INVALID" as const, evidence: existing.verificationEvidence! } : verifyCoupon({ firstParty: c.firstParty, seenInLatestCrawl: true, sufficient: c.sufficient, conflict: c.conflict, expiresAt: c.expiresAt, consecutiveMisses: 0, previousStatus: existing?.status, sourceUrl: c.sourceUrl, observedAt: input.observedAt }, now);
    // The latest observation is what the page says now: stated fields are replaced, including with null.
    const data = {
      brandId: input.brandId,
      title: c.title,
      description: c.description,
      discount: c.discount,
      discountType: c.discountType,
      startsAt: c.startsAt,
      expiresAt: c.expiresAt,
      eligibility: c.eligibility,
      restrictions: c.restrictions,
      merchantUrl: c.merchantUrl,
      status: v.status,
      verificationEvidence: v.evidence ?? null,
      observedAt: input.observedAt,
      sourceRawId: input.rawIds?.[c.sourceUrl] ?? null,
      ...(v.status === "VERIFIED" ? { lastVerifiedAt: input.observedAt } : {}),
    } satisfies Prisma.CommerceCouponUncheckedUpdateInput;
    if (existing) {
      await db.commerceCoupon.update({ where: { id: existing.id }, data });
      out.updated++;
      if (existing.status !== v.status) out.changed++;
      await auditStatusChange(existing.id, c.code, existing.status, v.status, v.evidence);
    } else {
      const row = await db.commerceCoupon.create({ data: { ...data, merchant: c.merchant, code: c.code, sourceUrl: c.sourceUrl, firstSeenAt: input.observedAt } });
      out.created++;
      out.changed++;
      await commerceAudit("COUPON_CREATED", "commerce_coupon", row.id, { after: { status: v.status }, metadata: { merchant: c.merchant, code: c.code, sourceUrl: c.sourceUrl, discount: c.discount, expiresAt: c.expiresAt?.toISOString() ?? null } });
    }
    out.statuses[v.status] = (out.statuses[v.status] ?? 0) + 1;
  }
  return out;
}

/**
 * Codes previously seen on `sourceUrl` that this crawl of the page did not contain. The number
 * of consecutive misses is the number of stored crawls of the page since the code was last seen
 * (a page that was not fetched is not a miss). Two misses → INVALID; the row is kept.
 */
export async function recordDisappearances(input: { merchant: string; sourceUrl: string; presentCodes: string[]; now?: Date }): Promise<{ missed: number; invalid: number }> {
  const now = input.now ?? new Date();
  const gone = await db.commerceCoupon.findMany({ where: { merchant: input.merchant, sourceUrl: input.sourceUrl, code: { notIn: input.presentCodes }, status: { notIn: ["INVALID", "EXPIRED"] } } });
  let invalid = 0;
  for (const c of gone) {
    const misses = await db.commerceRawRecord.count({ where: { url: input.sourceUrl, purpose: "COUPON", fetchedAt: { gt: c.observedAt } } });
    const v = verifyCoupon({ firstParty: true, seenInLatestCrawl: false, sufficient: true, conflict: null, expiresAt: c.expiresAt, consecutiveMisses: misses, previousStatus: c.status, sourceUrl: c.sourceUrl, observedAt: c.observedAt }, now);
    if (v.status !== c.status || v.evidence) {
      await db.commerceCoupon.update({ where: { id: c.id }, data: { status: v.status, ...(v.evidence ? { verificationEvidence: v.evidence } : {}) } });
      if (v.status === "INVALID") invalid++;
      await auditStatusChange(c.id, c.code, c.status, v.status, v.evidence);
    }
  }
  return { missed: gone.length, invalid };
}

/** Marks every coupon whose stated expiry has passed as EXPIRED (rows kept; one COUPON_EXPIRED event each). */
export async function markExpiredCoupons(now = new Date()): Promise<number> {
  const due = await db.commerceCoupon.findMany({ where: { expiresAt: { lt: now }, status: { not: "EXPIRED" } }, select: { id: true, code: true, status: true, expiresAt: true } });
  let count = 0;
  for (const c of due) {
    // Conditional update: a concurrent run that already expired it does not produce a second event.
    const r = await db.commerceCoupon.updateMany({ where: { id: c.id, status: c.status }, data: { status: "EXPIRED" } });
    if (!r.count) continue;
    count++;
    await auditStatusChange(c.id, c.code, c.status, "EXPIRED", `stated expiry ${c.expiresAt?.toISOString()} has passed`);
  }
  return count;
}

/** Days a VERIFIED code stays displayable without being re-seen on the official page (COMMERCE_COUPON_MAX_AGE_DAYS, default 7). */
export function couponMaxAgeDays(): number {
  const n = Number(process.env.COMMERCE_COUPON_MAX_AGE_DAYS);
  return Number.isFinite(n) && n >= 1 && n <= 90 ? Math.floor(n) : 7;
}

/** VERIFIED, started, unexpired and recently re-verified coupons for one brand (what the public component shows). */
/** Public coupons: VERIFIED, re-seen within the max age, started and not expired. */
function publicCouponWhere(now: Date) {
  const since = new Date(now.getTime() - couponMaxAgeDays() * 86_400_000);
  return {
    status: "VERIFIED",
    lastVerifiedAt: { gte: since },
    AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, { OR: [{ startsAt: null }, { startsAt: { lte: now } }] }],
  };
}

export async function verifiedCouponsFor(brand: { brandId?: string | null; merchant?: string | null }, now = new Date(), take = 6) {
  if (!brand.brandId && !brand.merchant) return [];
  return db.commerceCoupon.findMany({
    where: { ...publicCouponWhere(now), ...(brand.brandId ? { brandId: brand.brandId } : { merchant: brand.merchant! }) },
    orderBy: [{ lastVerifiedAt: "desc" }],
    take,
  });
}

/** Public coupons for many brands in ONE query (at most `perBrand` each, newest first). */
export async function verifiedCouponsForBrands(brandIds: string[], now = new Date(), perBrand = 6) {
  if (!brandIds.length) return new Map<string, Awaited<ReturnType<typeof verifiedCouponsFor>>>();
  const rows = await db.commerceCoupon.findMany({ where: { ...publicCouponWhere(now), brandId: { in: brandIds } }, orderBy: [{ lastVerifiedAt: "desc" }], take: 500 });
  const out = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!r.brandId) continue;
    const list = out.get(r.brandId) ?? [];
    if (list.length < perBrand) list.push(r);
    out.set(r.brandId, list);
  }
  return out;
}
