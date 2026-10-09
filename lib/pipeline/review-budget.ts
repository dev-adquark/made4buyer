import { db } from "@/lib/db";
import { config } from "@/lib/config";
import { log } from "@/lib/log";

/**
 * Hard monthly dollar cap for REVIEW-scraping Apify runs (the scrape-sources job, the GitHub
 * schedule and Admin → Sources → Run now all start runs through startSourceRun, which checks it).
 *
 * Spend this UTC month = the usage Apify reported for each run (recorded when its status is read)
 * + every run started this month whose usage is not known yet, counted at the expected cost of a run
 * (the larger of REVIEW_SCRAPE_RUN_ESTIMATE_USD and the average recorded run). A new run starts only
 * when that spend plus one more expected run stays within REVIEW_SCRAPE_MONTHLY_BUDGET_USD.
 * Fail closed: if the spend cannot be read, no run starts.
 */

const ledgerKey = (now: Date) => `apify-review-spend:${now.toISOString().slice(0, 7)}`;
type Ledger = Record<string, number>;

async function readLedger(now: Date): Promise<Ledger> {
  const row = await db.automationSetting.findUnique({ where: { key: ledgerKey(now) } });
  if (!row) return {};
  const v = JSON.parse(row.value) as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("review spend ledger is not an object");
  return v as Ledger;
}

export type ReviewBudget = { budgetUsd: number; recordedUsd: number; unknownRuns: number; perRunUsd: number; spentUsd: number; remainingUsd: number; allowed: boolean };

export async function reviewScrapeBudget(now = new Date()): Promise<ReviewBudget> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [ledger, runs] = await Promise.all([readLedger(now), db.apifyRun.findMany({ where: { startedAt: { gte: monthStart } }, select: { apifyRunId: true } })]);
  const recorded = Object.values(ledger).filter((n) => Number.isFinite(n) && n >= 0);
  const recordedUsd = recorded.reduce((s, n) => s + n, 0);
  const avg = recorded.length ? recordedUsd / recorded.length : 0;
  const perRunUsd = Math.max(config.apify.reviewRunEstimateUsd(), avg);
  const unknownRuns = runs.filter((r) => !(r.apifyRunId in ledger)).length;
  const spentUsd = recordedUsd + unknownRuns * perRunUsd;
  const budgetUsd = config.apify.reviewMonthlyBudgetUsd();
  return { budgetUsd, recordedUsd, unknownRuns, perRunUsd, spentUsd, remainingUsd: Math.max(0, budgetUsd - spentUsd), allowed: spentUsd + perRunUsd <= budgetUsd };
}

/** Stores the usage Apify reports for a review run (the latest value wins). Never throws. */
export async function recordReviewRunUsage(apifyRunId: string, usd: number | null | undefined, startedAt: Date): Promise<void> {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return;
  const key = ledgerKey(startedAt);
  try {
    const ledger = await readLedger(startedAt).catch(() => ({}) as Ledger);
    if (ledger[apifyRunId] === usd) return;
    ledger[apifyRunId] = usd;
    const value = JSON.stringify(ledger);
    await db.automationSetting.upsert({ where: { key }, create: { key, value, updatedBy: "review-scrape-budget" }, update: { value, updatedBy: "review-scrape-budget" } });
  } catch (error) {
    log.warn("review run usage not recorded", { stage: "CONTENT_FETCH", apifyRunId, error: String(error).slice(0, 200) });
  }
}
