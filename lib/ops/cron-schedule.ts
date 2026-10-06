import vercelConfig from "@/vercel.json";

/**
 * Cron schedules of the scheduled jobs, evaluated in UTC (Vercel Cron and GitHub Actions both
 * run cron in UTC). Supports the standard 5 fields (minute hour day-of-month month day-of-week)
 * with "*", numbers, lists "a,b", ranges "a-b" and steps "*\/n" / "a-b/n". Pure; no I/O.
 */

type Field = { values: number[]; any: boolean };
export type CronExpr = { source: string; minute: Field; hour: Field; dom: Field; month: Field; dow: Field };

const BOUNDS: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseField(text: string, [min, max]: [number, number], isDow: boolean): Field {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`Invalid cron field "${text}"`);
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      const [a, b] = m[1].split("-").map(Number);
      lo = a;
      hi = b ?? (m[2] ? max : a);
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`Cron field "${text}" out of range ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) values.add(isDow && v === 7 ? 0 : v);
  }
  return { values: [...values].sort((a, b) => a - b), any: text.trim() === "*" };
}

export function parseCron(expr: string): CronExpr {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron "${expr}" must have 5 fields`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, BOUNDS[i], i === 4));
  return { source: expr.trim(), minute, hour, dom, month, dow };
}

function dayMatches(c: CronExpr, d: Date): boolean {
  if (!c.month.values.includes(d.getUTCMonth() + 1)) return false;
  const domOk = c.dom.values.includes(d.getUTCDate());
  const dowOk = c.dow.values.includes(d.getUTCDay());
  // Standard cron: when both day fields are restricted, either may match.
  if (!c.dom.any && !c.dow.any) return domOk || dowOk;
  if (!c.dom.any) return domOk;
  if (!c.dow.any) return dowOk;
  return true;
}

const MINUTE = 60_000;
const DAY = 86_400_000;
const SEARCH_DAYS = 366 * 5;

/** The first scheduled time strictly after `from` (UTC). */
export function nextRun(expr: string | CronExpr, from: Date = new Date()): Date | null {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const start = new Date(Math.floor(from.getTime() / MINUTE) * MINUTE + MINUTE);
  let day = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  for (let i = 0; i < SEARCH_DAYS; i++, day += DAY) {
    const d = new Date(day);
    if (!dayMatches(c, d)) continue;
    for (const h of c.hour.values) {
      for (const m of c.minute.values) {
        const t = day + h * 3_600_000 + m * MINUTE;
        if (t >= start.getTime()) return new Date(t);
      }
    }
  }
  return null;
}

/** The latest scheduled time at or before `from` (UTC). */
export function previousRun(expr: string | CronExpr, from: Date = new Date()): Date | null {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const end = Math.floor(from.getTime() / MINUTE) * MINUTE;
  let day = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  for (let i = 0; i < SEARCH_DAYS; i++, day -= DAY) {
    const d = new Date(day);
    if (!dayMatches(c, d)) continue;
    for (let hi = c.hour.values.length - 1; hi >= 0; hi--) {
      for (let mi = c.minute.values.length - 1; mi >= 0; mi--) {
        const t = day + c.hour.values[hi] * 3_600_000 + c.minute.values[mi] * MINUTE;
        if (t <= end) return new Date(t);
      }
    }
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function stepOf(f: Field, min: number, max: number): number | null {
  const v = f.values;
  if (v.length < 2 || v[0] !== min) return null;
  const step = v[1] - v[0];
  for (let i = 1; i < v.length; i++) if (v[i] - v[i - 1] !== step) return null;
  return v[v.length - 1] + step > max ? step : null;
}

/** Plain-English description, e.g. "Every day at 05:00 UTC" or "Every hour at minute 40". */
export function describeCron(expr: string | CronExpr): string {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  let time: string;
  if (c.minute.any && c.hour.any) time = "Every minute";
  else if (c.hour.any) {
    const step = stepOf(c.minute, 0, 59);
    time = step && !c.minute.any ? `Every ${step} minutes` : `Every hour at minute ${c.minute.values.join(", ")}`;
  } else {
    const times = c.hour.values.flatMap((h) => c.minute.values.map((m) => `${pad(h)}:${pad(m)}`));
    const hourStep = stepOf(c.hour, 0, 23);
    if (hourStep && c.minute.values.length === 1) time = `Every ${hourStep} hours at minute ${c.minute.values[0]} (${times.join(", ")} UTC)`;
    else time = `${times.length === 1 ? "At" : "At each of"} ${times.join(", ")} UTC`;
  }
  const days: string[] = [];
  if (!c.dom.any) days.push(`on day ${c.dom.values.join(", ")} of the month`);
  if (!c.dow.any) days.push(`on ${c.dow.values.map((d) => DOW_NAMES[d]).join(", ")}`);
  if (!c.month.any) days.push(`in month ${c.month.values.join(", ")}`);
  if (!days.length) return time.startsWith("Every") ? time : `Every day ${time.charAt(0).toLowerCase()}${time.slice(1)}`;
  return `${time} ${days.join(" ")}`;
}

// ── Scheduled jobs ───────────────────────────────────────────────────────────

export type ScheduleOrigin = "vercel" | "github-actions";
export type ScheduledEntry = { job: string; cron: string; origin: ScheduleOrigin; path: string; query?: string };

/** /api/cron/<job>?<query> → job name and query. */
export function jobFromCronPath(path: string): { job: string; query?: string } | null {
  const m = /^\/api\/cron\/([a-z0-9-]+)(?:\?(.*))?$/.exec(path);
  return m ? { job: m[1], query: m[2] || undefined } : null;
}

/**
 * GitHub Actions schedules in .github/workflows/scheduled-jobs.yml. The workflow file is not
 * deployed, so it is mirrored here; tests/unit/cron-schedule.test.ts fails if the two drift.
 */
export const GITHUB_SCHEDULES: Array<{ cron: string; jobs: string[] }> = [
  { cron: "10 */6 * * *", jobs: ["enrich-products", "commerce-collect"] },
  { cron: "40 * * * *", jobs: ["scrape-sources", "collect-scrapes", "ingest", "retry-failed", "publish-cycle", "daily-article", "commerce-discover", "commerce-collect"] },
];

/** Every schedule from vercel.json, then the GitHub Actions workflow schedules. */
export function scheduledEntries(): ScheduledEntry[] {
  const out: ScheduledEntry[] = [];
  for (const c of (vercelConfig as { crons?: Array<{ path: string; schedule: string }> }).crons ?? []) {
    const parsed = jobFromCronPath(c.path);
    if (parsed) out.push({ job: parsed.job, query: parsed.query, cron: c.schedule, origin: "vercel", path: c.path });
  }
  for (const s of GITHUB_SCHEDULES) for (const job of s.jobs) out.push({ job, cron: s.cron, origin: "github-actions", path: `/api/cron/${job}` });
  return out;
}

/** The business timezone shown alongside UTC (BUSINESS_TIMEZONE, default Asia/Kolkata). */
export function businessTimezone(): string {
  const tz = process.env.BUSINESS_TIMEZONE?.trim() || "Asia/Kolkata";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return tz;
  } catch {
    return "Asia/Kolkata";
  }
}

/** "2026-10-07 13:30" in the given IANA timezone. */
export function formatInZone(d: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
