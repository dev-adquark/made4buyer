import type { CommerceBrand, CommerceRun, CommerceSource, Prisma } from "@prisma/client";
import { allowed } from "@/lib/automation/settings";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { PipelineError } from "@/lib/errors";
import { log } from "@/lib/log";
import { safeFetch } from "@/lib/net/safe-fetch";
import { apifyConfigured, checkRobots, hostAllowed, normalizeUrl } from "@/lib/pipeline/apify";
import { sha256 } from "@/lib/util/text";
import { markCrossPageConflicts, markExpiredCoupons, normalizeCoupons, parseCouponPage, recordDisappearances, upsertCoupons, type CouponRawPage, type NormalizedCoupon } from "./coupons";
import { commerceAudit } from "./audit";
import { COUPON_PAGE_FUNCTION } from "./page-functions/coupon";
import { revalidateCommerce } from "./revalidate";
import { sourceRunnable } from "./sources";

/**
 * Coupon crawl for the commerce engine (job "commerce-coupons") and its collection step
 * (collectCouponRuns, called by the "commerce-collect" job).
 *
 * Only brands' own official promotions pages are crawled: promo URLs must be on the brand's
 * officialDomain and allowed by robots.txt. Third-party coupon sites stay disabled unless an
 * admin approved their terms AND enabled them (normally none); their codes are never VERIFIED.
 * One small web-scraper run per brand (depth 0, one page per promo URL, concurrency 1). No login,
 * CAPTCHA or anti-bot workaround is ever used. The "commerce_engine" switch and the monthly
 * budget (COMMERCE_MONTHLY_BUDGET_USD, default 4) are honoured before anything starts.
 */

export const COUPON_PURPOSE = "COUPON";
const ACTIVE = ["READY", "RUNNING"];
const FAILED = ["FAILED", "ABORTED", "TIMED-OUT", "TIMING-OUT", "ABORTING"];

export const commerceActorId = () => (process.env.COMMERCE_APIFY_ACTOR_ID ?? "").trim() || "moJRLRc85AitArpNN";

export function commerceMonthlyBudgetUsd(): number {
  const n = Number(process.env.COMMERCE_MONTHLY_BUDGET_USD);
  return Number.isFinite(n) && n >= 0 && (process.env.COMMERCE_MONTHLY_BUDGET_USD ?? "").trim() !== "" ? n : 4;
}

/** Apify spend recorded on commerce runs since the start of this UTC month. */
export async function commerceSpendThisMonth(now = new Date()): Promise<number> {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const r = await db.commerceRun.aggregate({ where: { startedAt: { gte: since } }, _sum: { usageUsd: true } });
  return r._sum.usageUsd ?? 0;
}

// ── Apify API (bearer token; never logged) ───────────────────────────────

