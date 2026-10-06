import { db } from "@/lib/db";
import { getSwitches, setSwitch, SWITCHES, type SwitchKey } from "@/lib/automation/settings";
import { audit, type AuditContext } from "@/lib/security/audit";

/**
 * Admin → Commerce engine: the owner's controls (pause / resume / retry failed) and the read
 * helpers the overview uses. Kept apart from the route so tests call them directly.
 */

export const ENGINE_SWITCH = "commerce_engine" as SwitchKey;

/** Run statuses that count as a failure (the Apify terminal failure states plus our own). */
export const FAILED_RUN_STATUSES = ["FAILED", "ABORTED", "TIMED-OUT"];

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

/** Monthly Apify budget in USD (COMMERCE_MONTHLY_BUDGET_USD, default 4). */
export function commerceMonthlyBudget(): number {
  const v = Number(process.env.COMMERCE_MONTHLY_BUDGET_USD);
  return Number.isFinite(v) && v > 0 ? v : 4;
}

/** This calendar month's (UTC) recorded Apify usage across commerce runs. */
export async function commerceMonthUsage(now = new Date()) {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const agg = await db.commerceRun.aggregate({ where: { startedAt: { gte: from } }, _sum: { usageUsd: true } });
  const used = agg._sum.usageUsd ?? 0;
  const budget = commerceMonthlyBudget();
  return { from, used, budget, ratio: used / budget, warn: used / budget >= 0.8 };
}
