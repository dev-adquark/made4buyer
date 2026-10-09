/**
 * Apify usage audit for one billing cycle. READ-ONLY: Apify GET endpoints (free; no run is started,
 * no credit used) and SELECT queries on the app database. Prints a Markdown report; never prints a token.
 *
 *   npx tsx scripts/apify-usage-audit.ts                 # the last COMPLETED Apify billing cycle
 *   npx tsx scripts/apify-usage-audit.ts --current       # the cycle in progress
 *   npx tsx scripts/apify-usage-audit.ts --out report.md # also write the report to a file
 *
 * Needs APIFY_API_TOKEN and DATABASE_URL in the shell or .env.local (the production values to audit
 * production). Sources:
 *   - Apify: /users/me/limits (cycle, account usage and limit), /users/me/usage/monthly (cycle total),
 *     /actor-runs (every run on the account), /actor-runs/{id} (per-run usage breakdown), /acts/{id}.
 *   - Database: apify_runs (review scraping) → ingestion → content_items → normalized_reviews (published),
 *     commerce_runs (products/deals/coupons) → commerce_raw_records, and the commerce budget.
 */
import "./support/load-env";
import { writeFileSync } from "node:fs";
import { db } from "@/lib/db";
import { commerceBudget } from "@/lib/commerce/pipeline";

const BASE = (process.env.APIFY_API_BASE_URL?.trim() || "https://api.apify.com/v2").replace(/\/+$/, "");
const TOKEN = process.env.APIFY_API_TOKEN?.trim();