async function apify<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
  const token = config.apify.token();
  if (!token) throw new PipelineError("APIFY_NOT_CONFIGURED");
  const res = await safeFetch(`${config.apify.baseUrl()}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    timeoutMs: 30_000,
    maxRedirects: 2,
    readBody: true,
    maxBytes: 20_000_000,
    standardPortsOnly: !config.allowLoopbackForTests(),
  });
  if (res.status === 401 || res.status === 403) throw new PipelineError("APIFY_AUTH_FAILED", `Apify rejected the request (HTTP ${res.status})`, { status: res.status }, false);
  if (!res.ok) throw new PipelineError("APIFY_RUN_FAILED", `Apify request failed: ${res.error ? res.error.kind : `HTTP ${res.status}`}`, { status: res.status }, true);
  try {
    return JSON.parse(res.body ?? "") as T;
  } catch {
    throw new PipelineError("APIFY_RESPONSE_INVALID", "Apify returned invalid JSON");
  }
}

type ApifyRunData = { id: string; status: string; defaultDatasetId?: string; finishedAt?: string | null; statusMessage?: string | null; usageTotalUsd?: number | null };

export function buildCouponActorInput(urls: string[], label: string) {
  return {
    startUrls: urls.map((url) => ({ url })),
    linkSelector: "",
    maxCrawlingDepth: 0,
    maxPagesPerCrawl: urls.length,
    maxConcurrency: 1,
    respectRobotsTxtFile: true,
    injectJQuery: false,
    // Web Scraper requires a proxy setting; Apify's default pool is its normal egress (no residential IPs, no evasion).
    proxyConfiguration: { useApifyProxy: true },
    pageFunction: COUPON_PAGE_FUNCTION,
    customData: { purpose: COUPON_PURPOSE, label },
  };
}

// ── Start ────────────────────────────────────────────────────────────────

type StartResult = { target: string; status: string; reason?: string; runId?: string; skipped?: Array<{ url: string; reason: string }> };

/** Promo URLs that may be crawled: on the allowed domain and allowed by robots.txt. Others carry a reason. */
async function crawlableUrls(urls: string[], domain: string) {
  const ok: string[] = [];
  const skipped: Array<{ url: string; reason: string }> = [];
  for (const raw of [...new Set(urls)]) {
    const url = normalizeUrl(raw);
    if (!url) {
      skipped.push({ url: raw, reason: "not a valid http(s) URL" });
      continue;
    }
    if (!hostAllowed(url, [domain])) {
      skipped.push({ url, reason: `not on the official domain ${domain}` });
      continue;
    }
    const robots = await checkRobots(url).catch((e: unknown) => ({ allowed: false, reason: `robots.txt check failed: ${String(e).slice(0, 120)}` }));
    if (!robots.allowed) skipped.push({ url, reason: robots.reason ?? `robots.txt disallows ${new URL(url).pathname}` });
    else ok.push(url);
  }
  return { ok, skipped };
}

async function due(where: { brandId?: string; sourceId?: string }, frequencyHours: number, now: number): Promise<string | null> {
  const last = await db.commerceRun.findFirst({ where: { ...where, purpose: COUPON_PURPOSE, apifyRunId: { not: null } }, orderBy: { startedAt: "desc" } });
  if (!last) return null;
  if ([...ACTIVE, "SUCCEEDED", "COLLECTING"].includes(last.status)) return `run ${last.apifyRunId} is still ${last.status}`;
  // 30 minutes of slack so a daily cron landing a little early does not skip a day.
  if (now - last.startedAt.getTime() < Math.max(1, frequencyHours) * 3_600_000 - 30 * 60_000) return "not due yet";
  return null;
}

async function startRun(target: { brandId?: string; sourceId?: string; name: string; domain: string; urls: string[] }, trigger: string): Promise<StartResult> {
  const { ok, skipped } = await crawlableUrls(target.urls, target.domain);
  const base = { purpose: COUPON_PURPOSE, brandId: target.brandId ?? null, sourceId: target.sourceId ?? null, actorId: commerceActorId(), trigger };
  if (!ok.length) {
    const status = skipped.some((s) => /robots/i.test(s.reason)) ? "ROBOTS_DISALLOWED" : "SKIPPED";
    await db.commerceRun.create({ data: { ...base, status, startUrls: 0, errors: skipped, finishedAt: new Date() } });
    return { target: target.name, status, reason: skipped.map((s) => `${s.url}: ${s.reason}`).join("; "), skipped };
  }
  try {
    const q = new URLSearchParams({ timeout: String(Math.min(config.apify.runTimeoutSecs(), 600)), memory: "1024" });
    const { data } = await apify<{ data?: ApifyRunData }>(`/acts/${encodeURIComponent(commerceActorId().replace("/", "~"))}/runs?${q}`, { method: "POST", body: buildCouponActorInput(ok, target.name) });
    if (!data?.id) throw new PipelineError("APIFY_RESPONSE_INVALID", "Apify did not return a run id");
    await db.commerceRun.create({ data: { ...base, apifyRunId: data.id, datasetId: data.defaultDatasetId ?? null, status: data.status ?? "READY", startUrls: ok.length, errors: skipped.length ? skipped : undefined } });
    log.info("commerce coupon run started", { stage: "COMMERCE", target: target.name, runId: data.id, urls: ok.length });
    return { target: target.name, status: "STARTED", runId: data.id, ...(skipped.length ? { skipped } : {}) };
  } catch (error) {
    const e = error instanceof PipelineError ? error : new PipelineError("APIFY_RUN_FAILED", String(error));
    const failed = await db.commerceRun.create({ data: { ...base, status: "START_FAILED", startUrls: ok.length, errors: [{ code: e.code, message: e.message.slice(0, 300) }, ...skipped], finishedAt: new Date() } });
    await commerceAudit("APIFY_RUN_FAILED", "commerce_run", failed.id, { metadata: { purpose: COUPON_PURPOSE, target: target.name, stage: "start", code: e.code, reason: e.message } });
    return { target: target.name, status: e.code, reason: e.message };
  }
}

/** Starts one coupon run per due brand with promo URLs (and per approved+enabled coupon source, normally none). */
export async function runCouponCrawl(trigger: string): Promise<{ status: string; started: number; reason?: string; results?: StartResult[] }> {
  const gate = await allowed("commerce_engine");
  if (!gate.ok) return { status: "PAUSED", started: 0, reason: gate.reason };
  if (!apifyConfigured()) return { status: "BLOCKED_BY_ENVIRONMENT", started: 0, reason: "APIFY_API_TOKEN not configured" };
  const budget = commerceMonthlyBudgetUsd();
  const spent = await commerceSpendThisMonth();
  if (spent >= budget) return { status: "BUDGET_EXHAUSTED", started: 0, reason: `Commerce Apify spend this month $${spent.toFixed(2)} has reached the $${budget.toFixed(2)} budget (COMMERCE_MONTHLY_BUDGET_USD)` };

  const now = Date.now();
  const results: StartResult[] = [];
  const brands = await db.commerceBrand.findMany({ where: { enabled: true, promoUrls: { isEmpty: false } }, orderBy: [{ priority: "desc" }, { name: "asc" }] });
  for (const b of brands) {
    const wait = await due({ brandId: b.id }, b.crawlFrequencyHours, now);
    if (wait) {
      results.push({ target: b.slug, status: "NOT_DUE", reason: wait });
      continue;
    }
    results.push(await startRun({ brandId: b.id, name: b.slug, domain: b.officialDomain, urls: b.promoUrls }, trigger));
  }
  // Third-party coupon sites run only when an admin approved their terms and enabled them.
  const sources = await db.commerceSource.findMany({ where: { kind: "COUPON_SITE", enabled: true, termsStatus: "APPROVED", startUrls: { isEmpty: false } } });
  for (const s of sources) {
    if (!sourceRunnable(s)) continue;
    const wait = await due({ sourceId: s.id }, s.crawlFrequencyHours, now);
    if (wait) {
      results.push({ target: s.slug, status: "NOT_DUE", reason: wait });
      continue;
    }
    results.push(await startRun({ sourceId: s.id, name: s.slug, domain: s.domain, urls: s.startUrls }, trigger));
  }
  const started = results.filter((r) => r.status === "STARTED").length;
  return { status: "OK", started, results };
}

// ── Collect ──────────────────────────────────────────────────────────────

export type CouponCollectResult = { runId: string; status: string; pages?: number; candidates?: number; coupons?: number; dropped?: number; invalidated?: number; changed?: number; error?: string };

async function refresh(run: CommerceRun): Promise<CommerceRun> {
  const { data } = await apify<{ data?: ApifyRunData }>(`/actor-runs/${encodeURIComponent(run.apifyRunId!)}`);
  if (!data?.status) throw new PipelineError("APIFY_RESPONSE_INVALID", "Apify run status missing");
  return db.commerceRun.update({
    where: { id: run.id },
    data: {
      status: data.status,
      datasetId: data.defaultDatasetId ?? run.datasetId,
      finishedAt: data.finishedAt ? new Date(data.finishedAt) : run.finishedAt,
      ...(typeof data.usageTotalUsd === "number" && Number.isFinite(data.usageTotalUsd) ? { usageUsd: data.usageTotalUsd } : {}),
      ...(FAILED.includes(data.status) ? { errors: [{ code: "APIFY_RUN_FAILED", message: (data.statusMessage ?? data.status).slice(0, 300) }] } : {}),
    },
  });
}

/** Normalizes one stored page for a third-party source: only candidates whose own text names a known brand, attributed to that brand, never first-party. */
function thirdPartyCoupons(page: CouponRawPage, brands: Pick<CommerceBrand, "id" | "name" | "officialDomain" | "market">[]) {
  const out: Array<{ brandId: string; coupon: NormalizedCoupon }> = [];
  for (const b of brands) {
    const re = new RegExp(`\\b${b.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    const mine = page.candidates.filter((c) => re.test(c.context));
    if (!mine.length) continue;
    for (const coupon of normalizeCoupons({ ...page, candidates: mine, jsonLd: [] }, b).coupons) out.push({ brandId: b.id, coupon });
  }
  return out;
}

