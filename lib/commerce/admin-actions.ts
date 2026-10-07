import { HIDDEN_LINK_STATUSES } from "./link-check";
import { commerceBudget, monthlyBudgetUsd } from "./pipeline";
import { getSwitches, setSwitch, SWITCHES, type SwitchKey } from "@/lib/automation/settings";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { nextRun, scheduledEntries, type ScheduleOrigin } from "@/lib/ops/cron-schedule";
import { checkByKey, lastDataAudit } from "@/lib/ops/data-audit";
import { DEAL_CURRENCY, loadOfficialDeals } from "@/lib/public/deals";
import { freshOfferWhere, freshSince } from "@/lib/public/offers";
import { audit, type AuditContext } from "@/lib/security/audit";

/**
 * Admin → Commerce engine: the owner's controls (pause / resume / retry failed) and the read
 * helpers the overview uses. Kept apart from the route so tests call them directly.
 */

export const ENGINE_SWITCH = "commerce_engine" as SwitchKey;

/**
 * Run statuses that count as a failure: the Apify terminal failure states plus our own start and
 * collection failures (same list as Admin → Schedules, lib/ops/schedules.ts).
 */
export const FAILED_RUN_STATUSES = ["FAILED", "ABORTED", "TIMED-OUT", "COLLECT_FAILED", "START_FAILED"];

/**
 * Whether the commerce engine is on. Uses the registered switch (and its coded default) when it
 * exists; otherwise reads the stored row directly, defaulting to on.
 */
export async function commerceEngineOn(): Promise<boolean> {
  if (ENGINE_SWITCH in SWITCHES) return (await getSwitches())[ENGINE_SWITCH];
  const row = await db.automationSetting.findUnique({ where: { key: ENGINE_SWITCH } }).catch(() => null);
  return row ? row.value === "on" : true;
}

/** Pause or resume the engine. setSwitch writes the setting and the audit entry. */
export async function setCommerceEngine(on: boolean, ctx: AuditContext): Promise<{ before: boolean; after: boolean }> {
  const before = await commerceEngineOn();
  await setSwitch(ENGINE_SWITCH, on, ctx);
  return { before, after: on };
}

/**
 * Re-queue everything that failed: brands with failures (or a FAILED crawl) become due now with
 * their failure counter reset and crawl status RETRY_QUEUED (the next crawl overwrites it), and FAILED runs are marked RETRY_QUEUED. Healthy brands and runs
 * in any other state are not touched.
 */
export async function retryFailed(ctx: AuditContext, now = new Date()) {
  const brands = await db.commerceBrand.findMany({
    where: { OR: [{ consecutiveFailures: { gt: 0 } }, { crawlStatus: "FAILED" }] },
    select: { id: true, slug: true, consecutiveFailures: true, crawlStatus: true, nextCrawlAt: true },
  });
  const runs = await db.commerceRun.findMany({ where: { status: "FAILED" }, select: { id: true } });
  await db.$transaction([
    db.commerceBrand.updateMany({ where: { id: { in: brands.map((b) => b.id) } }, data: { nextCrawlAt: now, consecutiveFailures: 0, crawlStatus: "RETRY_QUEUED" } }),
    db.commerceRun.updateMany({ where: { id: { in: runs.map((r) => r.id) }, status: "FAILED" }, data: { status: "RETRY_QUEUED" } }),
  ]);
  await audit(ctx, {
    action: "commerce.retry_failed",
    entityType: "commerce_engine",
    entityId: "commerce",
    before: { brands: brands.map((b) => ({ slug: b.slug, consecutiveFailures: b.consecutiveFailures, crawlStatus: b.crawlStatus, nextCrawlAt: b.nextCrawlAt })) },
    after: { nextCrawlAt: now, consecutiveFailures: 0, crawlStatus: "RETRY_QUEUED", runsMarked: "RETRY_QUEUED" },
    metadata: { brands: brands.length, runs: runs.length, runIds: runs.map((r) => r.id).slice(0, 100) },
  });
  return { brands: brands.length, runs: runs.length };
}

/** Monthly Apify budget in USD — the same value the jobs enforce (lib/commerce/pipeline.ts). */
export function commerceMonthlyBudget(): number {
  return monthlyBudgetUsd();
}

