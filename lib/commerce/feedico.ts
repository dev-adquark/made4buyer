import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { config } from "@/lib/config";
import { log } from "@/lib/log";
import { safeFetch } from "@/lib/net/safe-fetch";
import { registrableDomain } from "@/lib/net/ip";
import { sha256 } from "@/lib/util/text";
import { commerceAudit } from "./audit";
import { ensureBrandsSeeded } from "./brands";
import { markExpiredCoupons, notACodeReason, recordDisappearances, statedDiscount, upsertCoupons, type NormalizedCoupon } from "./coupons";
import { officialDomainsOf } from "./deal-status";
import { sourceRunnable } from "./sources";
import { recordVerification, type VerificationEventInput } from "./verification-events";

/**
 * Feedico (https://feedico.io): an approved external coupon FEED, read through its catalogue API
 * (POST /api/v1/catalog/coupons, Bearer FEEDICO_API_KEY, server-side only).
 *
 * What it adds: promo codes that merchants publish through affiliate networks (CJ, Impact, Awin, …),
 * for the brands in our registry only, matched by the merchant's exact website domain.
 *
 * What it never does: make a code public on its own. A Feedico row's source is the Feedico API, not
 * the brand's site, so the existing public rule (lib/commerce/deal-status.ts couponDealStatus: a code
 * is public only from the brand's official site/store, verified within 7 days) keeps it an Admin
 * candidate (UNVERIFIED) unless the brand's own promotions page also publishes the code.
 *
 * Schedule: the feedico-coupons job runs once a week (vercel.json, Sunday 09:50 UTC) and fetches
 * every enabled brand. A re-run within FEEDICO_MIN_REFETCH_HOURS (20) skips brands already fetched.
 * Requests: one per brand (a second page only when a brand has more than 200 matches) ≈ 100/week,
 * capped by FEEDICO_MONTHLY_REQUEST_BUDGET (600) under the Free plan's 1,000/month; the cap is counted
 * per UTC month before each request (attempts, not just successes), and a 429 from Feedico ends the month.
 *
 * Freshness (14 days): a row is accepted only when Feedico's own fetchedAt is within
 * FEEDICO_MAX_FEED_AGE_DAYS (14; no fetchedAt = age unknown = rejected). Every run then deactivates
 * (INVALID, never deleted) each stored Feedico code whose latest Feedico confirmation is older than
 * 14 days, read from the raw response it was stored from. A code Feedico confirms again is reactivated.
 *
 * Data safety: a failed, malformed or quota-refused response changes nothing (the last good data
 * stays). A code disappears only after two consecutive successful fetches without it (INVALID), and a
 * stated expiry that has passed makes it EXPIRED. Rows are never deleted.
 */

export const FEEDICO_SOURCE_SLUG = "feedico";
export const FEEDICO_SOURCE_KIND = "COUPON_FEED";
const STATE_KEY = "feedico:state";
const COUPON_PURPOSE = "COUPON";
const ACTOR = "feedico:catalog/coupons";
const PAGE_SIZE = 200;

export function feedicoConfigured(): boolean {
  return Boolean(config.feedico.apiKey());
}

// ── API ──────────────────────────────────────────────────────────────────

/** One row of POST /api/v1/catalog/coupons (contract: feedico.io/openapi-customer.yaml, v1.4). */
export type FeedicoCouponRow = {
  id: string;
  brandName: string;
  provider: string | null;
  code: string;
  title: string | null;
  description: string | null;
  startsAt: string | null;
  endsAt: string | null;
  merchantWebsiteUrl: string | null;
  fetchedAt: string | null;
};

export type FeedicoPage = { recordCount: number; page: number; pageSize: number; coupons: FeedicoCouponRow[] };

export type FeedicoFetchError = { kind: "AUTH_FAILED" | "QUOTA_EXCEEDED" | "BAD_REQUEST" | "RESPONSE_INVALID" | "UNAVAILABLE"; status: number; message: string };

const str = (v: unknown, max = 500): string | null => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, max) : null);