async function collectOne(run: CommerceRun & { brand: CommerceBrand | null; source: CommerceSource | null }): Promise<CouponCollectResult> {
  const claimed = await db.commerceRun.updateMany({ where: { id: run.id, status: "SUCCEEDED" }, data: { status: "COLLECTING" } });
  if (!claimed.count) return { runId: run.apifyRunId!, status: "ALREADY_COLLECTED" };
  try {
    if (!run.datasetId) throw new PipelineError("APIFY_RESPONSE_INVALID", "Run has no dataset");
    const q = new URLSearchParams({ clean: "true", format: "json", limit: "200" });
    const items = await apify<unknown>(`/datasets/${encodeURIComponent(run.datasetId)}/items?${q}`);
    if (!Array.isArray(items)) throw new PipelineError("APIFY_RESPONSE_INVALID", "Dataset items response is not an array");
    const now = new Date();
    const errors: Array<Record<string, string>> = [];
    const rawIds: Record<string, string> = {};
    const pages: CouponRawPage[] = [];
    for (const item of items) {
      const page = parseCouponPage(item);
      if (!page) {
        errors.push({ code: "APIFY_RESPONSE_INVALID", message: "item was not produced by the coupon page function" });
        continue;
      }
      const url = normalizeUrl(page.url) ?? page.url;
      // Stored exactly as Apify returned it; re-processing reads it again.
      const raw = await db.commerceRawRecord.upsert({
        where: { runId_url: { runId: run.id, url } },
        create: { runId: run.id, url, purpose: COUPON_PURPOSE, payload: item as Prisma.InputJsonValue, contentHash: sha256(JSON.stringify(item)), fetchedAt: now },
        update: {},
      });
      rawIds[url] = raw.id;
      pages.push({ ...page, url });
    }

    let candidates = 0;
    let dropped = 0;
    let invalidated = 0;
    let couponCount = 0;
    let changed = 0;
    if (run.brand) {
      const brand = run.brand;
      const official = pages.filter((p) => {
        if (hostAllowed(p.url, [brand.officialDomain])) return true;
        errors.push({ code: "SOURCE_NOT_ALLOWED", message: `${p.url} is not on ${brand.officialDomain}` });
        return false;
      });
      const all: NormalizedCoupon[] = [];
      for (const p of official) {
        candidates += p.candidates.length;
        const n = normalizeCoupons(p, brand);
        dropped += n.dropped.length;
        all.push(...n.coupons);
      }
      markCrossPageConflicts(all);
      changed += (await upsertCoupons({ brandId: brand.id, coupons: all, observedAt: now, rawIds, now })).changed;
      couponCount = all.length;
      for (const p of official) {
        const present = all.filter((c) => c.sourceUrl === p.url).map((c) => c.code);
        invalidated += (await recordDisappearances({ merchant: brand.name, sourceUrl: p.url, presentCodes: present, now })).invalid;
      }
    } else if (run.source) {
      const source = run.source;
      const brands = await db.commerceBrand.findMany({ where: { enabled: true }, select: { id: true, name: true, officialDomain: true, market: true } });
      for (const p of pages) {
        if (!hostAllowed(p.url, [source.domain])) {
          errors.push({ code: "SOURCE_NOT_ALLOWED", message: `${p.url} is not on ${source.domain}` });
          continue;
        }
        candidates += p.candidates.length;
        for (const { brandId, coupon } of thirdPartyCoupons(p, brands)) {
          changed += (await upsertCoupons({ brandId, coupons: [coupon], observedAt: now, rawIds, now })).changed;
          couponCount++;
        }
      }
    }
    changed += invalidated + (await markExpiredCoupons(now));
    await db.commerceRun.update({
      where: { id: run.id },
      data: { status: "COLLECTED", collectedAt: now, pagesProcessed: pages.length, extracted: candidates, accepted: couponCount, rejected: dropped + errors.length, errors: errors.length ? errors.slice(0, 50) : undefined },
    });
    log.info("commerce coupon run collected", { stage: "COMMERCE", runId: run.apifyRunId, pages: pages.length, coupons: couponCount });
    await commerceAudit("APIFY_RUN_COMPLETED", "commerce_run", run.id, { metadata: { purpose: COUPON_PURPOSE, target: run.brand?.slug ?? run.source?.slug ?? null, apifyRunId: run.apifyRunId, pages: pages.length, candidates, coupons: couponCount, dropped, invalidated, usageUsd: run.usageUsd ?? null } });
    return { runId: run.apifyRunId!, status: "COLLECTED", pages: pages.length, candidates, coupons: couponCount, dropped, invalidated, changed };
  } catch (error) {
    const e = error instanceof PipelineError ? error : new PipelineError("APIFY_RUN_FAILED", String(error));
    // Release the claim so the next collect retries (raw records and coupons are idempotent per run/URL).
    await db.commerceRun.update({ where: { id: run.id }, data: { status: e.retryable ? "SUCCEEDED" : "COLLECT_FAILED", errors: [{ code: e.code, message: e.message.slice(0, 300) }] } });
    if (!e.retryable) await commerceAudit("APIFY_RUN_FAILED", "commerce_run", run.id, { metadata: { purpose: COUPON_PURPOSE, apifyRunId: run.apifyRunId, stage: "collect", code: e.code, reason: e.message } });
    return { runId: run.apifyRunId!, status: e.code, error: e.message };
  }
}