/** This calendar month's (UTC) recorded Apify usage across commerce runs (commerceBudget, the value the jobs enforce). */
export async function commerceMonthUsage(now = new Date()) {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const b = await commerceBudget(now);
  const ratio = b.budgetUsd > 0 ? b.spentUsd / b.budgetUsd : b.spentUsd > 0 ? Infinity : 1;
  return { from, used: b.spentUsd, budget: b.budgetUsd, remaining: b.remainingUsd, ratio, warn: ratio >= 0.8, exhausted: b.exhausted };
}

// ── Overview metrics (Admin → Commerce engine) ───────────────────────────────

/** Run statuses that mean the Apify run itself succeeded (awaiting collection, being collected, or collected). */
export const SUCCESSFUL_RUN_STATUSES = ["SUCCEEDED", "COLLECTING", "COLLECTED"];

const monthStartUtc = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
/** First day of the next UTC month: when a budget-exhausted engine resumes on its own. */
export const nextMonthStartUtc = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

export type NextCommerceRun = { job: string; at: Date; path: string; origin: ScheduleOrigin; schedules: number };

/**
 * The next scheduled run of each commerce job, from vercel.json crons (paths with a query string,
 * e.g. "/api/cron/commerce-discover?pass=07", count for their job) and the GitHub Actions schedules.
 */
export function nextCommerceRuns(now = new Date()): NextCommerceRun[] {
  const byJob = new Map<string, NextCommerceRun>();
  for (const e of scheduledEntries()) {
    if (!e.job.startsWith("commerce-")) continue;
    let at: Date | null = null;
    try {
      at = nextRun(e.cron, now);
    } catch {
      continue;
    }
    if (!at) continue;
    const cur = byJob.get(e.job);
    if (!cur) byJob.set(e.job, { job: e.job, at, path: e.path, origin: e.origin, schedules: 1 });
    else {
      cur.schedules++;
      if (at < cur.at) Object.assign(cur, { at, path: e.path, origin: e.origin });
    }
  }
  return [...byJob.values()].sort((a, b) => a.at.getTime() - b.at.getTime() || a.job.localeCompare(b.job));
}

/** Data-audit check counts used on the overview, evaluated live with the data-audit's own checks. */
const INTEGRITY_CHECKS = { duplicateOffers: "duplicate-offers", conflictingCoupons: "conflicting-coupons", conflictingFacts: "conflicting-fact-fields" } as const;
type IntegrityKey = keyof typeof INTEGRITY_CHECKS;

async function integrityCounts(now: Date): Promise<{ counts: Record<IntegrityKey, number>; source: "live" | "stored"; at: Date | null; lastAuditAt: Date | null }> {
  const last = await lastDataAudit();
  const lastAuditAt = last?.finishedAt ? new Date(last.finishedAt) : null;
  try {
    const entries = await Promise.all(
      (Object.entries(INTEGRITY_CHECKS) as Array<[IntegrityKey, string]>).map(async ([k, key]) => {
        const check = checkByKey(key);
        if (!check) throw new Error(`data-audit check "${key}" is not defined`);
        return [k, await check.count({ now })] as const;
      }),
    );
    return { counts: Object.fromEntries(entries) as Record<IntegrityKey, number>, source: "live", at: now, lastAuditAt };
  } catch (error) {
    log.warn("commerce overview: live data-audit counts failed; using the stored result", { error: String(error).slice(0, 200) });
    if (!last) throw error;
    const counts = Object.fromEntries((Object.entries(INTEGRITY_CHECKS) as Array<[IntegrityKey, string]>).map(([k, key]) => [k, last.counts[key] ?? 0])) as Record<IntegrityKey, number>;
    return { counts, source: "stored", at: lastAuditAt, lastAuditAt };
  }
}

/**
 * Every number on the Commerce engine overview, read from the database with the same rules the
 * jobs and the public site use:
 *  - budget: commerceBudget() (sum of CommerceRun.usageUsd since the 1st of the UTC month vs monthlyBudgetUsd());
 *  - public offers: freshOfferWhere() (FRESH, observed within the price window, link not hidden) + USD + price > 0;
 *  - price drops / promo codes: loadOfficialDeals() (what /deals renders, uncached);
 *  - duplicates / conflicts: the data-audit checks (lib/ops/data-audit.ts).
 */
