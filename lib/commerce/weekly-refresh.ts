import { getSwitches } from "@/lib/automation/settings";
import { db } from "@/lib/db";
import { LockHeldError, withLock } from "@/lib/jobs/lock";
import { recordJobRun } from "@/lib/jobs/run-log";
import { log } from "@/lib/log";
import { runDataAudit } from "@/lib/ops/data-audit";
import { maxAgeMs } from "@/lib/products/facts";
import { audit, type AuditContext } from "@/lib/security/audit";
import { ensureBrandsSeeded } from "./brands";
import { classifyOfferStatusesSafe } from "./classify";
import { markExpiredCoupons } from "./coupons";
import { collectCouponRuns, runCouponCrawl } from "./coupons-run";
import { HIDDEN_LINK_STATUSES, linkCheckBudgetMs, runLinkValidation } from "./link-check";
import { runOfficialVerify } from "./official";
import { collectCommerceRuns, isStopCode, markStaleOffers, startBrandRun } from "./pipeline";
import { isDealOffer, publicCandidateOfferWhere } from "./recheck";
import { revalidateCommerce } from "./revalidate";

/**
 * Weekly deals refresh (job "deals-weekly-refresh"): "deals refresh automatically every week".
 *
 * Schedule: AutomationSetting "deals_weekly_schedule" = {"weekday":0-6,"hourUtc":0-23}, set in Admin →
 * Commerce; default Sunday 06:00 UTC (DEALS_WEEKLY_DAY / DEALS_WEEKLY_HOUR_UTC override the default).
 * Vercel Hobby crons are fixed and once a day, so the job is called daily and runs its sweep only
 * when this week's slot has passed and no sweep of this week has completed (job_runs outcome
 * COMPLETED, or the stored last sweep); otherwise it returns SKIPPED "not due until <next slot>".
 * Admin "Run now" (trigger admin:…) forces a sweep.
 *
 * A sweep is a staged, resumable state machine kept in AutomationSetting "deals_weekly_state". Each
 * invocation works within COMMERCE_WEEKLY_INVOCATION_BUDGET_MS (default 240 s, under Vercel's 300 s)
 * and saves progress after every step; the daily cron and the hourly commerce-discover passes
 * (continueWeeklyRefresh) carry it on until it completes. Stages:
 *
 *   collect    collect finished product and coupon runs
 *   freshness  offers past PRODUCT_PRICE_MAX_AGE_HOURS → STALE; expired coupons → EXPIRED
 *   recheck    for every brand with public-candidate offers: a run of its offer pages due for a price
 *              re-check (then newly discovered URLs). COMMERCE_WEEKLY_BRANDS_PER_INVOCATION (default 8)
 *              brands per invocation; budget- and switch-gated; failure backoff respected
 *   discover   discovery runs for enabled brands not crawled in 7 days, and for every brand with
 *              official deal pages (dealUrls) not yet run in this sweep: each brand run includes its
 *              deal pages (lib/commerce/deal-crawl.ts), so every deal brand gets a deal crawl per sweep
 *   coupons    official promotions pages of every promo brand (once per sweep)
 *   settle     wait (≤ COMMERCE_WEEKLY_SETTLE_HOURS, default 3) for this sweep's Apify runs, collecting them
 *   links      every offer destination checked once in this sweep (robots.txt, one request at a time per host)
 *   official   official-source verification
 *   audit      data audit with its two safe, audited fixes
 *   summary    counters, then the sweep is COMPLETED
 *
 * One brand or source failing never stops the sweep: the reason is recorded and the sweep continues.
 * A stage that throws is retried on the next invocation (at most 3 attempts), then recorded and
 * skipped. Nothing is deleted; good data is never erased on failure.
 */

export const WEEKLY_JOB = "deals-weekly-refresh";
export const SCHEDULE_KEY = "deals_weekly_schedule";
export const STATE_KEY = "deals_weekly_state";
export const LAST_KEY = "deals_weekly_last";
const SNAPSHOT_KEY = "deals_weekly_snapshot";