/**
 * Polls unfinished COUPON runs, collects finished ones (raw records → normalize → verify →
 * upsert → disappearances) and marks expired coupons. Idempotent; safe to call on every
 * "commerce-collect" tick.
 */
export async function collectCouponRuns(trigger = "commerce-collect"): Promise<{ status: string; checked: number; collected: number; results: CouponCollectResult[]; expired?: number; reason?: string }> {
  if (!apifyConfigured()) {
    // Expiry needs no crawl: coupons whose stated end date passed stop being public on every collect.
    const expired = await markExpiredCoupons();
    if (expired) await revalidateCommerce();
    return { status: "BLOCKED_BY_ENVIRONMENT", checked: 0, collected: 0, results: [], expired, reason: "APIFY_API_TOKEN not configured" };
  }
  const runs = await db.commerceRun.findMany({ where: { purpose: COUPON_PURPOSE, apifyRunId: { not: null }, status: { in: [...ACTIVE, "SUCCEEDED"] } }, orderBy: { startedAt: "asc" }, take: 20, include: { brand: true, source: true } });
  const results: CouponCollectResult[] = [];
  for (const r of runs) {
    // A brand or source switched off (or whose terms approval was revoked) after its run started is never collected.
    const stillAllowed = r.brand ? r.brand.enabled : r.source ? sourceRunnable(r.source) : false;
    if (!stillAllowed) {
      if (ACTIVE.includes(r.status)) await apify(`/actor-runs/${encodeURIComponent(r.apifyRunId!)}/abort`, { method: "POST" }).catch(() => undefined);
      await db.commerceRun.update({ where: { id: r.id }, data: { status: "SOURCE_DISABLED", finishedAt: r.finishedAt ?? new Date(), errors: [{ code: "SOURCE_DISABLED", message: "Brand or source was disabled before collection; nothing stored" }] } });
      results.push({ runId: r.apifyRunId!, status: "SOURCE_DISABLED" });
      continue;
    }
    try {
      const fresh = ACTIVE.includes(r.status) ? await refresh(r) : r;
      if (fresh.status === "SUCCEEDED") results.push(await collectOne({ ...fresh, brand: r.brand, source: r.source }));
      else results.push({ runId: fresh.apifyRunId!, status: fresh.status });
    } catch (error) {
      const e = error instanceof PipelineError ? error : new PipelineError("APIFY_RUN_FAILED", String(error));
      results.push({ runId: r.apifyRunId!, status: e.code, error: e.message });
    }
  }
  const expired = await markExpiredCoupons();
  if (expired || results.some((x) => (x.changed ?? 0) > 0)) await revalidateCommerce();
  log.info("commerce coupon collect", { stage: "COMMERCE", trigger, checked: runs.length, expired });
  return { status: "OK", checked: runs.length, collected: results.filter((x) => x.status === "COLLECTED").length, results, expired };
}
