/**
 * Time-zone helpers. Everything is stored in UTC; schedules (publishing slots, keyword
 * frequencies, brand crawl windows) are computed in a named IANA time zone with Intl, so
 * daylight-saving changes are handled by the platform, never by fixed offsets.
 */

export const DEFAULT_BUSINESS_TIMEZONE = "Asia/Kolkata";
const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(tz, f);
  }
  return f;
}

/** A real IANA zone name ("Asia/Kolkata", "America/New_York", "UTC"); offsets and abbreviations are refused. */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length > 64 || !/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** BUSINESS_TIMEZONE (IANA), default Asia/Kolkata. An invalid value falls back to the default. */
export function businessTimezone(): string {
  const tz = (process.env.BUSINESS_TIMEZONE ?? "").trim();
  return tz && isValidTimezone(tz) ? tz : DEFAULT_BUSINESS_TIMEZONE;
}

export type ZonedParts = { day: string; hour: number; minute: number; second: number };

/** The calendar day (YYYY-MM-DD) and wall-clock time of `date` in `tz`. */
export function zonedParts(date: Date, tz: string): ZonedParts {
  const parts = formatter(tz).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24, minute: Number(get("minute")), second: Number(get("second")) };
}

/** Offset of `tz` from UTC at `date`, in ms (IST → +19 800 000). */
function offsetMs(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const [y, m, d] = p.day.split("-").map(Number);
  const asUtc = Date.UTC(y, m - 1, d, p.hour, p.minute, p.second);
  return asUtc - (date.getTime() - (((date.getTime() % 1000) + 1000) % 1000));
}

/** The UTC instant of a wall-clock time on a calendar day in `tz`. */
export function zonedTimeToUtc(day: string, hour: number, minute: number, tz: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  const local = Date.UTC(y, m - 1, d, hour, minute);
  // Two passes settle the offset across a daylight-saving change.
  let utc = local - offsetMs(new Date(local), tz);
  utc = local - offsetMs(new Date(utc), tz);
  return new Date(utc);
}

/** YYYY-MM-DD plus n calendar days. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Whole calendar days from day `a` to day `b` (YYYY-MM-DD). */
export function dayDiff(a: string, b: string): number {
  const t = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((t(b) - t(a)) / DAY_MS);
}

/** "2026-10-06 08:00 Asia/Kolkata" for admin tables. */
export function formatInZone(date: Date | null | undefined, tz: string): string {
  if (!date) return "—";
  const p = zonedParts(date, tz);
  return `${p.day} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} ${tz}`;
}
