/**
 * What every external, cost-capable API actually costs — for Admin pages, never for the public
 * site. One rule throughout: never claim "Free" for an API that can incur a charge, never invent a
 * dollar figure that is not computed from real usage, and fail safely (an explicit "cost data
 * unavailable" state, not a fabricated $0 or a thrown error) when the database or a budget
 * function cannot be read.
 *
 * Four cost natures:
 *   FREE            no provider charge is possible (a genuinely free tier/API, or not configured so
 *                   no call is ever made).
 *   PAID_TRACKED    a real $ budget exists, backed by Apify's own reported usage (CommerceRun /
 *                   the review-scrape ledger). `spentUsd`/`budgetUsd`/`remainingUsd` are real.
 *   PAID_UNTRACKED  the provider charges (a plan or per-request fee) but this app has no $ figure
 *                   for it — a request/day quota is shown instead of a dollar amount. Never guess a
 *                   $ number for these.
 *   UNKNOWN         cost nature could not be determined (budget function failed) or is not tracked
 *                   by this app at all (e.g. a legacy integration with no documented pricing).
 */
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { commerceBudget } from "@/lib/commerce/pipeline";
import { reviewScrapeBudget } from "@/lib/pipeline/review-budget";
import { rewriteUsage } from "@/lib/pipeline/rewrite";
import { istParts } from "@/lib/automation/daily-article";

export type CostNature = "FREE" | "PAID_TRACKED" | "PAID_UNTRACKED" | "UNKNOWN";

export type CostInfo = {
  nature: CostNature;
  /** Short badge text, e.g. "Free", "Paid · $1.20 / $30.00 this month", "Paid plan · 2/3 today". */
  label: string;
  /** One line of context: what the figure is, what is estimated vs. actual, or why it's unavailable. */
  detail?: string;
  spentUsd?: number;
  budgetUsd?: number;
  remainingUsd?: number;
  exhausted?: boolean;
  /** Whether spentUsd reflects Apify's own reported usage ("actual") or includes an estimate for runs not yet reported. */
  basis?: "actual" | "estimated";
};

const unavailable = (detail: string): CostInfo => ({ nature: "UNKNOWN", label: "Cost unavailable", detail });

/** Apify: review-scraping (scrape-sources / collect-scrapes, Admin → Sources "Run now"). */
export async function apifyReviewCost(): Promise<CostInfo> {
  if (!config.apify.token()) return { nature: "PAID_UNTRACKED", label: "Paid (Apify) — not configured", detail: "APIFY_API_TOKEN is not set, so no run can start." };
  try {
    const b = await reviewScrapeBudget();
    return {
      nature: "PAID_TRACKED",
      label: `Paid · $${b.spentUsd.toFixed(2)} / $${b.budgetUsd.toFixed(2)} this month`,
      spentUsd: b.spentUsd,
      budgetUsd: b.budgetUsd,
      remainingUsd: b.remainingUsd,
      exhausted: b.spentUsd >= b.budgetUsd,
      basis: b.unknownRuns > 0 ? "estimated" : "actual",
      detail: b.unknownRuns > 0 ? `${b.unknownRuns} run(s) this month not yet reported by Apify, estimated at $${b.perRunUsd.toFixed(2)} each` : "every run this month has a reported Apify cost",
    };
  } catch (error) {
    return unavailable(`could not read the review-scrape budget: ${String(error).slice(0, 150)}`);
  }
}

/** Apify: commerce engine (commerce-discover / commerce-collect, deals-weekly-refresh, per-brand "Crawl next"). */
export async function apifyCommerceCost(): Promise<CostInfo> {
  if (!config.apify.token()) return { nature: "PAID_UNTRACKED", label: "Paid (Apify) — not configured", detail: "APIFY_API_TOKEN is not set, so no run can start." };
  try {
    const b = await commerceBudget();
    return {
      nature: "PAID_TRACKED",
      label: `Paid · $${b.spentUsd.toFixed(2)} / $${b.budgetUsd.toFixed(2)} this month`,
      spentUsd: b.spentUsd,
      budgetUsd: b.budgetUsd,
      remainingUsd: b.remainingUsd,
      exhausted: b.exhausted,
      basis: "actual",
      detail: b.inFlightUsd > 0 ? `+ ~$${b.inFlightUsd.toFixed(2)} for runs in flight (estimated; not yet reported by Apify)` : undefined,
    };
  } catch (error) {
    return unavailable(`could not read the commerce budget: ${String(error).slice(0, 150)}`);
  }
}