/** Validates a response body; anything that is not the documented shape is null (never partially used). */
export function parseFeedicoPage(body: unknown): FeedicoPage | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.ok !== true || !Array.isArray(b.coupons) || typeof b.recordCount !== "number") return null;
  const coupons: FeedicoCouponRow[] = [];
  for (const raw of b.coupons) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = str(r.id, 120);
    const code = str(r.code, 60);
    const brandName = str(r.brandName, 200);
    if (!id || !code || !brandName) continue;
    coupons.push({ id, code, brandName, provider: str(r.provider, 60), title: str(r.title, 300), description: str(r.description, 1000), startsAt: str(r.startsAt, 40), endsAt: str(r.endsAt, 40), merchantWebsiteUrl: str(r.merchantWebsiteUrl, 300), fetchedAt: str(r.fetchedAt, 40) });
  }
  return { recordCount: b.recordCount, page: typeof b.page === "number" ? b.page : 1, pageSize: typeof b.pageSize === "number" ? b.pageSize : PAGE_SIZE, coupons };
}

/** One catalogue request. The key is sent only in the Authorization header and never logged or returned. */
export async function fetchFeedicoCoupons(body: { page: number; pageSize: number; firmName?: string }): Promise<{ ok: true; page: FeedicoPage } | { ok: false; error: FeedicoFetchError }> {
  const key = config.feedico.apiKey();
  if (!key) return { ok: false, error: { kind: "AUTH_FAILED", status: 0, message: "FEEDICO_API_KEY not configured" } };
  const res = await safeFetch(`${config.feedico.baseUrl()}/api/v1/catalog/coupons`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 20_000,
    maxRedirects: 0,
    readBody: true,
    maxBytes: 4_000_000,
  });
  if (res.error) return { ok: false, error: { kind: "UNAVAILABLE", status: 0, message: `${res.error.kind}` } };
  if (res.status === 401 || res.status === 403) return { ok: false, error: { kind: "AUTH_FAILED", status: res.status, message: "Feedico rejected the API key (check FEEDICO_API_KEY)" } };
  if (res.status === 429) return { ok: false, error: { kind: "QUOTA_EXCEEDED", status: 429, message: "Feedico monthly API quota exceeded (monthly_api_limit)" } };
  if (res.status === 400) return { ok: false, error: { kind: "BAD_REQUEST", status: 400, message: "Feedico rejected the request body" } };
  if (res.status !== 200) return { ok: false, error: { kind: "UNAVAILABLE", status: res.status, message: `HTTP ${res.status}` } };
  let json: unknown;
  try {
    json = JSON.parse(res.body ?? "");
  } catch {
    return { ok: false, error: { kind: "RESPONSE_INVALID", status: 200, message: "response is not JSON" } };
  }
  const page = parseFeedicoPage(json);
  if (!page) return { ok: false, error: { kind: "RESPONSE_INVALID", status: 200, message: "response is not a coupon page (ok/recordCount/coupons missing)" } };
  return { ok: true, page };
}

// ── Normalization (pure) ─────────────────────────────────────────────────

export type FeedicoBrand = { id: string; slug: string; name: string; officialDomain: string; officialStoreUrl?: string | null };

/** Parses a Feedico timestamp ("2026-01-01T00:00:00.000Z" or "2026-01-01 00:00:00", UTC). Year ≥ 2100 is a "no end" placeholder → null. */
export function feedicoDate(v: string | null): Date | null {
  if (!v) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(v) ? `${v.replace(" ", "T")}Z` : v;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  return y < 1990 || y >= 2100 ? null : d;
}

/** The stable per-brand source URL of Feedico rows (never on the brand's domain, so never first-party). */
export function feedicoSourceUrl(brand: Pick<FeedicoBrand, "officialDomain">): string {
  const domain = brand.officialDomain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  return `${config.feedico.baseUrl()}/api/v1/catalog/coupons?merchant=${encodeURIComponent(domain)}`;
}

function merchantMatches(url: string | null, brand: FeedicoBrand): boolean {
  if (!url) return false;
  try {
    const host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, "");
    return officialDomainsOf({ name: brand.name, officialDomain: brand.officialDomain, officialStoreUrl: brand.officialStoreUrl ?? null }).has(registrableDomain(host));
  } catch {
    return false;
  }
}

