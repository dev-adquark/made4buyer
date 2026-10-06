/**
 * Honest titles: a publisher headline that claims a year newer than any date the source itself
 * gives us ("Best VPN 2026" on a review last dated 2019) misleads readers about freshness. Such a
 * year is removed from the title — never replaced by an invented newer date or year. Body text is
 * never touched. Pure and deterministic.
 *
 * Rules:
 *  - A year is a standalone 19xx/20xx token ("2026", "(2026)", "2026:", "2026's"). Numbers glued
 *    to letters, digits, "-", "/", "." or "%" ("2026-inch", "1080p", "2019/20", "2019-2026") are
 *    not years and are left alone.
 *  - With no source date the title is left alone (we cannot know it is misleading).
 *  - A year ≤ the newest source date's year (published or updated) is kept.
 *  - Years that are part of the product's own name (a model year such as "Kia Telluride 2020")
 *    are protected by passing the product name.
 *  - Keyword-to-Blog posts are exempt (see `titleYearsExempt`) and published exactly as returned.
 */

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
/** Shortest acceptable cleaned title; matches the publish gate's TITLE_TOO_SHORT rule. */
const MIN_TITLE = 8;
const YEAR_TOKEN = /(?<![\p{L}\p{N}\-/.%'’])((?:19|20)\d{2})(?![\p{L}\p{N}\-/%]|[.,]\d)/gu;

export const KEYWORD_TO_BLOG_SOURCE = "keyword-to-blog";

/** Keyword-to-Blog posts (and AI guides) are published exactly as returned. */
export function titleYearsExempt(source: string, kind?: string | null): boolean {
  return source === KEYWORD_TO_BLOG_SOURCE || kind === "AI_GUIDE";
}

/** The newest date the source itself gave us, or null when it gave none. */
export function newestSourceDate(...dates: Array<Date | null | undefined>): Date | null {
  let best: Date | null = null;
  for (const d of dates) if (d instanceof Date && !Number.isNaN(d.getTime()) && (!best || d > best)) best = d;
  return best;
}

/** Standalone year tokens in a title, in order. */
export function titleYears(title: string): number[] {
  return [...title.matchAll(YEAR_TOKEN)].map((m) => Number(m[1]));
}

function protectedYears(protect: Array<string | null | undefined>): Set<number> {
  return new Set(protect.flatMap((p) => (p ? titleYears(p) : [])));
}

/** Years in the title that are newer than the newest source date (empty when none, or undated). */
export function misleadingYears(title: string, sourceDate: Date | null | undefined, protect: Array<string | null | undefined> = []): number[] {
  if (!sourceDate || Number.isNaN(sourceDate.getTime())) return [];
  const limit = sourceDate.getUTCFullYear();
  const keep = protectedYears(protect);
  return [...new Set(titleYears(title))].filter((y) => y > limit && !keep.has(y));
}

function removeYear(title: string, year: number): string {
  const Y = `(?<![\\p{L}\\p{N}\\-/.%'’])${year}(?![\\p{L}\\p{N}\\-/%]|[.,]\\d)`;
  const month = `(?:(?:${MONTHS})\\.?\\s+)?`;
  const lead = `(?:(?:updated|update|tested|reviewed|revised)\\s+)?(?:(?:as\\s+of|in|for|of|from|during|through)\\s+)?(?:the\\s+year\\s+)?`;
  const trail = `(?:['’]s)?(?:\\s+(?:edition|update|updated|version|refresh))?`;
  let t = title;
  // "(2026)", "[Updated October 2026]", "(2026 Update)": a bracket holding only the date goes entirely.
  t = t.replace(new RegExp(`\\s*[(\\[]\\s*${lead}${month}${Y}${trail}\\s*[)\\]]`, "giu"), "");
  // "for 2026", "in October 2026", "of 2026", "as of 2026", "Updated 2026", "2026 Edition", "2026's".
  t = t.replace(new RegExp(`(^|\\s)${lead}${month}${Y}${trail}(?=$|[\\s:;,.!?)\\]|–—-])`, "giu"), "$1");
  // Anything left (e.g. inside a bracket with other words): remove the bare token.
  t = t.replace(new RegExp(Y, "gu"), "");
  return t;
}

function tidy(title: string): string {
  let t = title;
  t = t.replace(/[(\[]\s*[)\]]/g, ""); // emptied brackets
  t = t.replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
  t = t.replace(/\s{2,}/g, " ");
  t = t.replace(/\s+([:;,.!?])/g, "$1"); // "VPN :" → "VPN:"
  // Collapse runs of separators left behind ("VPN - - Tested", "VPN: | Tested", "VPN:: Tested").
  t = t.replace(/\s*([:;,|–—-])(?:\s*[:;,|–—-])+\s*/g, (m, first: string) => (first === ":" || first === ";" || first === "," ? `${first} ` : ` ${first} `));
  // Dangling words and separators at either end ("Best VPN for", "vs", "& 2026" leftovers).
  for (let i = 0; i < 3; i++) {
    t = t.replace(/(?:\s+|^)(?:vs\.?|versus|and|or|&|to|in|for|of|from|the|as\s+of)\s*$/i, "");
    t = t.replace(/^\s*(?:in|for|of|from)\s+(?=\S)/i, "");
    t = t.replace(/[\s:;,|–—-]+$/u, "").replace(/^[\s:;,|–—-]+/u, "");
  }
  return t.replace(/\s{2,}/g, " ").trim();
}

export type HonestTitleResult = { title: string; changed: boolean; removedYears: number[] };

/**
 * Removes years from `title` that are newer than the newest source date. Returns the original
 * title unchanged when nothing is misleading, no source date exists, or cleaning would leave a
 * title too short to stand on its own.
 */
export function honestTitle(title: string, sourceDate: Date | null | undefined, opts: { protect?: Array<string | null | undefined> } = {}): HonestTitleResult {
  const years = misleadingYears(title, sourceDate, opts.protect);
  if (!years.length) return { title, changed: false, removedYears: [] };
  let t = title;
  for (const y of years) t = removeYear(t, y);
  t = tidy(t);
  // Keep the source's capitalization: if the year opened the title, restore an upper-case start.
  if (/^\p{Lu}/u.test(title.replace(/^[^\p{L}]+/u, "")) || /^\s*[(\[]?\s*(?:19|20)\d{2}/.test(title)) t = t.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
  if (t.length < MIN_TITLE || !/\p{L}/u.test(t) || t === title) return { title, changed: false, removedYears: [] };
  return { title: t, changed: true, removedYears: years };
}
