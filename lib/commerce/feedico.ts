import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { config } from "@/lib/config";
import { log } from "@/lib/log";
import { safeFetch } from "@/lib/net/safe-fetch";
import { registrableDomain } from "@/lib/net/ip";
import { guardedApiCall } from "@/lib/ops/api-guard";
import { sha256 } from "@/lib/util/text";
import { commerceAudit } from "./audit";
import { ensureBrandsSeeded } from "./brands";
import { revalidateCommerce } from "./revalidate";
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
 * Public (owner decision, 2026-10-09): a Feedico code is shown on the site in its own right (tier 5,
 * lib/commerce/deal-status.ts), labelled "Via Feedico", while it is stored UNVERIFIED (not seen on the
 * brand's own page), listed in a sync within 14 days, started and unexpired. The brand's own page still
 * outranks it: the same code verified there is shown once, as the official one. Every sync purges the
 * deals cache so the site shows the latest feed.
 *
 * Schedule: the feedico-coupons job runs once a week (vercel.json `0 6 * * 5`: Friday 06:00 UTC = 11:30 IST) and fetches
 * every enabled brand. A re-run within FEEDICO_MIN_REFETCH_HOURS (12) skips brands already fetched.
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
const FEEDICO_SOURCE_NOTES = "Affiliate-network promo codes via the Feedico catalogue API (POST /api/v1/catalog/coupons). Public, labelled \"Via Feedico\", while listed within 14 days; a code verified on the brand's own page is shown as the official one.";
const OLD_SOURCE_NOTES_PREFIX = "Affiliate-network promo codes via the Feedico catalogue API (POST /api/v1/catalog/coupons). Admin candidates only";

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

export type FeedicoFetchError = { kind: "AUTH_FAILED" | "QUOTA_EXCEEDED" | "BAD_REQUEST" | "RESPONSE_INVALID" | "UNAVAILABLE" | "SKIPPED"; status: number; message: string };

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

export type FeedicoBrand = { id: string | null; slug: string; name: string; officialDomain: string; officialStoreUrl?: string | null };

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
type FeedicoState = { month: string; requests: number; quotaExceeded?: boolean; brands: Record<string, BrandState>; catalogAt?: string; catalogComplete?: boolean; recordCount?: number };

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

/** The Feedico source row (created once, approved and enabled; an admin may disable it later in Admin → Commerce → Coupons → Sources). */
export async function ensureFeedicoSource() {
  const existing = await db.commerceSource.findUnique({ where: { slug: FEEDICO_SOURCE_SLUG } });
  // The notes describe what the source does; refresh the original wording only (an admin's own notes are kept).
  if (existing?.notes?.startsWith(OLD_SOURCE_NOTES_PREFIX)) return db.commerceSource.update({ where: { id: existing.id }, data: { notes: FEEDICO_SOURCE_NOTES } });
  if (existing) return existing;
  // Two concurrent first syncs may both try to create it: the loser reads the winner's row.
  return db.commerceSource.create({
    data: {
      name: "Feedico coupon feed",
      slug: FEEDICO_SOURCE_SLUG,
      kind: FEEDICO_SOURCE_KIND,
      domain: "api.feedico.io",
      enabled: true,
      termsStatus: "APPROVED",
      crawlFrequencyHours: 7 * 24,
      notes: FEEDICO_SOURCE_NOTES,
    },
  }).catch(async (error: unknown) => {
    const row = await db.commerceSource.findUnique({ where: { slug: FEEDICO_SOURCE_SLUG } });
    if (row) return row;
    throw error;
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
  /** Catalogue read: Feedico's total coded coupons, pages read, whether every page was read, rows read, merchants. */
  recordCount?: number;
  pages?: number;
  complete?: boolean;
  fetchedRows?: number;
  merchants?: number;
  /** Brands whose request preflight refused (duplicate trigger, invalid parameters, database not ready): not called. */
  brandsSkipped?: number;
  /** Stored Feedico codes deactivated because Feedico's latest confirmation is older than 14 days. */
  deactivated: number;
  failures?: Array<{ brand: string; error: string }>;
};

export type FeedicoSyncOptions = { now?: Date; deadlineMs?: number; brandLimit?: number; force?: boolean };

/**
 * The weekly sync: fetches every enabled brand not fetched successfully within FEEDICO_MIN_REFETCH_HOURS
 * (12; so a same-day re-run only retries failures), up to FEEDICO_BRANDS_PER_RUN and the time budget, then deactivates
 * every stored Feedico code older than 14 days. The sweep runs even when nothing could be fetched (no
 * key, source disabled, quota reached): stale codes are deactivated either way. Progress is saved after
 * every brand, so an interrupted run resumes where it stopped.
 */
export async function runFeedicoSync(trigger: string, opts: FeedicoSyncOptions = {}): Promise<FeedicoSyncResult> {
  const now = opts.now ?? new Date();
  const result = await fetchAndStore(trigger, { ...opts, now });
  result.deactivated = await deactivateStaleFeedicoCoupons(now);
  if (result.deactivated) log.info("feedico stale coupons deactivated", { stage: "COMMERCE", deactivated: result.deactivated, maxAgeDays: config.feedico.maxFeedAgeDays() });
  // Feed codes are public: the homepage, /deals, search and review pages show this sync's result now.
  if (result.brandsChecked || result.deactivated || result.expired) await revalidateCommerce().catch((error: unknown) => log.warn("feedico revalidation failed", { stage: "COMMERCE", error: String(error).slice(0, 200) }));
  return result;
}

/** "Banggood CJ Affiliate Program" → "Banggood": the merchant's name without the network/programme suffix. */
export function merchantName(brandName: string): string {
  const cleaned = brandName
    .replace(/\s*[-–|(]?\s*(?:cj|impact|awin|rakuten|shareasale|admitad|partnerize|flexoffers|pepperjam|webgains|tradedoubler)?\s*(?:affiliate|partner)?\s*program(?:me)?\)?\s*$/i, "")
    .replace(/\s+(?:affiliates?|partners?)$/i, "")
    .trim();
  return (cleaned || brandName).slice(0, 120);
}

const domainOf = (url: string | null): string | null => {
  if (!url) return null;
  try {
    return registrableDomain(new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, ""));
  } catch {
    return null;
  }
};

/** A stable slug for a merchant that has no brand in the registry: its domain. */
export const merchantSlug = (domain: string) => `m-${domain.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;

/**
 * The weekly sync: reads the WHOLE Feedico catalogue of coded coupons (every merchant), page by page —
 * one guarded request per page, no retry — and stores every valid, current code. A merchant whose
 * website is a registry brand's domain is stored under that brand (shown on its review pages too);
 * any other merchant under its own name. Rows without a merchant website, codes that are not codes,
 * expired or not-yet-started codes, and rows Feedico has not confirmed within 14 days are not stored.
 * After a COMPLETE read, a stored Feedico code that is no longer listed is deactivated (INVALID).
 */
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
  // A re-run within FEEDICO_MIN_REFETCH_HOURS after a complete read is a no-op.
  if (!opts.force && state.catalogAt && state.catalogComplete && now.getTime() - Date.parse(state.catalogAt) < config.feedico.minRefetchHours() * 3_600_000) {
    return { ...base, status: "NOT_DUE", reason: `The Feedico catalogue was read within the last ${config.feedico.minRefetchHours()} hours` };
  }

  await ensureBrandsSeeded();
  const brands = await db.commerceBrand.findMany({ where: { enabled: true }, select: { id: true, slug: true, name: true, officialDomain: true, officialStoreUrl: true } });
  const brandByDomain = new Map<string, (typeof brands)[number]>();
  for (const b of brands) for (const d of officialDomainsOf({ name: b.name, officialDomain: b.officialDomain, officialStoreUrl: b.officialStoreUrl })) if (!brandByDomain.has(d)) brandByDomain.set(d, b);

  const run = await db.commerceRun.create({ data: { purpose: COUPON_PURPOSE, sourceId: source.id, actorId: ACTOR, trigger, status: "RUNNING", startUrls: 0 } });
  const out: FeedicoSyncResult = { ...base };
  const failures: Array<{ brand: string; error: string }> = [];
  const basis = state.catalogAt ?? "never";

  /**
   * One guarded request per catalogue page (lib/ops/api-guard.ts): parameters, database, monthly budget
   * and an idempotency marker per (page, previous read) are checked first; the attempt is counted before
   * it is made; no retry. A duplicate trigger finds the marker and makes no request.
   */
  const request = async (page: number) => {
    const guarded = await guardedApiCall({
      api: "feedico",
      unit: `catalog:page${page}`,
      idempotencyBasis: basis,
      markerTtlMs: 7 * 86_400_000,
      trigger,
      config: [() => (feedicoConfigured() ? null : { code: "FEEDICO_NOT_CONFIGURED", reason: "FEEDICO_API_KEY not configured" })],
      params: () => (page >= 1 && page <= config.feedico.maxCatalogPages() ? null : { code: "INVALID_PARAMS", reason: `page ${page} outside 1–${config.feedico.maxCatalogPages()}` }),
      budget: [() => (state.requests >= budget ? { code: "QUOTA_EXCEEDED", reason: `request budget ${budget} for ${state.month} reached` } : null)],
      call: async () => {
        state.requests++;
        out.requests++;
        await writeState(state);
        return fetchFeedicoCoupons({ page, pageSize: PAGE_SIZE });
      },
    });
    if (guarded.status === "SKIPPED") return { ok: false as const, error: { kind: guarded.code === "QUOTA_EXCEEDED" ? ("QUOTA_EXCEEDED" as const) : ("SKIPPED" as const), status: 0, message: `${guarded.code}: ${guarded.reason}` }, local: true };
    if (guarded.status === "INVALID_RESPONSE") return { ok: false as const, error: { kind: "RESPONSE_INVALID" as const, status: 200, message: guarded.reason }, local: false };
    return { ...guarded.value, local: false };
  };

  // ── Read the catalogue ──
  const pages: Array<{ page: number; rows: FeedicoCouponRow[]; rawId: string }> = [];
  let recordCount = 0;
  let complete = false;
  let error: FeedicoFetchError | null = null;
  for (let page = 1; page <= config.feedico.maxCatalogPages(); page++) {
    if (Date.now() > deadline) break;
    const res = await request(page);
    if (!res.ok) {
      error = res.error;
      if (res.error.kind === "QUOTA_EXCEEDED" && !res.local) state.quotaExceeded = true;
      break;
    }
    recordCount = res.page.recordCount;
    const url = `${config.feedico.baseUrl()}/api/v1/catalog/coupons?page=${page}`;
    const payload = { provider: "feedico", endpoint: "POST /api/v1/catalog/coupons", page, pageSize: PAGE_SIZE, recordCount, fetchedAt: now.toISOString(), rows: res.page.coupons };
    const raw = await db.commerceRawRecord.upsert({
      where: { runId_url: { runId: run.id, url } },
      create: { runId: run.id, url, purpose: COUPON_PURPOSE, payload: payload as Prisma.InputJsonValue, contentHash: sha256(JSON.stringify(res.page.coupons)), fetchedAt: now },
      update: {},
    });
    pages.push({ page, rows: res.page.coupons, rawId: raw.id });
    if (page * PAGE_SIZE >= recordCount || res.page.coupons.length < PAGE_SIZE) {
      complete = true;
      break;
    }
  }
  if (error) failures.push({ brand: "catalogue", error: `${error.kind}: ${error.message}` });

  // ── Store every merchant's codes (only what was read; nothing invented) ──
  const groups = new Map<string, { brand: FeedicoBrand; rows: FeedicoCouponRow[] }>();
  // Each code is stored with the raw page it was read from (the 14-day sweep reads its confirmation date there).
  const pageOf = new Map<string, { rawId: string; seen: number }>();
  let fetchedRows = 0;
  for (const p of pages) {
    for (const r of p.rows) {
      fetchedRows++;
      const domain = domainOf(r.merchantWebsiteUrl);
      if (!domain) {
        out.dropped++;
        continue;
      }
      const reg = brandByDomain.get(domain);
      const brand: FeedicoBrand = reg ? { id: reg.id, slug: reg.slug, name: reg.name, officialDomain: reg.officialDomain, officialStoreUrl: reg.officialStoreUrl } : { id: null, slug: merchantSlug(domain), name: merchantName(r.brandName), officialDomain: domain };
      const g = groups.get(domain) ?? { brand, rows: [] };
      g.rows.push(r);
      groups.set(domain, g);
      const key = `${domain}|${r.code.trim().toUpperCase()}`;
      const seen = feedicoDate(r.fetchedAt)?.getTime() ?? 0;
      const prev = pageOf.get(key);
      if (!prev || seen > prev.seen) pageOf.set(key, { rawId: p.rawId, seen });
    }
  }
  const listed = new Set<string>();
  for (const [domain, { brand, rows }] of groups) {
    const n = normalizeFeedicoRows(rows, brand, now);
    out.dropped += n.dropped.length;
    if (!n.coupons.length) continue;
    const sourceUrl = feedicoSourceUrl(brand);
    // One upsert per raw page, so every code points at the page that listed it.
    const byRaw = new Map<string, NormalizedCoupon[]>();
    for (const c of n.coupons) {
      const rawId = pageOf.get(`${domain}|${c.code}`)?.rawId ?? pages[0]?.rawId ?? "";
      byRaw.set(rawId, [...(byRaw.get(rawId) ?? []), c]);
    }
    for (const [rawId, coupons] of byRaw) {
      const up = await upsertCoupons({ brandId: brand.id, coupons, observedAt: now, rawIds: rawId ? { [sourceUrl]: rawId } : {}, now });
      out.created += up.created;
      out.changed += up.changed;
    }
    out.brandsChecked++;
    out.coupons += n.coupons.length;
    for (const c of n.coupons) listed.add(`${c.merchant}\u0000${c.code}\u0000${c.sourceUrl}`);
  }

  // ── A complete read: codes Feedico no longer lists are deactivated (never deleted) ──
  if (complete && !error) {
    const stale = await db.commerceCoupon.findMany({ where: { sourceUrl: { startsWith: `${config.feedico.baseUrl()}/api/v1/catalog/coupons?` }, status: { notIn: ["INVALID", "EXPIRED"] } }, select: { id: true, merchant: true, code: true, sourceUrl: true, status: true } });
    for (const c of stale) {
      if (listed.has(`${c.merchant}\u0000${c.code}\u0000${c.sourceUrl}`)) continue;
      const evidence = `No longer listed in the Feedico catalogue (complete read of ${recordCount} codes at ${now.toISOString()})`;
      await db.commerceCoupon.update({ where: { id: c.id }, data: { status: "INVALID", verificationEvidence: evidence } });
      await commerceAudit("COUPON_INVALIDATED", "commerce_coupon", c.id, { before: { status: c.status }, after: { status: "INVALID" }, metadata: { code: c.code, evidence } });
      out.invalidated++;
    }
  }
  out.changed += out.invalidated;
  out.expired = await markExpiredCoupons(now);
  out.fetchedRows = fetchedRows;
  out.merchants = groups.size;
  out.recordCount = recordCount;
  out.pages = pages.length;
  out.complete = complete;
  out.requestsThisMonth = state.requests;
  if (failures.length) out.failures = failures;
  if (error) {
    out.brandsFailed = 1;
    out.status = error.kind === "AUTH_FAILED" ? "AUTH_FAILED" : error.kind === "QUOTA_EXCEEDED" ? "BUDGET_EXHAUSTED" : error.kind === "SKIPPED" ? "SKIPPED" : "FAILED";
    out.reason = error.message;
  }
  if (!error) {
    state.catalogAt = now.toISOString();
    state.catalogComplete = complete;
    state.recordCount = recordCount;
  }
  await writeState(state);

  const failed = out.status !== "OK";
  await db.commerceRun.update({
    where: { id: run.id },
    data: { status: failed ? "FAILED" : "COLLECTED", finishedAt: new Date(), collectedAt: failed ? null : new Date(), startUrls: out.brandsChecked, pagesProcessed: out.requests, extracted: fetchedRows, accepted: out.coupons, rejected: out.dropped, errors: failures.length ? (failures as Prisma.InputJsonValue) : undefined },
  });
  await db.commerceSource.update({
    where: { id: source.id },
    data: failed
      ? { crawlStatus: out.status, consecutiveFailures: { increment: 1 }, lastError: (out.reason ?? "").slice(0, 300), lastCrawlAt: now }
      : { crawlStatus: "OK", consecutiveFailures: 0, lastError: complete ? null : `catalogue read stopped at page ${pages.length} of ${Math.ceil(recordCount / PAGE_SIZE)} (FEEDICO_MAX_CATALOG_PAGES or time limit)`, lastCrawlAt: now, nextCrawlAt: new Date(now.getTime() + 7 * 86_400_000) },
  });
  await commerceAudit(failed ? "COUPON_FEED_FAILED" : "COUPON_FEED_SYNCED", "commerce_run", run.id, { metadata: { purpose: COUPON_PURPOSE, provider: "feedico", status: out.status, reason: out.reason, recordCount, pages: pages.length, complete, fetchedRows, merchants: groups.size, stored: out.coupons, created: out.created, rejected: out.dropped, invalidated: out.invalidated, requests: out.requests, requestsThisMonth: state.requests } });
  log.info("feedico coupon sync", { stage: "COMMERCE", status: out.status, recordCount, pages: pages.length, complete, fetched: fetchedRows, merchants: groups.size, stored: out.coupons, created: out.created, rejected: out.dropped, invalidated: out.invalidated, requests: out.requests, month: state.month, used: state.requests, budget });
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