async function apify<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Apify GET ${path.split("?")[0]} → HTTP ${res.status}`);
  }
  return ((await res.json()) as { data: T }).data;
}

type Cycle = { startAt: string; endAt: string };
type Limits = { monthlyUsageCycle: Cycle; limits: { maxMonthlyUsageUsd?: number }; current: { monthlyUsageUsd?: number } };
type Monthly = { usageCycle: Cycle; totalUsageCreditsUsdAfterVolumeDiscount?: number; totalUsageCreditsUsdBeforeVolumeDiscount?: number };
type RunItem = { id: string; actId: string; actorTaskId?: string | null; status: string; startedAt: string; finishedAt?: string | null; usageTotalUsd?: number; meta?: { origin?: string } };
type RunDetail = RunItem & { stats?: { computeUnits?: number }; usage?: Record<string, number>; usageUsd?: Record<string, number> };

const usd = (n: number | null | undefined) => (typeof n === "number" ? `$${n.toFixed(4)}` : "—");
const fmt = (s: string | Date | null | undefined) => (s ? new Date(s).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—");
const ist = (s: string | Date) => new Date(s).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (!TOKEN) {
    console.error("APIFY_API_TOKEN is not set (shell or .env.local). Nothing was called.");
    return 1;
  }
  const out: string[] = [];
  const p = (s = "") => out.push(s);

  // ── Billing cycle ──
  const limits = await apify<Limits>("/users/me/limits");
  const current = limits.monthlyUsageCycle;
  const wantCurrent = argv.includes("--current");
  const probe = wantCurrent ? new Date() : new Date(new Date(current.startAt).getTime() - 86_400_000);
  const monthly = await apify<Monthly>(`/users/me/usage/monthly?date=${probe.toISOString().slice(0, 10)}`);
  const cycle = monthly.usageCycle;
  const from = new Date(cycle.startAt).getTime();
  const to = new Date(cycle.endAt).getTime();

  // ── Every run on the account in the cycle (newest first; stop once older than the cycle) ──
  const runs: RunItem[] = [];
  for (let offset = 0; offset < 20_000; offset += 1000) {
    const page = await apify<{ items: RunItem[]; total: number }>(`/actor-runs?desc=1&limit=1000&offset=${offset}`);
    for (const r of page.items) {
      const t = new Date(r.startedAt).getTime();
      if (t >= from && t <= to) runs.push(r);
    }
    const oldest = page.items.at(-1);
    if (!oldest || new Date(oldest.startedAt).getTime() < from || page.items.length < 1000) break;
  }
  runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const details = new Map<string, RunDetail>();
  for (const r of runs) details.set(r.id, await apify<RunDetail>(`/actor-runs/${encodeURIComponent(r.id)}`).catch(() => r));
  const actorNames = new Map<string, string>();
  for (const actId of new Set(runs.map((r) => r.actId))) {
    const a = await apify<{ name: string; username: string }>(`/acts/${encodeURIComponent(actId)}`).catch(() => null);
    actorNames.set(actId, a ? `${a.username}/${a.name}` : actId);
  }

  // ── What the app recorded for those runs (read-only) ──
  const ids = runs.map((r) => r.id);
  const [reviewRuns, commerceRuns] = await Promise.all([
    db.apifyRun.findMany({ where: { apifyRunId: { in: ids } }, include: { source: { select: { name: true } } } }),
    db.commerceRun.findMany({ where: { apifyRunId: { in: ids } }, include: { brand: { select: { name: true } }, source: { select: { name: true } }, _count: { select: { raws: true } } } }),
  ]);
  const reviewBy = new Map(reviewRuns.map((r) => [r.apifyRunId, r]));
  const commerceBy = new Map(commerceRuns.filter((r) => r.apifyRunId).map((r) => [r.apifyRunId!, r]));
  const ingestIds = reviewRuns.map((r) => r.ingestRunId).filter((x): x is string => Boolean(x));
  const items = ingestIds.length ? await db.contentItem.findMany({ where: { ingestRunId: { in: ingestIds } }, select: { ingestRunId: true, normalizedReviewId: true } }) : [];
  const reviewIds = [...new Set(items.map((i) => i.normalizedReviewId).filter((x): x is string => Boolean(x)))];
  const published = new Set((reviewIds.length ? await db.normalizedReview.findMany({ where: { id: { in: reviewIds }, status: "PUBLISHED" }, select: { id: true } }) : []).map((r) => r.id));
  const publishedByIngest = new Map<string, number>();
  for (const i of items) if (i.ingestRunId && i.normalizedReviewId && published.has(i.normalizedReviewId)) publishedByIngest.set(i.ingestRunId, (publishedByIngest.get(i.ingestRunId) ?? 0) + 1);

  // ── Report ──
  const total = runs.reduce((s, r) => s + (r.usageTotalUsd ?? 0), 0);
  const failed = runs.filter((r) => !["SUCCEEDED", "RUNNING", "READY"].includes(r.status));
  p(`# Apify usage audit — ${wantCurrent ? "current" : "last completed"} billing cycle`);
  p();
  p(`Cycle: ${fmt(cycle.startAt)} → ${fmt(cycle.endAt)}. Generated ${fmt(new Date())}. Read-only: no run started, no credit used.`);
  p();
  p(`| | |`);
  p(`|---|---|`);
  p(`| Actor runs on the account | ${runs.length} (${runs.length - failed.length} succeeded/running, ${failed.length} failed/aborted/timed out) |`);
  p(`| Sum of per-run cost (usageTotalUsd) | ${usd(total)} |`);
  p(`| Apify's cycle total (after discount) | ${usd(monthly.totalUsageCreditsUsdAfterVolumeDiscount)} (includes storage/transfer not billed to a run) |`);
  p(`| Account usage this cycle / limit | ${usd(limits.current.monthlyUsageUsd)} / ${usd(limits.limits.maxMonthlyUsageUsd)} — Apify cycle resets ${fmt(current.endAt)} |`);
  const budget = await commerceBudget();
  const reset = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1));
  p(`| Site's commerce budget (COMMERCE_MONTHLY_BUDGET_USD) | spent ${usd(budget.spentUsd)} of ${usd(budget.budgetUsd)}, remaining ${usd(budget.remainingUsd)} — resets ${fmt(reset)} |`);
  p();
  p(`## Runs`);
  p();
  p(`| # | Started (UTC / IST) | Finished | Actor | Purpose / target | Apify status | Compute units | Dataset writes / reads | Cost | Saved to database |`);
  p(`|---|---|---|---|---|---|---|---|---|---|`);
  runs.forEach((r, i) => {
    const d: RunDetail = details.get(r.id) ?? r;
    const rv = reviewBy.get(r.id);
    const cm = commerceBy.get(r.id);
    const purpose = rv ? `REVIEWS · ${rv.source.name}` : cm ? `${cm.purpose} · ${cm.brand?.name ?? cm.source?.name ?? "—"}` : "not recorded by this site";
    const saved = rv
      ? `${rv.status}; items ${rv.itemCount ?? "—"}, accepted ${rv.accepted ?? "—"}, rejected ${rv.rejected ?? "—"}`
      : cm
        ? `${cm.status}; raw records ${cm._count.raws}, accepted ${cm.accepted ?? "—"}, rejected ${cm.rejected ?? "—"}`
        : "—";
    p(`| ${i + 1} | ${fmt(r.startedAt)} / ${ist(r.startedAt)} IST | ${fmt(r.finishedAt)} | ${actorNames.get(r.actId)} | ${purpose} | ${r.status} | ${d.stats?.computeUnits?.toFixed(4) ?? "—"} | ${d.usage?.DATASET_WRITES ?? "—"} / ${d.usage?.DATASET_READS ?? "—"} | ${usd(r.usageTotalUsd)} | ${saved} |`);
  });
  p();
  p(`## Failed or wasted runs`);
  p();
  const wasted = runs.filter((r) => {
    if (failed.includes(r)) return true;
    const rv = reviewBy.get(r.id);
    const cm = commerceBy.get(r.id);
    if (rv) return rv.status === "COLLECT_FAILED" || (rv.status === "COLLECTED" && (rv.accepted ?? 0) === 0);
    if (cm) return cm.status === "COLLECT_FAILED" || (cm.status === "COLLECTED" && (cm.accepted ?? 0) === 0);
    return false;
  });
  if (!wasted.length) p("None.");
  for (const r of wasted) {
    const rv = reviewBy.get(r.id);
    const cm = commerceBy.get(r.id);
    const why = failed.includes(r) ? `Apify ${r.status}` : rv?.status === "COLLECT_FAILED" || cm?.status === "COLLECT_FAILED" ? "collected but storing failed" : "completed, nothing accepted";
    p(`- ${fmt(r.startedAt)} · ${actorNames.get(r.actId)} · ${usd(r.usageTotalUsd)} · ${why}`);
  }
  p();
  p(`## Scrapes vs published reviews`);
  p();
  const collectedReviews = reviewRuns.filter((r) => r.status === "COLLECTED");
  p(`- Review scrape runs that stored data: ${collectedReviews.length} (items accepted: ${collectedReviews.reduce((s, r) => s + (r.accepted ?? 0), 0)}).`);
  p(`- Reviews from those runs that are PUBLISHED now: ${[...publishedByIngest.values()].reduce((s, n) => s + n, 0)}.`);
  p(`- Commerce runs that stored data (products, deals, coupons): ${commerceRuns.filter((r) => r.status === "COLLECTED").length} (raw records: ${commerceRuns.reduce((s, r) => s + r._count.raws, 0)}). These never publish reviews.`);
  p(`- Runs on the account this site did not record: ${runs.filter((r) => !reviewBy.has(r.id) && !commerceBy.has(r.id)).length}.`);

  const report = out.join("\n");
  console.log(report);
  const i = argv.indexOf("--out");
  if (i >= 0 && argv[i + 1]) writeFileSync(argv[i + 1], report + "\n");
  await db.$disconnect();
  return 0;
}

if (process.argv[1]?.endsWith("apify-usage-audit.ts"))
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(String(error instanceof Error ? error.message : error).replace(/apify_api_[A-Za-z0-9]+/g, "[redacted]"));
      process.exit(1);
    });