/** Feedico coupon feed: the account's Free plan (code comment at lib/config.ts, config.feedico), request-quota limited, not billed per request. */
export function feedicoCost(): CostInfo {
  if (!config.feedico.apiKey()) return { nature: "FREE", label: "Free — not configured", detail: "FEEDICO_API_KEY is not set, so no request is ever made." };
  return { nature: "FREE", label: "Free", detail: `Free plan; the sync stops at ${config.feedico.monthlyRequestBudget()} requests/month (a quota, not a charge).` };
}

/** Pexels: free-tier image search (enrich-images job), rate-limited, not billed per request. */
export function pexelsCost(): CostInfo {
  if (!config.images.pexelsKey()) return { nature: "FREE", label: "Free — not configured", detail: "PEXELS_API_KEY is not set, so no request is ever made." };
  return { nature: "FREE", label: "Free", detail: "Pexels' free API tier: rate-limited, not billed per request." };
}

/**
 * Keyword-to-Blog: a flat-fee/plan subscription with a daily request quota (KEYWORD_TO_BLOG_DAILY_LIMIT).
 * This app has no published per-request $ price for it, so no dollar figure is shown — only the real
 * daily quota usage, read from today's automation slots (the same counter daily-article.ts enforces).
 */
export async function keywordToBlogCost(now = new Date()): Promise<CostInfo> {
  const url = config.aiGuides.url();
  const key = config.aiGuides.key();
  if (!url || !key) return { nature: "PAID_UNTRACKED", label: "Paid plan — not configured", detail: "KEYWORD_TO_BLOG_API_URL / KEYWORD_TO_BLOG_API_KEY are not set, so no request can be made." };
  const limit = config.aiGuides.dailyLimit();
  try {
    const { day } = istParts(now);
    const slots = await db.automationSlot.findMany({ where: { day }, select: { apiCalls: true } });
    const used = slots.reduce((n, s) => n + s.apiCalls, 0);
    return {
      nature: "PAID_UNTRACKED",
      label: `Paid plan · ${used}/${limit} requests today`,
      remainingUsd: Math.max(0, limit - used),
      budgetUsd: limit,
      exhausted: used >= limit,
      detail: "Flat-fee plan: the provider has not published a per-request price, so no $ figure is shown — only the daily quota.",
    };
  } catch (error) {
    return unavailable(`could not read today's Keyword-to-Blog usage: ${String(error).slice(0, 150)}`);
  }
}

/** Legacy/optional Content API: an owner-configured feed with no documented pricing in this app. */
export function contentApiCost(): CostInfo {
  if (!config.contentApi.url()) return { nature: "FREE", label: "Not configured", detail: "CONTENT_API_URL is not set, so no call is ever made." };
  return { nature: "UNKNOWN", label: "Cost not tracked", detail: "This is an owner-configured feed; its provider's pricing is not recorded in this app, so no cost figure can be shown." };
}

/** Google Search Console: Google's own free quota-based API (no billing). */
export const gscCost = (): CostInfo => ({ nature: "FREE", label: "Free", detail: "Google Search Console API: free, quota-limited (not billed)." });

/** Affiliate link rewriting: no API call is made to generate a link; providers are configured, not called per-request here. */
export const affiliateCost = (): CostInfo => ({ nature: "FREE", label: "Free", detail: "Rewrites stored links using provider rules; no external call is made to produce an affiliate link." });

/** First-party analytics: our own database, no external call. */
export const analyticsCost = (): CostInfo => ({ nature: "FREE", label: "Free", detail: "First-party events, stored in our own database." });

/** Content rewrite (Claude API): budget tracked by this app's own per-call estimate (Claude does not report cost back to us), never the exact invoice figure. */
export async function rewriteCost(): Promise<CostInfo> {
  if (!config.rewrite.apiKey()) return { nature: "PAID_UNTRACKED", label: "Paid (Claude API) — not configured", detail: "ANTHROPIC_API_KEY is not set, so no rewrite can run." };
  try {
    const { spentUsd, budgetUsd } = await rewriteUsage();
    return {
      nature: "PAID_TRACKED",
      label: `Paid · $${spentUsd.toFixed(2)} / $${budgetUsd.toFixed(2)} this month`,
      spentUsd,
      budgetUsd,
      remainingUsd: Math.max(0, budgetUsd - spentUsd),
      exhausted: spentUsd >= budgetUsd,
      basis: "estimated",
      detail: `Estimated at $${config.rewrite.runEstimateUsd().toFixed(3)}/review (REWRITE_RUN_ESTIMATE_USD); Claude does not report the exact cost back to this app.`,
    };
  } catch (error) {
    return unavailable(`could not read the rewrite budget: ${String(error).slice(0, 150)}`);
  }
}
