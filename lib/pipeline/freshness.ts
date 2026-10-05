/**
 * External-content freshness. Only the SOURCE's own dates count: its published date and its
 * updated/modified date (the newer of the two). Crawl, ingest, insert and API-response times are
 * never freshness dates. Keyword-to-Blog output is generated, not sourced, and is exempt.
 *
 *   FRESH        newest source date is at most FRESHNESS_MAX_DAYS (default 7) whole days old
 *   STALE        older than that
 *   UNKNOWN      the source gave no date at all (never assumed recent)
 *   INVALID_DATE a date was given but cannot be parsed, or is implausibly in the future
 *
 * Age is counted in whole elapsed UTC days (floor), so "published 7 days ago" (7.x days) is
 * accepted and "8 days ago" is not, regardless of the viewer's time zone.
 */
export type FreshnessStatus = "FRESH" | "STALE" | "UNKNOWN" | "INVALID_DATE";
export type Freshness = { status: FreshnessStatus; ageDays: number | null; basis: "published" | "updated" | null; date: Date | null };

const DAY_MS = 86_400_000;
/** Source clocks and time zones may run slightly ahead of ours. */
const FUTURE_TOLERANCE_MS = DAY_MS;

export function freshnessMaxDays(): number {
  const n = Number(process.env.FRESHNESS_MAX_DAYS);
  return Number.isFinite(n) && n >= 1 && n <= 36_500 ? Math.floor(n) : 7;
}

function parse(value: unknown): Date | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  const d = value instanceof Date ? value : new Date(typeof value === "number" ? value : String(value));
  return Number.isNaN(d.getTime()) ? "invalid" : d;
}

export function evaluateFreshness(input: { publishedAt?: unknown; updatedAt?: unknown }, now = new Date(), maxDays = freshnessMaxDays()): Freshness {
  const published = parse(input.publishedAt);
  const updated = parse(input.updatedAt);
  const valid = [
    ...(published instanceof Date ? [{ d: published, basis: "published" as const }] : []),
    ...(updated instanceof Date ? [{ d: updated, basis: "updated" as const }] : []),
  ].filter((x) => x.d.getTime() <= now.getTime() + FUTURE_TOLERANCE_MS);
  if (!valid.length) {
    const anyGiven = published !== null || updated !== null;
    return { status: anyGiven ? "INVALID_DATE" : "UNKNOWN", ageDays: null, basis: null, date: null };
  }
  const newest = valid.reduce((a, b) => (b.d > a.d ? b : a));
  const ageDays = Math.max(0, Math.floor((now.getTime() - newest.d.getTime()) / DAY_MS));
  return { status: ageDays <= maxDays ? "FRESH" : "STALE", ageDays, basis: newest.basis, date: newest.d };
}

/**
 * Exempt: generated Keyword-to-Blog posts (no source date to judge) and the one-off import of
 * our own previously published legacy reviews (not external ingestion).
 */
export function freshnessExempt(source: string): boolean {
  return source === "keyword-to-blog" || source === "legacy";
}

export const FRESHNESS_CODES: Record<Exclude<FreshnessStatus, "FRESH">, string> = {
  STALE: "FRESHNESS_STALE",
  UNKNOWN: "FRESHNESS_UNKNOWN",
  INVALID_DATE: "FRESHNESS_INVALID_DATE",
};

export function freshnessReason(f: Freshness, maxDays = freshnessMaxDays()): string {
  if (f.status === "STALE") return `Source ${f.basis} date ${f.date?.toISOString().slice(0, 10)} is ${f.ageDays} days old (limit ${maxDays}); not published automatically`;
  if (f.status === "UNKNOWN") return "The source gave no published or updated date; freshness cannot be proven, so it is not published automatically";
  if (f.status === "INVALID_DATE") return "The source date is unparseable or in the future; not published automatically";
  return `Fresh: source ${f.basis} date is ${f.ageDays} days old`;
}