export type FeedicoNormalized = { coupons: NormalizedCoupon[]; dropped: Array<{ id: string; reason: string }>; matched: number };

/**
 * Feedico rows → coupon records for ONE brand, using only what the row states. A row is kept only
 * when its merchant website is the brand's own domain, the code is a real code, and Feedico confirmed
 * it (fetchedAt) within FEEDICO_MAX_FEED_AGE_DAYS (14). Duplicates of one code (several networks) are merged; rows that
 * disagree on the stated offer or end date mark the code CONFLICTING.
 */
export function normalizeFeedicoRows(rows: FeedicoCouponRow[], brand: FeedicoBrand, now = new Date()): FeedicoNormalized {
  const dropped: FeedicoNormalized["dropped"] = [];
  const byCode = new Map<string, NormalizedCoupon & { seen: number }>();
  const sourceUrl = feedicoSourceUrl(brand);
  const maxAge = config.feedico.maxFeedAgeDays() * 86_400_000;
  let matched = 0;
  for (const r of rows) {
    if (!merchantMatches(r.merchantWebsiteUrl, brand)) continue; // another merchant (the firmName filter is a substring search)
    matched++;
    const code = r.code.trim().toUpperCase();
    const bad = notACodeReason(code);
    if (bad) {
      dropped.push({ id: r.id, reason: `code: ${bad}` });
      continue;
    }
    const seen = feedicoDate(r.fetchedAt);
    if (!seen) {
      dropped.push({ id: r.id, reason: "no fetchedAt: age unknown" });
      continue;
    }
    if (now.getTime() - seen.getTime() > maxAge) {
      dropped.push({ id: r.id, reason: `stale: Feedico last confirmed it ${seen.toISOString().slice(0, 10)}, over ${config.feedico.maxFeedAgeDays()} days ago` });
      continue;
    }
    const expiresAt = feedicoDate(r.endsAt);
    const startsAt = feedicoDate(r.startsAt);
    const disc = statedDiscount([r.title, r.description].filter(Boolean).join(". "), code);
    let merchantUrl: string | null = null;
    try {
      merchantUrl = r.merchantWebsiteUrl ? new URL(/^https?:\/\//i.test(r.merchantWebsiteUrl) ? r.merchantWebsiteUrl : `https://${r.merchantWebsiteUrl}`).origin : null;
    } catch {
      merchantUrl = null;
    }
    const next: NormalizedCoupon & { seen: number } = {
      merchant: brand.name,
      code,
      title: r.title,
      description: r.description,
      discount: disc?.discount ?? null,
      discountType: disc?.type ?? null,
      startsAt,
      expiresAt,
      eligibility: null,
      restrictions: null,
      sourceUrl,
      merchantUrl,
      firstParty: false,
      evidence: "MARKED",
      sufficient: true,
      conflict: null,
      seen: seen.getTime(),
    };
    const prev = byCode.get(code);
    if (!prev) {
      byCode.set(code, next);
      continue;
    }
    const clash: string[] = [];
    if (prev.discount && next.discount && prev.discount.toLowerCase() !== next.discount.toLowerCase()) clash.push(`offer "${prev.discount}" vs "${next.discount}"`);
    if (prev.expiresAt && next.expiresAt && prev.expiresAt.getTime() !== next.expiresAt.getTime()) clash.push(`end ${prev.expiresAt.toISOString().slice(0, 10)} vs ${next.expiresAt.toISOString().slice(0, 10)}`);
    const keep = next.seen > prev.seen ? next : prev;
    if (clash.length) keep.conflict = `Feedico rows for ${code} disagree: ${clash.join("; ")}`;
    else if (prev.conflict) keep.conflict = prev.conflict;
    byCode.set(code, keep);
  }
  const coupons = [...byCode.values()].map(({ seen: _seen, ...c }) => c);
  return { coupons, dropped, matched };
}

// ── State (request budget, per-brand freshness) ──────────────────────────

type BrandState = { at: string; ok: boolean; codes?: number; error?: string };
type FeedicoState = { month: string; requests: number; quotaExceeded?: boolean; brands: Record<string, BrandState> };

const monthOf = (d: Date) => d.toISOString().slice(0, 7);

async function readState(now: Date): Promise<FeedicoState> {
  const row = await db.automationSetting.findUnique({ where: { key: STATE_KEY } }).catch(() => null);
  let s: FeedicoState = { month: monthOf(now), requests: 0, brands: {} };
  if (row) {
    try {
      const v = JSON.parse(row.value) as FeedicoState;
      if (v && typeof v === "object" && v.brands) s = v;
    } catch {
      /* unreadable state: counting restarts at 0; Feedico's own 429 (monthly_api_limit) remains the hard stop */
    }
  }
  if (s.month !== monthOf(now)) s = { ...s, month: monthOf(now), requests: 0, quotaExceeded: false };
  return s;
}

async function writeState(s: FeedicoState): Promise<void> {
  const value = JSON.stringify(s);
  await db.automationSetting.upsert({ where: { key: STATE_KEY }, create: { key: STATE_KEY, value, updatedBy: "feedico-coupons" }, update: { value, updatedBy: "feedico-coupons" } });
}

/** Read-only view for Admin / verification: this month's request count and budget. */
export async function feedicoUsage(now = new Date()): Promise<{ month: string; requests: number; budget: number; quotaExceeded: boolean; brandsRefreshed: number }> {
  const s = await readState(now);
  return { month: s.month, requests: s.requests, budget: config.feedico.monthlyRequestBudget(), quotaExceeded: Boolean(s.quotaExceeded), brandsRefreshed: Object.values(s.brands).filter((b) => b.ok).length };
}

/** The Feedico source row (created once, approved and enabled; an admin may disable it later in Admin → Sources). */
export async function ensureFeedicoSource() {
  const existing = await db.commerceSource.findUnique({ where: { slug: FEEDICO_SOURCE_SLUG } });
  if (existing) return existing;
  return db.commerceSource.create({
    data: {
      name: "Feedico coupon feed",
      slug: FEEDICO_SOURCE_SLUG,
      kind: FEEDICO_SOURCE_KIND,
      domain: "api.feedico.io",
      enabled: true,
      termsStatus: "APPROVED",
      crawlFrequencyHours: 7 * 24,
      notes: "Affiliate-network promo codes via the Feedico catalogue API (POST /api/v1/catalog/coupons). Admin candidates only: a Feedico code is public only when the brand's own official page also publishes it.",
    },
  });
}

// ── Sync job ─────────────────────────────────────────────────────────────

export type FeedicoSyncResult = {
  status: string;
  reason?: string;
  brandsChecked: number;
  brandsFailed: number;
  requests: number;
  requestsThisMonth: number;
  budget: number;
  coupons: number;
  created: number;
  changed: number;
  dropped: number;
  invalidated: number;
  expired: number;
  remaining: number;
  /** Stored Feedico codes deactivated because Feedico's latest confirmation is older than 14 days. */
  deactivated: number;
  failures?: Array<{ brand: string; error: string }>;
};

export type FeedicoSyncOptions = { now?: Date; deadlineMs?: number; brandLimit?: number; force?: boolean };

/**
 * The weekly sync: fetches every enabled brand not fetched successfully within FEEDICO_MIN_REFETCH_HOURS
 * (so a re-run only retries failures), up to FEEDICO_BRANDS_PER_RUN and the time budget, then deactivates
 * every stored Feedico code older than 14 days. The sweep runs even when nothing could be fetched (no
 * key, source disabled, quota reached): stale codes are deactivated either way. Progress is saved after
 * every brand, so an interrupted run resumes where it stopped.
 */
export async function runFeedicoSync(trigger: string, opts: FeedicoSyncOptions = {}): Promise<FeedicoSyncResult> {
  const now = opts.now ?? new Date();
  const result = await fetchAndStore(trigger, { ...opts, now });
  result.deactivated = await deactivateStaleFeedicoCoupons(now);
  if (result.deactivated) log.info("feedico stale coupons deactivated", { stage: "COMMERCE", deactivated: result.deactivated, maxAgeDays: config.feedico.maxFeedAgeDays() });
  return result;
}

async function fetchAndStore(trigger: string, opts: FeedicoSyncOptions & { now: Date }): Promise<FeedicoSyncResult> {
  const now = opts.now;
  const deadline = Date.now() + (opts.deadlineMs ?? 240_000);
  const budget = config.feedico.monthlyRequestBudget();
  const base: FeedicoSyncResult = { status: "OK", brandsChecked: 0, brandsFailed: 0, requests: 0, requestsThisMonth: 0, budget, coupons: 0, created: 0, changed: 0, dropped: 0, invalidated: 0, expired: 0, remaining: 0, deactivated: 0 };
  if (!feedicoConfigured()) return { ...base, status: "BLOCKED_BY_ENVIRONMENT", reason: "FEEDICO_API_KEY not configured" };

  const source = await ensureFeedicoSource();
  if (!sourceRunnable(source)) return { ...base, status: "DISABLED", reason: "The Feedico source is disabled or its terms approval was revoked (Admin → Commerce → Coupons → Sources)" };
  const state = await readState(now);
  base.requestsThisMonth = state.requests;
  if (state.quotaExceeded) return { ...base, status: "BUDGET_EXHAUSTED", reason: `Feedico reported its monthly quota exceeded for ${state.month}; the next sync runs next month` };
  if (state.requests >= budget) return { ...base, status: "BUDGET_EXHAUSTED", reason: `${state.requests} of ${budget} Feedico requests used in ${state.month} (FEEDICO_MONTHLY_REQUEST_BUDGET)` };

  await ensureBrandsSeeded();
  const brands = await db.commerceBrand.findMany({ where: { enabled: true }, orderBy: [{ priority: "desc" }, { name: "asc" }], select: { id: true, slug: true, name: true, officialDomain: true, officialStoreUrl: true } });
  const refetchMs = config.feedico.minRefetchHours() * 3_600_000;
  // Due: every brand not fetched successfully within the last 20 h (never fetched and failed first).
  const due = brands
    .filter((b) => {
      const st = state.brands[b.slug];
      return opts.force || !st || !st.ok || now.getTime() - Date.parse(st.at) >= refetchMs;
    })
    .sort((a, b) => (Date.parse(state.brands[a.slug]?.at ?? "") || 0) - (Date.parse(state.brands[b.slug]?.at ?? "") || 0));
  if (!due.length) return { ...base, status: "NOT_DUE", reason: `Every brand was fetched within the last ${config.feedico.minRefetchHours()} hours` };

  const run = await db.commerceRun.create({ data: { purpose: COUPON_PURPOSE, sourceId: source.id, actorId: ACTOR, trigger, status: "RUNNING", startUrls: 0 } });
  const limit = Math.min(opts.brandLimit ?? config.feedico.brandsPerRun(), due.length);
  const failures: Array<{ brand: string; error: string }> = [];
  let stop: { status: string; reason: string } | null = null;
  let consecutiveFailures = 0;
  const out = { ...base };

  /** Counts the attempt against the monthly budget before making it. */
  const request = async (body: { page: number; pageSize: number; firmName?: string }) => {
    if (state.requests >= budget) return { ok: false as const, error: { kind: "QUOTA_EXCEEDED" as const, status: 0, message: `request budget ${budget} for ${state.month} reached` }, local: true };
    state.requests++;
    out.requests++;
    await writeState(state);
    return { ...(await fetchFeedicoCoupons(body)), local: false };
  };

  for (const brand of due.slice(0, limit)) {
    if (Date.now() > deadline) break;
    // Pages: 1, plus page 2.. only while this brand has more matches (bounded).
    const rows: FeedicoCouponRow[] = [];
    let error: FeedicoFetchError | null = null;
    for (let page = 1; page <= config.feedico.maxPagesPerBrand(); page++) {
      let res = await request({ page, pageSize: PAGE_SIZE, firmName: brand.name });
      // One retry for a transient failure (network, timeout, 5xx).
      if (!res.ok && res.error.kind === "UNAVAILABLE" && state.requests < budget) {
        await new Promise((r) => setTimeout(r, 1500));
        res = await request({ page, pageSize: PAGE_SIZE, firmName: brand.name });
      }
      if (!res.ok) {
        error = res.error;
        if (res.error.kind === "QUOTA_EXCEEDED" && !res.local) state.quotaExceeded = true;
        break;
      }
      rows.push(...res.page.coupons);
      if (page * PAGE_SIZE >= res.page.recordCount || res.page.coupons.length < PAGE_SIZE) break;
    }

    if (error) {
      out.brandsFailed++;
      consecutiveFailures++;
      failures.push({ brand: brand.slug, error: `${error.kind}: ${error.message}` });
      state.brands[brand.slug] = { at: now.toISOString(), ok: false, error: `${error.kind}: ${error.message}`.slice(0, 200) };
      await writeState(state);
      if (error.kind === "AUTH_FAILED") stop = { status: "AUTH_FAILED", reason: error.message };
      else if (error.kind === "QUOTA_EXCEEDED") stop = { status: "BUDGET_EXHAUSTED", reason: error.message };
      else if (consecutiveFailures >= 3) stop = { status: "FAILED", reason: `Feedico failed for 3 brands in a row (last: ${error.message})` };
      if (stop) break;
      continue;
    }
    consecutiveFailures = 0;

    // A successful fetch: store exactly what came back for this brand, then the coupons.
    const sourceUrl = feedicoSourceUrl(brand);
    const n = normalizeFeedicoRows(rows, brand, now);
    const matchedRows = rows.filter((r) => n.coupons.some((c) => c.code === r.code.trim().toUpperCase()) || n.dropped.some((d) => d.id === r.id));
    const payload = { provider: "feedico", endpoint: "POST /api/v1/catalog/coupons", firmName: brand.name, fetchedAt: now.toISOString(), returned: rows.length, matched: n.matched, rows: matchedRows };
    const raw = await db.commerceRawRecord.upsert({
      where: { runId_url: { runId: run.id, url: sourceUrl } },
      create: { runId: run.id, url: sourceUrl, purpose: COUPON_PURPOSE, payload: payload as Prisma.InputJsonValue, contentHash: sha256(JSON.stringify(matchedRows)), fetchedAt: now },
      update: {},
    });
    const up = await upsertCoupons({ brandId: brand.id, coupons: n.coupons, observedAt: now, rawIds: { [sourceUrl]: raw.id }, now });
    const gone = await recordDisappearances({ merchant: brand.name, sourceUrl, presentCodes: n.coupons.map((c) => c.code), now });
    out.brandsChecked++;
    out.coupons += n.coupons.length;
    out.created += up.created;
    out.changed += up.changed + gone.invalid;
    out.dropped += n.dropped.length;
    out.invalidated += gone.invalid;
    state.brands[brand.slug] = { at: now.toISOString(), ok: true, codes: n.coupons.length };
    await writeState(state);
  }

  out.expired = await markExpiredCoupons(now);
  out.remaining = Math.max(0, due.length - out.brandsChecked - out.brandsFailed);
  out.requestsThisMonth = state.requests;
  if (failures.length) out.failures = failures.slice(0, 20);
  if (stop) {
    out.status = stop.status;
    out.reason = stop.reason;
  } else if (out.brandsFailed && !out.brandsChecked) {
    out.status = "FAILED";
    out.reason = failures[0]?.error;
  }
  const failed = out.status !== "OK";
  await db.commerceRun.update({
    where: { id: run.id },
    data: { status: failed ? "FAILED" : "COLLECTED", finishedAt: new Date(), collectedAt: failed ? null : new Date(), startUrls: out.brandsChecked + out.brandsFailed, pagesProcessed: out.requests, extracted: out.coupons + out.dropped, accepted: out.coupons, rejected: out.dropped, errors: failures.length ? (failures.slice(0, 50) as Prisma.InputJsonValue) : undefined },
  });
  await db.commerceSource.update({
    where: { id: source.id },
    data: failed
      ? { crawlStatus: out.status, consecutiveFailures: { increment: 1 }, lastError: (out.reason ?? "").slice(0, 300), lastCrawlAt: now }
      : { crawlStatus: "OK", consecutiveFailures: 0, lastError: out.brandsFailed ? `${out.brandsFailed} brand fetch(es) failed; retried next run` : null, lastCrawlAt: now, nextCrawlAt: new Date(now.getTime() + 7 * 86_400_000) },
  });
  await commerceAudit(failed ? "COUPON_FEED_FAILED" : "COUPON_FEED_SYNCED", "commerce_run", run.id, { metadata: { purpose: COUPON_PURPOSE, provider: "feedico", target: FEEDICO_SOURCE_SLUG, status: out.status, reason: out.reason, brands: out.brandsChecked, failed: out.brandsFailed, requests: out.requests, requestsThisMonth: state.requests, coupons: out.coupons, created: out.created, invalidated: out.invalidated } });
  log.info("feedico coupon sync", { stage: "COMMERCE", status: out.status, brands: out.brandsChecked, failed: out.brandsFailed, requests: out.requests, month: state.month, used: state.requests, budget, coupons: out.coupons });
  return out;
}

// ── 14-day freshness sweep ───────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** Feedico's latest confirmation (max fetchedAt) of `code` in a stored raw response, or null. */
function confirmedAt(payload: unknown, code: string): Date | null {
  const rows = payload && typeof payload === "object" ? (payload as { rows?: unknown }).rows : null;
  if (!Array.isArray(rows)) return null;
  let best: Date | null = null;
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const row = r as { code?: unknown; fetchedAt?: unknown };
    if (typeof row.code !== "string" || row.code.trim().toUpperCase() !== code) continue;
    const d = feedicoDate(typeof row.fetchedAt === "string" ? row.fetchedAt : null);
    if (d && (!best || d > best)) best = d;
  }
  return best;
}