export const STAGES = ["collect", "freshness", "recheck", "discover", "coupons", "settle", "links", "official", "audit", "summary"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABELS: Record<Stage, string> = {
  collect: "Collect finished runs",
  freshness: "Mark stale offers and expired coupons",
  recheck: "Re-check prices of brands with deals",
  discover: "Discover brands not crawled in 7 days",
  coupons: "Crawl official promotions pages",
  settle: "Wait for this sweep's runs and collect them",
  links: "Check every offer link",
  official: "Official-source verification",
  audit: "Data audit and safe fixes",
  summary: "Summary",
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MAX_STAGE_ATTEMPTS = 3;
const MAX_ERRORS = 100;
const DISCOVER_AFTER_DAYS = 7;
const SNAPSHOT_CAP = 20_000;
/** Sitemap discovery inside a sweep: at most 5 sitemaps, 8 s each, so one brand fits in BRAND_MARGIN_MS. */
const SWEEP_DISCOVERY = { maxSitemaps: 5, timeoutMs: 8_000 };
const BRAND_MARGIN_MS = 45_000;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw == null || raw.trim() === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export const brandsPerInvocation = () => envInt("COMMERCE_WEEKLY_BRANDS_PER_INVOCATION", 8, 1, 100);
export const invocationBudgetMs = () => envInt("COMMERCE_WEEKLY_INVOCATION_BUDGET_MS", 240_000, 5_000, 280_000);
export const settleHours = () => envInt("COMMERCE_WEEKLY_SETTLE_HOURS", 3, 0, 48);

// ── Schedule ─────────────────────────────────────────────────────────────────

export type WeeklySchedule = { weekday: number; hourUtc: number };
export type ScheduleSource = "admin" | "env" | "default";

const validWeekday = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 6;
const validHour = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 23;

/** Default slot: Sunday 06:00 UTC, unless DEALS_WEEKLY_DAY (0–6, 0 = Sunday) / DEALS_WEEKLY_HOUR_UTC (0–23) say otherwise. */
export function defaultWeeklySchedule(): WeeklySchedule & { source: ScheduleSource } {
  const weekday = envInt("DEALS_WEEKLY_DAY", 0, 0, 6);
  const hourUtc = envInt("DEALS_WEEKLY_HOUR_UTC", 6, 0, 23);
  const fromEnv = (process.env.DEALS_WEEKLY_DAY ?? "").trim() !== "" || (process.env.DEALS_WEEKLY_HOUR_UTC ?? "").trim() !== "";
  return { weekday, hourUtc, source: fromEnv ? "env" : "default" };
}

export async function getWeeklySchedule(): Promise<WeeklySchedule & { source: ScheduleSource }> {
  const row = await db.automationSetting.findUnique({ where: { key: SCHEDULE_KEY } }).catch(() => null);
  if (row) {
    try {
      const v = JSON.parse(row.value) as Partial<WeeklySchedule>;
      if (validWeekday(v.weekday) && validHour(v.hourUtc)) return { weekday: v.weekday, hourUtc: v.hourUtc, source: "admin" };
    } catch {
      /* invalid stored value: the default applies */
    }
  }
  return defaultWeeklySchedule();
}

export type ScheduleValidation = { ok: true; value: WeeklySchedule } | { ok: false; error: string };

export function parseWeeklySchedule(input: { weekday?: unknown; hourUtc?: unknown }): ScheduleValidation {
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.trim()) : NaN);
  const weekday = num(input.weekday);
  const hourUtc = num(input.hourUtc);
  if (!validWeekday(weekday)) return { ok: false, error: "Day: a whole number 0–6 (0 = Sunday)" };
  if (!validHour(hourUtc)) return { ok: false, error: "Hour (UTC): a whole number 0–23" };
  return { ok: true, value: { weekday, hourUtc } };
}

/** Admin: sets the weekly slot (audited). */
export async function setWeeklySchedule(input: { weekday?: unknown; hourUtc?: unknown }, ctx: AuditContext): Promise<{ ok: true; before: WeeklySchedule; after: WeeklySchedule } | { ok: false; error: string }> {
  const v = parseWeeklySchedule(input);
  if (!v.ok) return v;
  const prev = await getWeeklySchedule();
  const before = { weekday: prev.weekday, hourUtc: prev.hourUtc };
  const value = JSON.stringify(v.value);
  await db.automationSetting.upsert({ where: { key: SCHEDULE_KEY }, create: { key: SCHEDULE_KEY, value, updatedBy: ctx.actor }, update: { value, updatedBy: ctx.actor } });
  await audit(ctx, { action: "commerce.weekly_schedule.set", entityType: "automation_setting", entityId: SCHEDULE_KEY, before, after: v.value });
  return { ok: true, before, after: v.value };
}

export const scheduleLabel = (s: WeeklySchedule) => `${WEEKDAYS[s.weekday]} ${String(s.hourUtc).padStart(2, "0")}:00 UTC`;

/** The latest configured slot at or before `now` (this week's slot once it has passed, else last week's). */
export function slotOnOrBefore(now: Date, s: WeeklySchedule): Date {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), s.hourUtc);
  let t = today - ((now.getUTCDay() - s.weekday + 7) % 7) * DAY;
  if (t > now.getTime()) t -= 7 * DAY;
  return new Date(t);
}

/** The first configured slot strictly after `now`. */
export const nextSlotAfter = (now: Date, s: WeeklySchedule) => new Date(slotOnOrBefore(now, s).getTime() + 7 * DAY);