export async function commerceMetrics(now = new Date()) {
  const monthStart = monthStartUtc(now);
  const nextMonth = nextMonthStartUtc(now);
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const since24 = { startedAt: { gte: dayAgo } };
  const sinceMonth = { startedAt: { gte: monthStart } };
  const ok = { status: { in: SUCCESSFUL_RUN_STATUSES } };
  const failed = { status: { in: FAILED_RUN_STATUSES } };
  const hidden = { linkStatus: { in: [...HIDDEN_LINK_STATUSES] } };
  const cutoff = freshSince(now.getTime());

  const [budget, runs24, ok24, failed24, runsMonth, okMonth, failedMonth, lastOk, productsTotal, matched, rejected, unmatched, offersTotal, publicOffers, staleOffers, hiddenLinkOffers, priceRejected, couponsTotal, couponsVerifiedActive, deals, integrity] = await Promise.all([
    commerceBudget(now),
    db.commerceRun.count({ where: since24 }),
    db.commerceRun.count({ where: { ...since24, ...ok } }),
    db.commerceRun.count({ where: { ...since24, ...failed } }),
    db.commerceRun.count({ where: sinceMonth }),
    db.commerceRun.count({ where: { ...sinceMonth, ...ok } }),
    db.commerceRun.count({ where: { ...sinceMonth, ...failed } }),
    db.commerceRun.findFirst({ where: ok, orderBy: { startedAt: "desc" }, select: { startedAt: true, finishedAt: true, collectedAt: true, purpose: true } }),
    db.commerceProduct.count(),
    db.commerceProduct.count({ where: { identityStatus: "MATCHED" } }),
    db.commerceProduct.count({ where: { identityStatus: "MATCH_REJECTED" } }),
    db.commerceProduct.count({ where: { identityStatus: "UNMATCHED" } }),
    db.commerceOffer.count(),
    db.commerceOffer.count({ where: { ...freshOfferWhere(now.getTime()), currency: DEAL_CURRENCY, price: { gt: 0 } } }),
    db.commerceOffer.count({ where: { OR: [{ status: "STALE" }, { status: "FRESH", observedAt: { lt: cutoff } }] } }),
    db.commerceOffer.count({ where: hidden }),
    db.auditLog.count({ where: { action: "PRICE_REJECTED", createdAt: { gte: monthStart } } }),
    db.commerceCoupon.count(),
    db.commerceCoupon.count({ where: { status: "VERIFIED", AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, { OR: [{ startsAt: null }, { startsAt: { lte: now } }] }] } }),
    loadOfficialDeals(now.getTime()),
    integrityCounts(now),
  ]);

  const { spentUsd, budgetUsd, remainingUsd, exhausted } = budget;
  const ratio = budgetUsd > 0 ? spentUsd / budgetUsd : spentUsd > 0 ? Infinity : 1;
  const nextRuns = nextCommerceRuns(now);
  return {
    now,
    monthStart,
    budget: { usedUsd: spentUsd, budgetUsd, remainingUsd, ratio, warn: ratio >= 0.8, exhausted, pausedUntil: exhausted ? nextMonth : null },
    runs: {
      last24h: { total: runs24, succeeded: ok24, failed: failed24 },
      month: { total: runsMonth, succeeded: okMonth, failed: failedMonth },
      lastSuccessAt: lastOk ? (lastOk.finishedAt ?? lastOk.collectedAt ?? lastOk.startedAt) : null,
      nextDiscovery: nextRuns.find((r) => r.job === "commerce-discover") ?? null,
      next: nextRuns,
    },
    products: { total: productsTotal, matched, rejected, unmatched },
    offers: { total: offersTotal, public: publicOffers, stale: staleOffers, hiddenLink: hiddenLinkOffers, priceRejectedThisMonth: priceRejected, duplicateGroups: integrity.counts.duplicateOffers },
    conflicts: { coupons: integrity.counts.conflictingCoupons, factFields: integrity.counts.conflictingFacts, total: integrity.counts.conflictingCoupons + integrity.counts.conflictingFacts },
    integrity: { source: integrity.source, at: integrity.at, lastAuditAt: integrity.lastAuditAt },
    coupons: { total: couponsTotal, verifiedActive: couponsVerifiedActive, publicCodes: deals.codes.length },
    deals: { priceDrops: deals.drops.length, checkedAt: deals.checkedAt ? new Date(deals.checkedAt) : null },
  };
}

export type CommerceMetrics = Awaited<ReturnType<typeof commerceMetrics>>;