/**
 * Deactivates (INVALID, never deleted) every active stored Feedico code whose latest Feedico
 * confirmation is older than FEEDICO_MAX_FEED_AGE_DAYS (14), or cannot be established. Read from the
 * raw response each row was stored from. An admin's own "mark invalid" and EXPIRED rows are left alone.
 */
export async function deactivateStaleFeedicoCoupons(now = new Date()): Promise<number> {
  const maxDays = config.feedico.maxFeedAgeDays();
  const cutoff = now.getTime() - maxDays * DAY_MS;
  const rows = await db.commerceCoupon.findMany({
    where: { sourceUrl: { startsWith: `${config.feedico.baseUrl()}/api/v1/catalog/coupons` }, status: { notIn: ["INVALID", "EXPIRED"] } },
    select: { id: true, code: true, status: true, sourceUrl: true, sourceRawId: true, observedAt: true },
  });
  if (!rows.length) return 0;
  const rawIds = [...new Set(rows.map((r) => r.sourceRawId).filter((x): x is string => Boolean(x)))];
  const raws = rawIds.length ? await db.commerceRawRecord.findMany({ where: { id: { in: rawIds } }, select: { id: true, payload: true } }) : [];
  const payloadOf = new Map(raws.map((r) => [r.id, r.payload]));
  const events: VerificationEventInput[] = [];
  let deactivated = 0;
  for (const c of rows) {
    const at = c.sourceRawId ? confirmedAt(payloadOf.get(c.sourceRawId), c.code) : null;
    if (at && at.getTime() >= cutoff) continue;
    const evidence = at ? `Feedico last confirmed it on ${at.toISOString().slice(0, 10)}, more than ${maxDays} days ago (checked ${now.toISOString()})` : `No Feedico confirmation date on record for this code; deactivated by the ${maxDays}-day rule (checked ${now.toISOString()})`;
    await db.commerceCoupon.update({ where: { id: c.id }, data: { status: "INVALID", verificationEvidence: evidence } });
    await commerceAudit("COUPON_INVALIDATED", "commerce_coupon", c.id, { before: { status: c.status }, after: { status: "INVALID" }, metadata: { code: c.code, evidence, rule: `feedico-${maxDays}-day-freshness` } });
    events.push({ entityType: "coupon", entityId: c.id, kind: "COUPON", result: "INVALID", reason: evidence, sourceUrl: c.sourceUrl, details: { code: c.code, previous: c.status, changed: true, check: "FEED_FRESHNESS" }, checkedAt: now });
    deactivated++;
  }
  await recordVerification(events);
  return deactivated;
}