// ── State ────────────────────────────────────────────────────────────────────

export type SweepCounters = {
  brandsTargeted: number;
  brandsProcessed: number;
  runsStarted: number;
  runsSkipped: number;
  runsFailed: number;
  recordsDiscovered: number;
  recordsExtracted: number;
  recordsAccepted: number;
  recordsRejected: number;
  offersUpdated: number;
  offersMarkedStale: number;
  dealsAtStart: number;
  dealsNow: number;
  dealsCreated: number;
  dealsExpired: number;
  dealsHidden: number;
  couponRunsStarted: number;
  couponsVerified: number;
  couponsExpired: number;
  linksChecked: number;
  linksFailed: number;
  verificationChecked: number;
  verificationFailures: number;
  auditFlagged: number;
  auditFixed: number;
  apiErrors: number;
  retries: number;
  durationMs: number;
};

export const emptyCounters = (): SweepCounters => ({
  brandsTargeted: 0,
  brandsProcessed: 0,
  runsStarted: 0,
  runsSkipped: 0,
  runsFailed: 0,
  recordsDiscovered: 0,
  recordsExtracted: 0,
  recordsAccepted: 0,
  recordsRejected: 0,
  offersUpdated: 0,
  offersMarkedStale: 0,
  dealsAtStart: 0,
  dealsNow: 0,
  dealsCreated: 0,
  dealsExpired: 0,
  dealsHidden: 0,
  couponRunsStarted: 0,
  couponsVerified: 0,
  couponsExpired: 0,
  linksChecked: 0,
  linksFailed: 0,
  verificationChecked: 0,
  verificationFailures: 0,
  auditFlagged: 0,
  auditFixed: 0,
  apiErrors: 0,
  retries: 0,
  durationMs: 0,
});

export type SweepError = { stage: string; target?: string; code?: string; reason: string; at: string };

export type SweepState = {
  version: 1;
  sweepId: string;
  /** ISO time of the weekly slot this sweep belongs to. */
  weekKey: string;
  trigger: string;
  forced: boolean;
  stage: Stage | "done";
  /** Per-stage progress (brand queue, retry list, totals); reset when a stage completes. */
  cursor: { queue?: string[]; retry?: string[]; total?: number; done?: number; settleSince?: string };
  /** Brands that already had a run attempt in this sweep. */
  processed: string[];
  /** Set when Apify runs may not start (budget, switch, configuration): later run stages skip their starts. */
  runStop: { code: string; reason: string } | null;
  lastRunStartAt: string | null;
  stageAttempts: Record<string, number>;
  counters: SweepCounters;
  errors: SweepError[];
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  invocations: number;
};

export type SweepRecord = {
  sweepId: string;
  weekKey: string;
  trigger: string;
  status: "COMPLETED" | "COMPLETED_WITH_ERRORS" | "INCOMPLETE";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  invocations: number;
  counters: SweepCounters;
  errors: SweepError[];
};

async function readJson<T>(key: string): Promise<T | null> {
  const row = await db.automationSetting.findUnique({ where: { key } }).catch(() => null);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

async function writeJson(key: string, value: unknown, actor: string) {
  const v = JSON.stringify(value);
  await db.automationSetting.upsert({ where: { key }, create: { key, value: v, updatedBy: actor.slice(0, 200) }, update: { value: v, updatedBy: actor.slice(0, 200) } });
}

export async function readSweepState(): Promise<SweepState | null> {
  const s = await readJson<SweepState>(STATE_KEY);
  return s && s.version === 1 && typeof s.stage === "string" ? { ...s, counters: { ...emptyCounters(), ...s.counters } } : null;
}

export const readLastSweep = () => readJson<SweepRecord>(LAST_KEY);

function addError(s: SweepState, stage: string, reason: string, target?: string, code?: string) {
  s.errors.push({ stage, reason: reason.slice(0, 300), at: new Date().toISOString(), ...(target ? { target } : {}), ...(code ? { code } : {}) });
  if (s.errors.length > MAX_ERRORS) s.errors.splice(0, s.errors.length - MAX_ERRORS);
}

function toRecord(s: SweepState, status: SweepRecord["status"], finishedAt: Date): SweepRecord {
  const durationMs = finishedAt.getTime() - new Date(s.startedAt).getTime();
  return { sweepId: s.sweepId, weekKey: s.weekKey, trigger: s.trigger, status, startedAt: s.startedAt, finishedAt: finishedAt.toISOString(), durationMs, invocations: s.invocations, counters: { ...s.counters, durationMs }, errors: s.errors.slice(-20) };
}

/** Deal offers that are public now: FRESH, destination not hidden, price below the stated list price. */
async function publicDealIds(): Promise<string[]> {
  const rows = await db.commerceOffer.findMany({ where: { status: "FRESH", linkStatus: { notIn: [...HIDDEN_LINK_STATUSES] }, price: { gt: 0 }, listPrice: { not: null } }, select: { id: true, price: true, listPrice: true }, take: SNAPSHOT_CAP });
  return rows.filter(isDealOffer).map((r) => r.id);
}

/** Whether this week's slot already has a completed sweep (job_runs, or the stored last sweep). */
async function weekCompleted(weekKey: string, slot: Date): Promise<boolean> {
  const last = await readLastSweep();
  if (last && last.weekKey === weekKey && last.status !== "INCOMPLETE") return true;
  const run = await db.jobRun.findFirst({ where: { job: WEEKLY_JOB, status: "SUCCEEDED", outcome: "COMPLETED", startedAt: { gte: slot }, reason: { startsWith: `week ${weekKey}` } }, select: { id: true } });
  return !!run;
}

// ── Stages ───────────────────────────────────────────────────────────────────

type Ctx = { state: SweepState; trigger: string; runTrigger: string; now: Date; deadline: number; save: () => Promise<void> };
/** true = the stage is complete; false = it needs another invocation (out of time, per-invocation cap, or waiting). */
type StageFn = (c: Ctx) => Promise<boolean>;

const remaining = (c: Ctx) => c.deadline - Date.now();
const APIFY_ERROR = /^APIFY_/;

async function collectAll(c: Ctx) {
  const p = await collectCommerceRuns(c.runTrigger, c.now);
  const k = await collectCouponRuns(c.runTrigger);
  c.state.counters.apiErrors += p.results.filter((r) => APIFY_ERROR.test(r.status) && r.status !== "APIFY_NOT_CONFIGURED").length + k.results.filter((r) => APIFY_ERROR.test(r.status)).length;
  return { products: p, coupons: k };
}

async function freshness(c: Ctx) {
  const cutoff = new Date(c.now.getTime() - maxAgeMs("HIGH"));
  const goingStale = await db.commerceOffer.findMany({ where: { status: "FRESH", observedAt: { lt: cutoff } }, select: { price: true, listPrice: true } });
  const stale = await markStaleOffers(c.now);
  const expired = await markExpiredCoupons(c.now);
  c.state.counters.offersMarkedStale += stale;
  c.state.counters.dealsExpired += Math.min(stale, goingStale.filter(isDealOffer).length);
  c.state.counters.couponsExpired += expired;
  if (stale || expired) await revalidateCommerce();
}

/** Starts one run per queued brand (re-checks first, then discovery), resumable across invocations. */
async function processBrandQueue(c: Ctx, stage: Stage): Promise<boolean> {
  const s = c.state;
  const queue = s.cursor.queue ?? [];
  let started = 0;
  while (queue.length) {
    if (s.runStop) {
      s.counters.runsSkipped += queue.length;
      addError(s, stage, `${queue.length} brand(s) not started: ${s.runStop.reason}`, undefined, s.runStop.code);
      queue.length = 0;
      break;
    }
    // Discovery reads sitemaps (bounded: SWEEP_DISCOVERY): keep a margin so the invocation ends in time.
    if (started >= brandsPerInvocation() || remaining(c) < BRAND_MARGIN_MS) return false;
    const id = queue.shift()!;
    s.cursor.done = (s.cursor.done ?? 0) + 1;
    started++;
    await startOne(c, stage, id, false);
    await c.save();
  }
  // Retry pass: brands that failed temporarily are tried once more when their backoff has elapsed;
  // otherwise the hourly commerce-discover retries them after the backoff (existing mechanism).
  const retry = s.cursor.retry ?? [];
  while (retry.length && !s.runStop) {
    if (remaining(c) < BRAND_MARGIN_MS) return false;
    await startOne(c, stage, retry.shift()!, true);
    await c.save();
  }
  return true;
}

async function startOne(c: Ctx, stage: Stage, brandId: string, isRetry: boolean) {
  const s = c.state;
  const brand = await db.commerceBrand.findUnique({ where: { id: brandId } });
  if (!brand || !brand.enabled) return;
  if (!s.processed.includes(brand.id)) s.processed.push(brand.id);
  if (brand.consecutiveFailures > 0 && brand.nextCrawlAt && brand.nextCrawlAt > c.now) {
    s.counters.runsSkipped++;
    addError(s, stage, `backed off after ${brand.consecutiveFailures} failure(s) until ${brand.nextCrawlAt.toISOString()}; the hourly discover retries it then`, brand.slug, "BACKOFF");
    return;
  }
  if (isRetry) s.counters.retries++;
  else s.counters.brandsProcessed++;
  try {
    const r = await startBrandRun(brand, c.runTrigger, c.now, { discovery: SWEEP_DISCOVERY });
    if (r.status === "STARTED") {
      s.counters.runsStarted++;
      s.counters.recordsDiscovered += r.urls;
      s.lastRunStartAt = c.now.toISOString();
      return;
    }
    if (r.status === "SKIPPED") {
      s.counters.runsSkipped++;
      if (isStopCode(r.code)) s.runStop = { code: r.code!, reason: r.reason ?? r.code! };
      else if (r.code !== "ACTIVE_RUN") addError(s, stage, r.reason ?? "skipped", brand.slug, r.code);
      return;
    }
    s.counters.runsFailed++;
    if (r.code && APIFY_ERROR.test(r.code)) s.counters.apiErrors++;
    addError(s, stage, r.reason ?? "run failed to start", brand.slug, r.code);
    // Temporary (HTTP 5xx / network) start failures get one more attempt later in this sweep.
    if (!isRetry && r.code === "APIFY_RUN_FAILED") (s.cursor.retry ??= []).push(brand.id);
  } catch (error) {
    s.counters.runsFailed++;
    addError(s, stage, String(error instanceof Error ? error.message : error), brand.slug, "ERROR");
  }
}

const STAGE_FNS: Record<Stage, StageFn> = {
  async collect(c) {
    await collectAll(c);
    return true;
  },
  async freshness(c) {
    await freshness(c);
    return true;
  },
  async recheck(c) {
    const s = c.state;
    if (!s.cursor.queue) {
      const brands = await db.commerceBrand.findMany({ where: { enabled: true, products: { some: { offers: { some: publicCandidateOfferWhere() } } } }, orderBy: [{ priority: "desc" }, { name: "asc" }], select: { id: true } });
      s.cursor = { queue: brands.map((b) => b.id), total: brands.length, done: 0 };
      s.counters.brandsTargeted += brands.length;
      await c.save();
    }
    return processBrandQueue(c, "recheck");
  },
  async discover(c) {
    const s = c.state;
    if (!s.cursor.queue) {
      const cutoff = new Date(c.now.getTime() - DISCOVER_AFTER_DAYS * DAY);
      // Brands with official deal pages get a deal crawl every sweep (their run includes the deal pages).
      const brands = await db.commerceBrand.findMany({ where: { enabled: true, id: { notIn: s.processed }, OR: [{ lastCrawlAt: null }, { lastCrawlAt: { lt: cutoff } }, { dealUrls: { isEmpty: false } }] }, orderBy: [{ priority: "desc" }, { name: "asc" }], select: { id: true } });
      s.cursor = { queue: brands.map((b) => b.id), total: brands.length, done: 0 };
      s.counters.brandsTargeted += brands.length;
      await c.save();
    }
    return processBrandQueue(c, "discover");
  },
  async coupons(c) {
    const s = c.state;
    const r = await runCouponCrawl(c.runTrigger, { since: new Date(s.startedAt), deadline: c.deadline - 30_000 });
    s.counters.couponRunsStarted += r.started;
    for (const x of r.results ?? []) {
      if (x.status === "STARTED" || x.status === "NOT_DUE") continue;
      if (APIFY_ERROR.test(x.status)) s.counters.apiErrors++;
      addError(s, "coupons", x.reason ?? x.status, x.target, x.status);
    }
    if (r.status !== "OK") {
      addError(s, "coupons", r.reason ?? r.status, undefined, r.status);
      return true;
    }
    return !r.remaining;
  },
  async settle(c) {
    const s = c.state;
    await collectAll(c);
    const active = await db.commerceRun.count({ where: { trigger: { startsWith: "weekly:" }, startedAt: { gte: new Date(s.startedAt) }, apifyRunId: { not: null }, status: { in: ["READY", "RUNNING", "SUCCEEDED", "COLLECTING"] } } });
    if (!active) return true;
    const since = new Date(s.lastRunStartAt ?? (s.cursor.settleSince ??= c.now.toISOString()));
    if (c.now.getTime() - since.getTime() >= settleHours() * HOUR) {
      addError(s, "settle", `${active} Apify run(s) still running after ${settleHours()} h; the hourly commerce-discover collects them`, undefined, "SETTLE_TIMEOUT");
      return true;
    }
    return false;
  },
  async links(c) {
    const s = c.state;
    const checkedBefore = new Date(s.startedAt);
    while (remaining(c) > 20_000) {
      const r = await runLinkValidation(c.runTrigger, c.now, { checkedBefore, budgetMs: Math.min(linkCheckBudgetMs(), remaining(c) - 15_000) });
      s.counters.linksChecked += r.checked;
      const by = ("byStatus" in r ? r.byStatus : {}) as Record<string, number>;
      s.counters.linksFailed += HIDDEN_LINK_STATUSES.reduce((n, k) => n + (by[k] ?? 0), 0);
      await c.save();
      if (!r.due) return true;
      if (!r.checked) {
        addError(s, "links", `${r.due} offer link(s) could not be checked; left to the daily link check`, undefined, "NO_PROGRESS");
        return true;
      }
    }
    return false;
  },
  async official(c) {
    const r = await runOfficialVerify(c.runTrigger, c.now);
    c.state.counters.verificationChecked += r.checked;
    const counts = r as unknown as Record<string, number | undefined>;
    c.state.counters.verificationFailures += (counts.MISMATCH ?? 0) + (counts.NOT_FOUND ?? 0);
    return true;
  },
  async audit(c) {
    // An admin-forced sweep's fixes are attributed to that admin; otherwise to the system.
    const r = await runDataAudit(c.trigger);
    c.state.counters.auditFlagged = r.totalFlagged;
    c.state.counters.auditFixed += r.fixed.offersMarkedStale + r.fixed.couponsMarkedExpired;
    c.state.counters.offersMarkedStale += r.fixed.offersMarkedStale;
    c.state.counters.couponsExpired += r.fixed.couponsMarkedExpired;
    return true;
  },
  async summary(c) {
    const s = c.state;
    const since = new Date(s.startedAt);
    await classifyOfferStatusesSafe({ now: new Date() });
    const runs = await db.commerceRun.findMany({ where: { purpose: "PRODUCT", trigger: { startsWith: "weekly:" }, startedAt: { gte: since }, apifyRunId: { not: null } }, select: { extracted: true, accepted: true, rejected: true } });
    s.counters.recordsExtracted = runs.reduce((n, r) => n + (r.extracted ?? 0), 0);
    s.counters.recordsAccepted = runs.reduce((n, r) => n + (r.accepted ?? 0), 0);
    s.counters.recordsRejected = runs.reduce((n, r) => n + (r.rejected ?? 0), 0);
    s.counters.offersUpdated = await db.commerceOffer.count({ where: { observedAt: { gte: since } } });
    s.counters.couponsVerified = await db.commerceCoupon.count({ where: { status: "VERIFIED", lastVerifiedAt: { gte: since } } });
    const snapshot = await readJson<{ sweepId: string; ids: string[] }>(SNAPSHOT_KEY);
    const before = new Set(snapshot?.sweepId === s.sweepId ? snapshot.ids : []);
    const now = new Set(await publicDealIds());
    s.counters.dealsNow = now.size;
    s.counters.dealsCreated = [...now].filter((id) => !before.has(id)).length;
    s.counters.dealsHidden = [...before].filter((id) => !now.has(id)).length;
    return true;
  },
};

// ── Runner ───────────────────────────────────────────────────────────────────

export type WeeklyRefreshResult = {
  status: "COMPLETED" | "IN_PROGRESS" | "SKIPPED" | "IDLE";
  reason?: string;
  weekKey?: string;
  sweepId?: string;
  stage?: Stage | "done";
  progress?: string;
  counters?: SweepCounters;
  errors?: SweepError[];
  invocationMs?: number;
  durationMs?: number;
  nextSlot: string;
  schedule: string;
};

function durationLabel(ms: number) {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** One line for job_runs.reason (starts with "week <slot>" so the due check can find it). */
export function summaryLine(s: Pick<SweepState, "weekKey" | "counters">, durationMs: number): string {
  const c = s.counters;
  return (
    `week ${s.weekKey} completed: ${c.brandsProcessed} brands, ${c.runsStarted} runs; records ${c.recordsDiscovered} discovered/${c.recordsAccepted} accepted/${c.recordsRejected} rejected, ${c.offersUpdated} offers updated; ` +
    `deals +${c.dealsCreated} created/${c.dealsExpired} expired/${c.dealsHidden} hidden (${c.dealsNow} live); coupons ${c.couponsVerified} verified/${c.couponsExpired} expired; ${c.linksFailed} links failed; ` +
    `${c.verificationFailures} verification failures; ${c.apiErrors} API errors; ${c.retries} retries; ${durationLabel(durationMs)}`
  );
}

export function progressLabel(s: Pick<SweepState, "stage" | "cursor">): string {
  if (s.stage === "done") return "done";
  const i = STAGES.indexOf(s.stage) + 1;
  const brands = s.cursor.total != null ? ` (${s.cursor.done ?? 0} of ${s.cursor.total} brands)` : "";
  return `stage ${i}/${STAGES.length}: ${STAGE_LABELS[s.stage]}${brands}`;
}

function newState(weekKey: string, trigger: string, forced: boolean, now: Date): SweepState {
  const iso = now.toISOString();
  return { version: 1, sweepId: iso, weekKey, trigger: trigger.slice(0, 200), forced, stage: STAGES[0], cursor: {}, processed: [], runStop: null, lastRunStartAt: null, stageAttempts: {}, counters: emptyCounters(), errors: [], startedAt: iso, updatedAt: iso, finishedAt: null, invocations: 0 };
}

export type WeeklyRunOptions = { now?: Date; budgetMs?: number; force?: boolean; continueOnly?: boolean };

/**
 * One invocation of the weekly sweep. Called by runJob (under the job lock) and by
 * continueWeeklyRefresh. Starts a sweep when due (or forced), otherwise continues the one in
 * progress, otherwise returns SKIPPED with the next slot.
 */
export async function runWeeklyRefresh(trigger: string, opts: WeeklyRunOptions = {}): Promise<WeeklyRefreshResult> {
  const t0 = Date.now();
  const now = opts.now ?? new Date();
  const forced = opts.force ?? trigger.startsWith("admin:");
  const schedule = await getWeeklySchedule();
  const slot = slotOnOrBefore(now, schedule);
  const weekKey = slot.toISOString();
  const nextSlot = nextSlotAfter(now, schedule).toISOString();
  const base = { nextSlot, schedule: scheduleLabel(schedule) };

  let state = await readSweepState();
  // A sweep stuck for a whole week is closed as INCOMPLETE (its counters are kept) so a new one can start.
  if (state && state.stage !== "done" && now.getTime() - new Date(state.startedAt).getTime() > 7 * DAY) {
    addError(state, state.stage, "sweep did not finish within 7 days; closed as INCOMPLETE", undefined, "INCOMPLETE");
    await writeJson(LAST_KEY, toRecord(state, "INCOMPLETE", now), trigger);
    state = { ...state, stage: "done", finishedAt: now.toISOString() };
    await writeJson(STATE_KEY, state, trigger);
  }

  const inProgress = !!state && state.stage !== "done";
  if (!inProgress) {
    if (opts.continueOnly) return { status: "IDLE", reason: "no weekly sweep in progress", ...base };
    if (!forced && (await weekCompleted(weekKey, slot))) {
      return { status: "SKIPPED", reason: `not due until ${nextSlot} (this week's sweep for the ${scheduleLabel(schedule)} slot has completed)`, weekKey, ...base };
    }
    await ensureBrandsSeeded();
    state = newState(weekKey, trigger, forced, now);
    const ids = await publicDealIds();
    state.counters.dealsAtStart = ids.length;
    await writeJson(SNAPSHOT_KEY, { sweepId: state.sweepId, ids }, trigger);
    log.info("weekly deals sweep started", { stage: "COMMERCE", trigger, week: weekKey, forced, deals: ids.length });
  }
  const s = state!;
  s.invocations++;
  const save = async () => {
    s.updatedAt = new Date().toISOString();
    await writeJson(STATE_KEY, s, trigger);
  };
  await save();

  const budget = Math.max(5_000, Math.min(opts.budgetMs ?? invocationBudgetMs(), invocationBudgetMs()));
  const c: Ctx = { state: s, trigger, runTrigger: `weekly:${trigger}`.slice(0, 200), now, deadline: t0 + budget, save };
  let waiting: string | undefined;
  while (s.stage !== "done") {
    if (remaining(c) < 15_000) break;
    const stage: Stage = s.stage;
    let complete = false;
    try {
      complete = await STAGE_FNS[stage](c);
    } catch (error) {
      const attempts = (s.stageAttempts[stage] = (s.stageAttempts[stage] ?? 0) + 1);
      const reason = String(error instanceof Error ? error.message : error).slice(0, 300);
      log.warn("weekly deals sweep stage failed", { stage: "COMMERCE", sweepStage: stage, attempts, error: reason });
      if (attempts < MAX_STAGE_ATTEMPTS) {
        s.counters.retries++;
        addError(s, stage, `attempt ${attempts} failed: ${reason}; retried on the next invocation`, undefined, "STAGE_FAILED");
        await save();
        break;
      }
      addError(s, stage, `failed ${attempts} times, skipped: ${reason}`, undefined, "STAGE_SKIPPED");
      complete = true;
    }
    if (!complete) {
      if (stage === "settle") waiting = "waiting for this sweep's Apify runs to finish";
      await save();
      break;
    }
    const next = STAGES.indexOf(stage) + 1;
    s.stage = next < STAGES.length ? STAGES[next] : "done";
    s.cursor = {};
    if (s.stage === "done") {
      const finishedAt = new Date();
      s.finishedAt = finishedAt.toISOString();
      s.counters.durationMs = finishedAt.getTime() - new Date(s.startedAt).getTime();
      await writeJson(LAST_KEY, toRecord(s, s.errors.length ? "COMPLETED_WITH_ERRORS" : "COMPLETED", finishedAt), trigger);
    }
    await save();
  }

  const invocationMs = Date.now() - t0;
  if (s.stage === "done") {
    const reason = summaryLine(s, s.counters.durationMs);
    log.info("weekly deals sweep completed", { stage: "COMMERCE", trigger, week: s.weekKey, ...s.counters });
    return { status: "COMPLETED", reason, weekKey: s.weekKey, sweepId: s.sweepId, stage: "done", progress: "done", counters: s.counters, errors: s.errors.slice(-10), invocationMs, durationMs: s.counters.durationMs, ...base };
  }
  const progress = progressLabel(s);
  return { status: "IN_PROGRESS", reason: `week ${s.weekKey} in progress: ${progress}${waiting ? `; ${waiting}` : ""}`, weekKey: s.weekKey, sweepId: s.sweepId, stage: s.stage, progress, counters: s.counters, errors: s.errors.slice(-10), invocationMs, ...base };
}

/**
 * Cheap continuation, called at the end of each hourly commerce-discover pass: one settings read
 * when no sweep is in progress; otherwise carries the sweep on within `budgetMs` under the job's
 * lock (a concurrent invocation means someone else is already doing it). Never starts a sweep and
 * never throws. A sweep it completes is recorded in job_runs like a cron completion.
 */
export async function continueWeeklyRefresh(trigger: string, opts: { budgetMs?: number; now?: Date } = {}): Promise<WeeklyRefreshResult | { status: "IDLE" | "LOCK_HELD" | "NO_TIME" | "ERROR"; reason?: string }> {
  try {
    const state = await readSweepState();
    if (!state || state.stage === "done") return { status: "IDLE" };
    const budgetMs = opts.budgetMs ?? 60_000;
    if (budgetMs < 30_000) return { status: "NO_TIME", reason: `${Math.round(budgetMs / 1000)} s left in this invocation` };
    const result = await withLock(`job:${WEEKLY_JOB}`, 10 * 60_000, () => runWeeklyRefresh(trigger, { budgetMs, now: opts.now, continueOnly: true, force: false }));
    if (result.status === "COMPLETED") await recordJobRun(WEEKLY_JOB, trigger, { status: "SUCCEEDED", outcome: "COMPLETED", reason: result.reason });
    return result;
  } catch (error) {
    if (error instanceof LockHeldError) return { status: "LOCK_HELD", reason: error.message };
    log.warn("weekly deals sweep continuation failed", { stage: "COMMERCE", error: String(error).slice(0, 200) });
    return { status: "ERROR", reason: String(error instanceof Error ? error.message : error).slice(0, 300) };
  }
}

// ── Admin status ─────────────────────────────────────────────────────────────

export type WeeklyRefreshStatus = {
  schedule: WeeklySchedule & { source: ScheduleSource; label: string };
  timezone: "UTC";
  lastSweep: { startedAt: string; finishedAt: string; status: SweepRecord["status"]; counters: SweepCounters; weekKey: string; trigger: string; errors: SweepError[] } | null;
  current: { stage: Stage; stageLabel: string; progress: string; startedAt: string; invocations: number; counters: SweepCounters; errors: SweepError[]; trigger: string } | null;
  /** The next configured slot after now. */
  nextSlot: string;
  /** This week's slot has passed and no sweep of it has completed: the next daily invocation starts one. */
  dueNow: boolean;
  /** Commerce engine (or the master automation switch) is off: scheduled sweeps do not run. */
  paused: boolean;
};

export async function weeklyRefreshStatus(now = new Date()): Promise<WeeklyRefreshStatus> {
  const [schedule, state, last, switches] = await Promise.all([getWeeklySchedule(), readSweepState(), readLastSweep(), getSwitches()]);
  const slot = slotOnOrBefore(now, schedule);
  const current =
    state && state.stage !== "done"
      ? { stage: state.stage, stageLabel: STAGE_LABELS[state.stage], progress: progressLabel(state), startedAt: state.startedAt, invocations: state.invocations, counters: state.counters, errors: state.errors.slice(-10), trigger: state.trigger }
      : null;
  return {
    schedule: { ...schedule, label: scheduleLabel(schedule) },
    timezone: "UTC",
    lastSweep: last ? { startedAt: last.startedAt, finishedAt: last.finishedAt, status: last.status, counters: { ...emptyCounters(), ...last.counters }, weekKey: last.weekKey, trigger: last.trigger, errors: last.errors ?? [] } : null,
    current,
    nextSlot: nextSlotAfter(now, schedule).toISOString(),
    dueNow: !current && !(await weekCompleted(slot.toISOString(), slot)),
    paused: !switches.commerce_engine || !switches.automation,
  };
}
