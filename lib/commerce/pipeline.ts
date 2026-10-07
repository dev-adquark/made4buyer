import type { CommerceBrand, CommerceRawRecord, CommerceRun, Prisma } from "@prisma/client";
import { getSwitches } from "@/lib/automation/settings";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { PipelineError } from "@/lib/errors";
import { log } from "@/lib/log";
import { safeFetch } from "@/lib/net/safe-fetch";
import { apifyConfigured, globToRegex, normalizeUrl } from "@/lib/pipeline/apify";
import { factsFromPage, summarize, toFact, type FactSummary } from "@/lib/products/enrich";
import { isVariantToken, maxAgeMs } from "@/lib/products/facts";
import { brandKey, classifySource, sameProduct } from "@/lib/products/page-extract";
import type { Fact, FactSource, MatchResult, ProductIdentity } from "@/lib/products/types";
import { sha256 } from "@/lib/util/text";
import { commerceAudit, commerceAuditOnce } from "./audit";
import { dueBrands, ensureBrandsSeeded } from "./brands";
import { classifyOfferStatusesSafe } from "./classify";
import { buildDealActorInput, crawlableStartUrls, dealPagesPerRun, fetchBrandRobots, followedPageAllowed, type BrandRobots, type RobotsRule } from "./deal-crawl";
import { discoverProductUrls, type DiscoveryOptions, type DiscoveryResult } from "./discovery";
import { recheckCandidates, type RecheckResult } from "./recheck";
import { normalizeCommerceRecord, type NormalizedCommerceRecord } from "./normalize";
import { loadSummaryFacts } from "@/lib/products/current-facts";
import { verifyOfficial } from "./official";
import { PRODUCT_PAGE_FUNCTION } from "./page-functions/product";
import { revalidateCommerce } from "./revalidate";
import { syncSeedFields } from "./seed-sync";
import { normalizeDestinationUrl, onDomain } from "./urls";
import { recordIdentityDecision, recordPriceChange, recordPriceRejected } from "./verification-events";

/**
 * Commerce intelligence engine, product extraction (apify/web-scraper).
 *
 *   commerce-discover → for due brands: offer pages due for a price re-check (lib/commerce/recheck.ts),
 *                       then the brand's official deal pages (dealUrls, followed one level deep to
 *                       product pages only — lib/commerce/deal-crawl.ts) and explicit productUrls,
 *                       then discovered product URLs → startProductRun (one run per brand; without
 *                       deal pages depth 0: only those URLs; robots.txt respected, budget- and switch-gated)
 *   commerce-collect  → poll RUNNING runs; for SUCCEEDED ones store every dataset item unchanged
 *                       (CommerceRawRecord), normalize, upsert CommerceProduct, match EXACTLY against
 *                       ProductEntity, and only then write ProductFacts + CommerceOffers with provenance.
 *                       Then mark offers older than PRODUCT_PRICE_MAX_AGE_HOURS as STALE.
 * Nothing is ever deleted; a field a page no longer states keeps its previous value (logged). Which
 * value readers see is decided by the existing fact resolver (lib/products/facts.ts).
 */

export const DEFAULT_COMMERCE_ACTOR_ID = "moJRLRc85AitArpNN";
export const commerceActorId = () => (process.env.COMMERCE_APIFY_ACTOR_ID ?? "").trim() || DEFAULT_COMMERCE_ACTOR_ID;

function envNum(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw == null || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Monthly Apify budget for the commerce engine (COMMERCE_MONTHLY_BUDGET_USD, default $30). The one source of truth. */
export const DEFAULT_COMMERCE_BUDGET_USD = 30;
export const monthlyBudgetUsd = () => envNum("COMMERCE_MONTHLY_BUDGET_USD", DEFAULT_COMMERCE_BUDGET_USD, 0, 10_000);
export const brandsPerRun = () => Math.floor(envNum("COMMERCE_BRANDS_PER_RUN", 6, 1, 200));

const ACTIVE = ["READY", "RUNNING"];
const FAILED = ["FAILED", "ABORTED", "TIMED-OUT", "TIMING-OUT", "ABORTING"];
const MAX_BACKOFF_HOURS = 7 * 24;

/** Exponential crawl backoff after consecutive failures: 2 h, 4 h, 8 h … capped at 7 days. */
export function backoffHours(consecutiveFailures: number): number {
  return Math.min(MAX_BACKOFF_HOURS, 2 ** Math.max(1, Math.min(consecutiveFailures, 10)));
}

// ── Apify API (token stays server-side; never logged) ────────────────────────

type ApifyRunData = { id: string; status: string; defaultDatasetId?: string; finishedAt?: string | null; statusMessage?: string | null; usageTotalUsd?: number | null; stats?: { computeUnits?: number | null } | null };

/** Compute units Apify reports for a run (stats.computeUnits), when it reports a finite number. */
const computeUnitsOf = (data: ApifyRunData): number | undefined => {
  const v = data.stats?.computeUnits;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
};

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
    maxBytes: 30_000_000,
    standardPortsOnly: !config.allowLoopbackForTests(),
  });
  if (res.status === 401 || res.status === 403) {
    let type: string | undefined;
    try {
      type = (JSON.parse(res.body ?? "") as { error?: { type?: string } }).error?.type;
    } catch {
      /* non-JSON error */
    }
    if (type === "full-permission-actor-not-approved") throw new PipelineError("APIFY_ACTOR_NOT_APPROVED", undefined, { status: res.status }, false);
    throw new PipelineError("APIFY_AUTH_FAILED", `Apify rejected the request (HTTP ${res.status}${type ? `, ${type}` : ""})`, { status: res.status }, false);
  }
  if (!res.ok) throw new PipelineError("APIFY_RUN_FAILED", `Apify request failed: ${res.error ? res.error.kind : `HTTP ${res.status}`}`, { status: res.status }, true);
  try {
    return JSON.parse(res.body ?? "") as T;
  } catch {
    throw new PipelineError("APIFY_RESPONSE_INVALID", "Apify returned invalid JSON");
  }
}

const actorPath = () => `/acts/${encodeURIComponent(commerceActorId().replace("/", "~"))}`;

// ── Budget ───────────────────────────────────────────────────────────────────

/** Apify spend recorded this calendar month (UTC) across all commerce runs. */
export async function commerceBudget(now = new Date()) {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const agg = await db.commerceRun.aggregate({ where: { startedAt: { gte: monthStart } }, _sum: { usageUsd: true } });
  const spentUsd = agg._sum.usageUsd ?? 0;
  const budgetUsd = monthlyBudgetUsd();
  return { spentUsd, budgetUsd, remainingUsd: Math.max(0, budgetUsd - spentUsd), exhausted: spentUsd >= budgetUsd };
}

// ── Start ────────────────────────────────────────────────────────────────────

export type StartResult = { status: "STARTED" | "SKIPPED" | "FAILED"; code?: "APIFY_NOT_CONFIGURED" | "SWITCH_OFF" | "BUDGET_EXHAUSTED" | "NO_URLS" | "ACTIVE_RUN" | string; runId?: string; apifyRunId?: string; reason?: string };

function cleanUrls(brand: CommerceBrand, urls: string[]): string[] {
  const out: string[] = [];
  for (const u of urls) {
    const n = normalizeUrl(u);
    if (n && !out.includes(n)) out.push(n);
  }
  return out.slice(0, Math.max(1, brand.maxProductsPerRun));
}

const exactUrlRegex = (u: string) => `^${u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?(?:[?#].*)?$`;

/** Actor input: only the discovered product URLs (depth 0), robots.txt respected, Apify's default proxy pool. */
export function buildProductActorInput(brand: Pick<CommerceBrand, "slug" | "productUrlPatterns">, urls: string[], opts: { robotsRules?: RobotsRule[] | null } = {}) {
  const productPatterns = brand.productUrlPatterns.length ? brand.productUrlPatterns.map(globToRegex) : urls.map(exactUrlRegex);
  return {
    startUrls: urls.map((url) => ({ url })),
    maxCrawlingDepth: 0,
    maxPagesPerCrawl: urls.length,
    maxConcurrency: 2,
    respectRobotsTxtFile: true,
    injectJQuery: false,
    proxyConfiguration: { useApifyProxy: true },
    pageFunction: PRODUCT_PAGE_FUNCTION,
    // robotsRules: the official host's robots.txt rules (null = not read: the page fetches nothing extra).
    customData: { brand: brand.slug, productPatterns, robotsRules: opts.robotsRules ?? null },
  };
}

export type StartRunOptions = {
  /** Official deal/sale listing pages (LISTING): the run then follows their product links one level deep. */
  listingUrls?: string[];
  /** robots.txt of the official host, read at run start (rules go to the page function). */
  robots?: BrandRobots | null;
  /** How many of the leading product URLs are price re-checks (they stay ahead of the deal pages). */
  recheckUrls?: number;
};

async function recordSkip(brand: CommerceBrand, trigger: string, startUrls: number, code: string, reason: string, status = "SKIPPED") {
  const run = await db.commerceRun.create({ data: { purpose: "PRODUCT", brandId: brand.id, actorId: commerceActorId(), trigger, status, startUrls, errors: [{ code, reason }], finishedAt: new Date() } });
  return run.id;
}

/** Starts one product run for a brand, or records why it was skipped. Never throws. */
export async function startProductRun(brand: CommerceBrand, urls: string[], trigger: string, note?: string, opts: StartRunOptions = {}): Promise<StartResult> {
  const list = cleanUrls(brand, urls);
  const listing = [...new Set((opts.listingUrls ?? []).map((u) => normalizeUrl(u)).filter((u): u is string => !!u))].slice(0, 20);
  const total = list.length + listing.filter((u) => !list.includes(u)).length;
  const skip = async (code: string, reason: string): Promise<StartResult> => ({ status: "SKIPPED", code, reason, runId: await recordSkip(brand, trigger, total, code, reason) });
  if (!apifyConfigured()) return skip("APIFY_NOT_CONFIGURED", "APIFY_API_TOKEN not configured (BLOCKED_BY_ENVIRONMENT)");
  if (!(await getSwitches()).commerce_engine) return skip("SWITCH_OFF", "paused in Admin → Automation: Commerce engine is off");
  const budget = await commerceBudget();
  if (budget.exhausted) return skip("BUDGET_EXHAUSTED", `monthly Apify budget exhausted ($${budget.spentUsd.toFixed(2)} of $${budget.budgetUsd.toFixed(2)})`);
  if (!list.length && !listing.length) return skip("NO_URLS", note ? `no product URLs: ${note}` : "no product URLs discovered");
  const active = await db.commerceRun.findFirst({ where: { brandId: brand.id, purpose: "PRODUCT", status: { in: [...ACTIVE, "SUCCEEDED", "COLLECTING"] } } });
  if (active) return { status: "SKIPPED", code: "ACTIVE_RUN", reason: `run ${active.apifyRunId ?? active.id} is still ${active.status}` };
  try {
    const q = new URLSearchParams({ timeout: String(config.apify.runTimeoutSecs()), memory: String(config.apify.memoryMb()) });
    const robotsRules = opts.robots?.rules ?? null;
    // One run per brand: with deal pages, the listing pages lead (after re-checks, which are in `list`).
    const body = listing.length ? buildDealActorInput(brand, listing, list, { robotsRules, leadingProductUrls: opts.recheckUrls }) : buildProductActorInput(brand, list, { robotsRules });
    const { data } = await apify<{ data?: ApifyRunData }>(`${actorPath()}/runs?${q}`, { method: "POST", body });
    if (!data?.id) throw new PipelineError("APIFY_RESPONSE_INVALID", "Apify did not return a run id");
    const run = await db.commerceRun.create({ data: { purpose: "PRODUCT", brandId: brand.id, actorId: commerceActorId(), apifyRunId: data.id, datasetId: data.defaultDatasetId ?? null, trigger, status: "RUNNING", startUrls: total } });
    await db.commerceBrand.update({ where: { id: brand.id }, data: { crawlStatus: "RUNNING" } });
    log.info("commerce run started", { stage: "CONTENT_FETCH", brand: brand.slug, runId: data.id, urls: list.length, dealPages: listing.length });
    return { status: "STARTED", runId: run.id, apifyRunId: data.id };
  } catch (error) {
    const e = error instanceof PipelineError ? error : new PipelineError("APIFY_RUN_FAILED", String(error));
    const runId = await recordSkip(brand, trigger, list.length, e.code, e.message, "FAILED");
    await brandFailed(brand.id, e.code, e.message);
    await commerceAudit("APIFY_RUN_FAILED", "commerce_run", runId, { metadata: { purpose: "PRODUCT", brand: brand.slug, stage: "start", code: e.code, reason: e.message } });
    return { status: "FAILED", code: e.code, reason: e.message, runId };
  }
}

// ── Brand health ─────────────────────────────────────────────────────────────

async function brandSucceeded(brandId: string, status: string, now = new Date()) {
  const b = await db.commerceBrand.findUnique({ where: { id: brandId } });
  if (!b) return;
  await db.commerceBrand.update({ where: { id: brandId }, data: { lastCrawlAt: now, crawlStatus: status, consecutiveFailures: 0, lastError: null, nextCrawlAt: new Date(now.getTime() + b.crawlFrequencyHours * 3_600_000) } });
}

async function brandFailed(brandId: string, status: string, reason: string, now = new Date()) {
  const b = await db.commerceBrand.findUnique({ where: { id: brandId } });
  if (!b) return;
  const failures = b.consecutiveFailures + 1;
  await db.commerceBrand.update({ where: { id: brandId }, data: { lastCrawlAt: now, crawlStatus: status, consecutiveFailures: failures, lastError: reason.slice(0, 500), nextCrawlAt: new Date(now.getTime() + backoffHours(failures) * 3_600_000) } });
}

// ── Identity ─────────────────────────────────────────────────────────────────

type Candidate = { id: string; name: string; brand: string | null; categorySlug: string | null; identity: ProductIdentity };
type Decision = {
  status: "MATCHED" | "MATCH_REJECTED" | "UNMATCHED";
  entityId: string | null;
  basis: string | null;
  reason: string;
  match?: MatchResult;
  candidate?: Candidate;
  /** On a rejection: the one Made4Buyers product this page is a different variant of (logged, never attached). */
  nearEntityId?: string | null;
};

const nameTokens = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[™®©℠]/g, "").split(/[^a-z0-9+]+/).filter(Boolean);

/** Same product line, different variant: every non-variant word of the candidate's name (beyond the brand) is on the page. */
export function isNearMiss(candidate: Pick<Candidate, "name" | "brand">, pageName: string | null | undefined): boolean {
  const brand = new Set(nameTokens(candidate.brand));
  const core = nameTokens(candidate.name).filter((t) => !brand.has(t) && !isVariantToken(t));
  const page = new Set(nameTokens(pageName));
  return core.length > 0 && core.every((t) => page.has(t));
}

const ID_FIELDS = ["gtin", "mpn", "model", "sku"] as const;
const AUTHORITY: Record<string, number> = { MANUFACTURER: 0, STRUCTURED_FEED: 1, RETAILER: 2, WIKIDATA: 3, REVIEW_SOURCE: 4, SOVRN: 5, SECONDARY: 6 };

/** Made4Buyers products of one brand, with the identifiers their stored facts state (strongest source first). */
async function candidatesFor(keys: string[], cache: Map<string, Candidate[]>): Promise<Candidate[]> {
  const cacheKey = keys.sort().join("|");
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  const rows = await db.productEntity.findMany({
    where: { brand: { not: null } },
    select: { id: true, name: true, brand: true, categorySlug: true, facts: { where: { field: { in: [...ID_FIELDS] } }, select: { field: true, value: true, source: true } } },
  });
  const out = rows
    .filter((r) => keys.includes(brandKey(r.brand)))
    .map((r) => {
      const facts = [...r.facts].sort((a, b) => (AUTHORITY[a.source] ?? 9) - (AUTHORITY[b.source] ?? 9));
      const id = (f: string) => {
        const x = facts.find((y) => y.field === f && typeof y.value === "string");
        return x ? (x.value as string) : null;
      };
      return { id: r.id, name: r.name, brand: r.brand, categorySlug: r.categorySlug, identity: { name: r.name, brand: r.brand, gtin: id("gtin"), mpn: id("mpn"), model: id("model"), sku: id("sku") } };
    });
  cache.set(cacheKey, out);
  return out;
}

/** Exact identity only: exactly one Made4Buyers product must be the same product; anything else is not attached. */
export function decideIdentity(product: NormalizedCommerceRecord & { ok: true }, candidates: Candidate[]): Decision {
  if (!candidates.length) return { status: "UNMATCHED", entityId: null, basis: null, reason: "no Made4Buyers product of this brand" };
  const results = candidates.map((c) => ({ c, m: sameProduct(c.identity, product.product) }));
  const matches = results.filter((r) => r.m.match);
  if (matches.length === 1) return { status: "MATCHED", entityId: matches[0].c.id, basis: matches[0].m.basis, reason: matches[0].m.reason, match: matches[0].m, candidate: matches[0].c };
  if (matches.length > 1) return { status: "MATCH_REJECTED", entityId: null, basis: null, reason: `ambiguous: ${matches.length} Made4Buyers products match (${matches.map((r) => r.c.name).slice(0, 5).join(", ")})` };
  const reasons = results.slice(0, 5).map((r) => `${r.c.name}: ${r.m.reason}`);
  const near = candidates.filter((c) => isNearMiss(c, product.product.name));
  return { status: "MATCH_REJECTED", entityId: null, basis: null, reason: `no exact match among ${candidates.length} product(s) of this brand — ${reasons.join("; ")}`.slice(0, 2000), nearEntityId: near.length === 1 ? near[0].id : null };
}

const confidenceOf = (basis: string) => (basis === "gtin" || basis === "mpn" || basis === "model" ? 1 : 0.9);

// ── Writes ───────────────────────────────────────────────────────────────────

const hostOf = (url: string) => new URL(url).hostname.toLowerCase().replace(/^www\./, "");

type StoredData = { product?: Record<string, unknown>; specs?: unknown[]; images?: unknown[]; [k: string]: unknown };

/** Upserts the normalized product by canonical URL. A field the page no longer states keeps its previous value. */
async function upsertProduct(brand: CommerceBrand, n: NormalizedCommerceRecord & { ok: true }, raw: CommerceRawRecord, now: Date) {
  const existing = await db.commerceProduct.findUnique({ where: { canonicalUrl: n.canonicalUrl } });
  const prev = (existing?.data ?? {}) as StoredData;
  const prevProduct = prev.product ?? {};
  const current = n.product as unknown as Record<string, unknown>;
  const preserved = Object.keys(prevProduct).filter((k) => k !== "url" && k !== "extractedFrom" && current[k] == null && prevProduct[k] != null);
  const keepSpecs = !n.specs.length && Array.isArray(prev.specs) && prev.specs.length > 0;
  const keepImages = !n.images.length && Array.isArray(prev.images) && prev.images.length > 0;
  if (preserved.length || keepSpecs || keepImages) {
    log.warn("commerce product field no longer stated; previous value kept", { stage: "CONTENT_FETCH", brand: brand.slug, url: n.canonicalUrl, fields: [...preserved, ...(keepSpecs ? ["specs"] : []), ...(keepImages ? ["images"] : [])].join(",") });
  }
  const merged = { ...Object.fromEntries(preserved.map((k) => [k, prevProduct[k]])), ...current };
  const data = {
    product: merged,
    specs: keepSpecs ? prev.specs : n.specs,
    images: keepImages ? prev.images : n.images,
    offers: n.offers,
    breadcrumbs: n.breadcrumbs,
    lang: n.lang ?? (prev.lang as string | undefined) ?? null,
    pageUrl: n.pageUrl,
    extractionMethod: n.extractionMethod,
    preservedFields: preserved,
  } as unknown as Prisma.InputJsonValue;
  const p = n.product;
  const cols = {
    brandId: brand.id,
    name: p.name!,
    model: p.model ?? existing?.model ?? null,
    mpn: p.mpn ?? existing?.mpn ?? null,
    sku: p.sku ?? existing?.sku ?? null,
    gtin: p.gtin ?? existing?.gtin ?? null,
    category: p.category ?? existing?.category ?? null,
    data,
    lastRawId: raw.id,
    observedAt: now,
  };
  const product = existing ? await db.commerceProduct.update({ where: { id: existing.id }, data: cols }) : await db.commerceProduct.create({ data: { canonicalUrl: n.canonicalUrl, ...cols } });
  if (!existing) await commerceAudit("PRODUCT_CREATED", "commerce_product", product.id, { metadata: { url: n.canonicalUrl, brand: brand.slug, name: product.name } });
  return { product, previous: existing ? { identityStatus: existing.identityStatus, productEntityId: existing.productEntityId } : null };
}

/** Same upsert as lib/products/enrich.ts saveFacts, plus discovery/verification provenance. */
async function saveCommerceFacts(entityId: string, facts: Fact[], meta: { confidence: number; extractionMethod: string; now: Date }) {
  for (const f of facts) {
    const sourceKey = (f.sourceUrl ?? f.sourceName).slice(0, 500);
    const data = { value: f.value as Prisma.InputJsonValue, unit: f.unit ?? null, sourceName: f.sourceName, sourceUrl: f.sourceUrl, observedAt: f.observedAt, matchBasis: f.matchBasis, verifiedAt: meta.now, confidence: meta.confidence, extractionMethod: meta.extractionMethod };
    const key = { productEntityId: entityId, field: f.field, source: f.source, sourceKey };
    await db.productFact.upsert({ where: { productEntityId_field_source_sourceKey: key }, create: { ...key, ...data, discoveredAt: meta.now }, update: data });
  }
  // Rows first written before discoveredAt existed: their first sighting is now.
  await db.productFact.updateMany({ where: { productEntityId: entityId, discoveredAt: null, sourceKey: { in: [...new Set(facts.map((f) => (f.sourceUrl ?? f.sourceName).slice(0, 500)))] } }, data: { discoveredAt: meta.now } });
}

/** Re-resolves the entity's snapshot so the resolver (not this pipeline) decides which value is shown. */
export async function refreshSummary(entityId: string, now: Date) {
  const e = await db.productEntity.findUnique({ where: { id: entityId }, select: { categorySlug: true, factSummary: true } });
  if (!e) return;
  const facts = (await loadSummaryFacts(entityId)).map(toFact);
  const prev = (e.factSummary ?? {}) as Partial<FactSummary>;
  const summary = { ...summarize(facts, e.categorySlug, now), attempts: prev.attempts, wikidataCheckedAt: prev.wikidataCheckedAt ?? null, version: prev.version };
  await db.productEntity.update({ where: { id: entityId }, data: { factSummary: summary as unknown as Prisma.InputJsonValue, enrichmentStatus: summary.status } });
  // A field that newly resolves to CONFLICTING (equal-authority sources disagree; not displayed): one event per change.
  const conflictingIn = (fields: FactSummary["fields"] | undefined) => Object.entries(fields ?? {}).filter(([, f]) => f?.status === "CONFLICTING").map(([k]) => k as keyof FactSummary["fields"]);
  const before = new Set(conflictingIn(prev.fields));
  const conflictingNow = conflictingIn(summary.fields);
  const fresh = conflictingNow.filter((f) => !before.has(f));
  if (fresh.length) {
    await commerceAudit("SOURCE_CONFLICT", "product_entity", entityId, {
      before: { conflicting: [...before] },
      after: { conflicting: conflictingNow },
      metadata: { fields: fresh, notes: fresh.map((f) => `${f}: ${summary.fields[f]?.note ?? ""}`.slice(0, 200)).slice(0, 5) },
    });
  }
}

async function writeOffers(productId: string, brand: CommerceBrand, n: NormalizedCommerceRecord & { ok: true }, source: FactSource, raw: CommerceRawRecord, now: Date, opts: { requirePrice?: boolean } = {}): Promise<number> {
  const seen = new Set<string>();
  let written = 0;
  for (const o of n.offers) {
    // A product we have not reviewed is listed only for its price: no stated price, no offer.
    if (opts.requirePrice && !(typeof o.price === "number" && o.price > 0)) continue;
    // Currency as an upper-case ISO code everywhere ("usd" → "USD"): /deals and the status function match it exactly.
    const currency = typeof o.currency === "string" && o.currency.trim() ? o.currency.trim().toUpperCase() : null;
    // A US-market brand shows its storefront currency (USD) only; an offer in another currency belongs to another storefront.
    const expected = (brand.currency || "USD").toUpperCase();
    const wrongCurrency = brand.market === "US" && currency && currency !== expected;
    const invalid = o.price != null && !(Number.isFinite(o.price) && o.price > 0);
    if (wrongCurrency || invalid) {
      const reason = wrongCurrency ? `currency ${currency} is not ${expected} for a US-market brand` : `invalid price ${o.price}`;
      await commerceAuditOnce("PRICE_REJECTED", "commerce_product", productId, `${o.url ?? n.canonicalUrl}|${o.price}|${o.currency ?? ""}`, { metadata: { url: o.url ?? n.canonicalUrl, price: o.price ?? null, currency: o.currency ?? null, reason } });
      await recordPriceRejected({ commerceProductId: productId, sourceUrl: o.url ?? n.canonicalUrl, price: o.price ?? null, listPrice: o.listPrice ?? null, currency: o.currency ?? null, reason, at: now });
      continue;
    }
    // Only an offer on this same site; an offer URL elsewhere is never used as a destination.
    // Normalized (no fragment, utm_*, gclid, fbclid …) so tracking variants never create a second row.
    const dest = normalizeDestinationUrl(o.url && onDomain(o.url, hostOf(n.pageUrl)) ? o.url : n.canonicalUrl);
    if (!dest || seen.has(dest)) continue;
    seen.add(dest);
    const fields = {
      seller: o.seller ?? (source === "MANUFACTURER" ? brand.name : hostOf(n.pageUrl)),
      sellerType: source === "MANUFACTURER" ? "MANUFACTURER" : "RETAILER",
      price: o.price ?? null,
      listPrice: o.listPrice ?? null,
      currency,
      availability: o.availability ?? null,
      observedAt: now,
      sourceRawId: raw.id,
      status: "FRESH",
    };
    const key = { productId_destinationUrl: { productId, destinationUrl: dest } };
    const before = await db.commerceOffer.findUnique({ where: key, select: { price: true, listPrice: true, currency: true } });
    const offer = await db.commerceOffer.upsert({
      where: key,
      // Affiliate fields are set only by a real affiliate provider; this pipeline never invents one.
      create: { productId, destinationUrl: dest, affiliateUrl: null, affiliateProvider: null, affiliateStatus: "NONE", ...fields },
      update: fields,
    });
    await recordPriceChange({ offerId: offer.id, before, after: { price: fields.price, listPrice: fields.listPrice, currency: fields.currency }, sourceUrl: dest, at: now });
    if ((before?.price ?? null) !== fields.price && (before || fields.price != null)) {
      await commerceAudit("PRICE_UPDATED", "commerce_offer", offer.id, { before: { price: before?.price ?? null, currency: before?.currency ?? null }, after: { price: fields.price, currency: fields.currency }, metadata: { url: dest, created: !before } });
    }
    written++;
  }
  return written;
}

type ItemOutcome = { url: string; result: "MATCHED" | "MATCH_REJECTED" | "UNMATCHED" | "NOT_EXTRACTED" | "ERROR"; reason?: string; entityIds?: string[] };

/** A product identified by its own official page: official domain, a name and at least one identifier. */
export function standaloneIdentity(n: NormalizedCommerceRecord & { ok: true }, brand: Pick<CommerceBrand, "officialDomain">): boolean {
  const p = n.product;
  return onDomain(n.pageUrl, brand.officialDomain) && !!p.name?.trim() && [p.sku, p.gtin, p.mpn, p.model].some((v) => typeof v === "string" && v.trim().length >= 2);
}

async function processRaw(brand: CommerceBrand, raw: CommerceRawRecord, now: Date, cache: Map<string, Candidate[]>): Promise<ItemOutcome> {
  const n = normalizeCommerceRecord(raw.payload, { market: brand.market });
  if (!n.ok) return { url: raw.url, result: "NOT_EXTRACTED", reason: `${n.code}: ${n.reason}` };
  // A page reached from a deal page (or a deal page that returned a product) must itself be a product
  // page of the brand's official US storefront: listing pages never create products.
  if (n.crawlLabel !== "PRODUCT") {
    const allowed = followedPageAllowed(n.pageUrl, brand);
    if (!allowed.ok) return { url: raw.url, result: "NOT_EXTRACTED", reason: `LINK_NOT_PRODUCT: ${allowed.reason}` };
  }
  if (!onDomain(n.pageUrl, brand.officialDomain) && classifySource(n.pageUrl, brand.name) === "SECONDARY") {
    return { url: raw.url, result: "NOT_EXTRACTED", reason: `SOURCE_NOT_ALLOWED: ${hostOf(n.pageUrl)} is neither ${brand.officialDomain} nor a known retailer` };
  }
  const source: FactSource = onDomain(n.pageUrl, brand.officialDomain) || classifySource(n.pageUrl, brand.name) === "MANUFACTURER" ? "MANUFACTURER" : "RETAILER";
  // The brand's own official site names its own products: a page there that omits "brand" in its
  // structured data is still that brand's product (provenance: the official domain).
  if (!n.product.brand && onDomain(n.pageUrl, brand.officialDomain)) n.product.brand = brand.name;
  const { product, previous } = await upsertProduct(brand, n, raw, now);
  const keys = [...new Set([brandKey(brand.name), brandKey(n.product.brand)].filter(Boolean))];
  const decision = decideIdentity(n, await candidatesFor(keys, cache));
  await db.commerceProduct.update({ where: { id: product.id }, data: { identityStatus: decision.status, identityReason: decision.reason.slice(0, 2000), productEntityId: decision.entityId } });
  await db.commerceMatchLog.create({ data: { commerceProductId: product.id, productEntityId: decision.entityId ?? decision.nearEntityId ?? null, result: decision.status, basis: decision.basis, reason: decision.reason.slice(0, 2000) } });
  await recordIdentityDecision({ commerceProductId: product.id, result: decision.status, basis: decision.basis, reason: decision.reason, productEntityId: decision.entityId, nearEntityId: decision.nearEntityId, sourceUrl: n.canonicalUrl, at: now });
  if (previous && (previous.identityStatus !== decision.status || previous.productEntityId !== decision.entityId)) {
    await commerceAudit("PRODUCT_UPDATED", "commerce_product", product.id, { before: previous, after: { identityStatus: decision.status, productEntityId: decision.entityId }, metadata: { url: n.canonicalUrl, reason: decision.reason } });
  }
  // Products whose official status may have changed with this decision.
  const entityIds = [decision.entityId, decision.nearEntityId, previous?.productEntityId].filter((x): x is string => !!x);
  if (decision.status !== "MATCHED" || !decision.entityId || !decision.basis) {
    // Not one of our reviewed products, but still a real product: on the brand's own official site
    // with a stated identity (name + SKU/GTIN/MPN/model), its price is the official price of that
    // exact product (the page IS the product). Store the offer so it can appear as a verified deal;
    // facts are never attached to a Made4Buyers product without an exact match.
    if (standaloneIdentity(n, brand)) await writeOffers(product.id, brand, n, source, raw, now, { requirePrice: true });
    return { url: n.canonicalUrl, result: decision.status, reason: decision.reason, entityIds };
  }

  const facts = factsFromPage(n.product, { source, sourceName: hostOf(n.pageUrl), sourceUrl: n.canonicalUrl, observedAt: now, matchBasis: decision.basis });
  await saveCommerceFacts(decision.entityId, facts, { confidence: confidenceOf(decision.basis), extractionMethod: n.extractionMethod, now });
  await writeOffers(product.id, brand, n, source, raw, now);
  await refreshSummary(decision.entityId, now);
  return { url: n.canonicalUrl, result: "MATCHED", reason: decision.reason, entityIds };
}

// ── Collect ──────────────────────────────────────────────────────────────────

export type CommerceCollectResult = { runId: string; apifyRunId: string | null; status: string; items?: number; extracted?: number; accepted?: number; rejected?: number; reason?: string; entityIds?: string[] };

const itemUrl = (item: unknown, i: number): string => {
  if (item && typeof item === "object") {
    const o = item as Record<string, unknown>;
    const debug = o["#debug"] as Record<string, unknown> | undefined;
    for (const v of [o.url, debug?.url, debug?.loadedUrl]) if (typeof v === "string" && v.trim()) return v.trim().slice(0, 2000);
  }
  return `item:${i}`;
};

async function storeRaws(run: CommerceRun, items: unknown[]): Promise<CommerceRawRecord[]> {
  const out: CommerceRawRecord[] = [];
  for (const [i, item] of items.entries()) {
    const url = itemUrl(item, i);
    const payload = (item ?? null) as Prisma.InputJsonValue;
    // Exactly what Apify returned; an existing record for this run+URL is never modified.
    const row = await db.commerceRawRecord.upsert({ where: { runId_url: { runId: run.id, url } }, create: { runId: run.id, url, purpose: run.purpose, payload, contentHash: sha256(JSON.stringify(item ?? null)) }, update: {} });
    out.push(row);
  }
  return out;
}

async function collectSucceeded(run: CommerceRun & { brand: CommerceBrand | null }, data: ApifyRunData, now: Date): Promise<CommerceCollectResult> {
  const claimed = await db.commerceRun.updateMany({ where: { id: run.id, status: { in: [...ACTIVE, "SUCCEEDED"] } }, data: { status: "COLLECTING", usageUsd: data.usageTotalUsd ?? run.usageUsd, computeUnits: computeUnitsOf(data) ?? run.computeUnits, datasetId: data.defaultDatasetId ?? run.datasetId, finishedAt: data.finishedAt ? new Date(data.finishedAt) : run.finishedAt ?? now } });
  if (!claimed.count) return { runId: run.id, apifyRunId: run.apifyRunId, status: "ALREADY_COLLECTED" };
  const brand = run.brand;
  try {
    if (!brand) throw new PipelineError("APIFY_RESPONSE_INVALID", "run has no brand", undefined, false);
    const datasetId = data.defaultDatasetId ?? run.datasetId;
    if (!datasetId) throw new PipelineError("APIFY_RESPONSE_INVALID", "Run has no dataset", undefined, false);
    // A run with deal pages also holds the pages it followed (at most COMMERCE_DEAL_PAGES_PER_RUN).
    const q = new URLSearchParams({ clean: "true", format: "json", limit: String(run.startUrls + dealPagesPerRun() + 5) });
    const items = await apify<unknown>(`/datasets/${encodeURIComponent(datasetId)}/items?${q}`);
    if (!Array.isArray(items)) throw new PipelineError("APIFY_RESPONSE_INVALID", "Dataset items response is not an array");
    const raws = await storeRaws(run, items);
    const cache = new Map<string, Candidate[]>();
    const outcomes: ItemOutcome[] = [];
    for (const raw of raws) {
      try {
        outcomes.push(await processRaw(brand, raw, now, cache));
      } catch (error) {
        outcomes.push({ url: raw.url, result: "ERROR", reason: String(error).slice(0, 300) });
        log.warn("commerce record processing failed", { stage: "CONTENT_FETCH", brand: brand.slug, url: raw.url, error: String(error).slice(0, 200) });
      }
    }
    const count = (r: ItemOutcome["result"]) => outcomes.filter((o) => o.result === r).length;
    const extracted = outcomes.length - count("NOT_EXTRACTED") - count("ERROR");
    const accepted = count("MATCHED");
    const rejected = count("MATCH_REJECTED") + count("UNMATCHED") + count("NOT_EXTRACTED");
    const errors = outcomes.filter((o) => o.result === "NOT_EXTRACTED" || o.result === "ERROR").slice(0, 50).map((o) => ({ url: o.url, code: o.result, reason: o.reason ?? null }));
    await db.commerceRun.update({ where: { id: run.id }, data: { status: "COLLECTED", pagesProcessed: raws.length, extracted, accepted, rejected, errors: errors as Prisma.InputJsonValue, collectedAt: now } });
    if (extracted > 0) await brandSucceeded(brand.id, "OK", now);
    else await brandFailed(brand.id, "EMPTY", `run ${run.apifyRunId} returned ${raws.length} item(s) and no readable product page`, now);
    log.info("commerce run collected", { stage: "CONTENT_FETCH", brand: brand.slug, runId: run.apifyRunId, items: raws.length, extracted, accepted });
    await commerceAudit("APIFY_RUN_COMPLETED", "commerce_run", run.id, { metadata: { purpose: "PRODUCT", brand: brand.slug, apifyRunId: run.apifyRunId, items: raws.length, extracted, accepted, rejected, usageUsd: data.usageTotalUsd ?? run.usageUsd ?? null } });
    const entityIds = [...new Set(outcomes.flatMap((o) => o.entityIds ?? []))];
    return { runId: run.id, apifyRunId: run.apifyRunId, status: "COLLECTED", items: raws.length, extracted, accepted, rejected, entityIds };
  } catch (error) {
    const e = error instanceof PipelineError ? error : new PipelineError("APIFY_RUN_FAILED", String(error));
    // Retryable: release the claim (raws and upserts are idempotent). Otherwise record and back off.
    await db.commerceRun.update({ where: { id: run.id }, data: { status: e.retryable ? "SUCCEEDED" : "COLLECT_FAILED", errors: [{ code: e.code, reason: e.message.slice(0, 500) }] } });
    if (!e.retryable && brand) await brandFailed(brand.id, "COLLECT_FAILED", e.message, now);
    if (!e.retryable) await commerceAudit("APIFY_RUN_FAILED", "commerce_run", run.id, { metadata: { purpose: "PRODUCT", brand: brand?.slug ?? null, apifyRunId: run.apifyRunId, stage: "collect", code: e.code, reason: e.message } });
    return { runId: run.id, apifyRunId: run.apifyRunId, status: e.code, reason: e.message };
  }
}

/** Polls running product runs and collects finished ones. Failed runs keep every existing record and back the brand off. */
export async function collectCommerceRuns(trigger: string, now = new Date()) {
  if (!apifyConfigured()) return { status: "BLOCKED_BY_ENVIRONMENT", reason: "APIFY_API_TOKEN not configured", checked: 0, collected: 0, results: [] as CommerceCollectResult[] };
  const runs = await db.commerceRun.findMany({ where: { purpose: "PRODUCT", apifyRunId: { not: null }, status: { in: [...ACTIVE, "SUCCEEDED"] } }, orderBy: { startedAt: "asc" }, take: 20, include: { brand: true } });
  const results: CommerceCollectResult[] = [];
  for (const run of runs) {
    try {
      const { data } = await apify<{ data?: ApifyRunData }>(`/actor-runs/${encodeURIComponent(run.apifyRunId!)}`);
      if (!data?.status) throw new PipelineError("APIFY_RESPONSE_INVALID", "Apify run status missing");
      if (data.status === "SUCCEEDED") results.push(await collectSucceeded(run, data, now));
      else if (FAILED.includes(data.status)) {
        const reason = (data.statusMessage ?? data.status).slice(0, 500);
        await db.commerceRun.update({ where: { id: run.id }, data: { status: data.status, usageUsd: data.usageTotalUsd ?? run.usageUsd, computeUnits: computeUnitsOf(data) ?? run.computeUnits, finishedAt: data.finishedAt ? new Date(data.finishedAt) : now, errors: [{ code: "APIFY_RUN_FAILED", reason }] } });
        if (run.brandId) await brandFailed(run.brandId, data.status, `run ${run.apifyRunId} ended ${data.status}: ${reason}`, now);
        await commerceAudit("APIFY_RUN_FAILED", "commerce_run", run.id, { metadata: { purpose: "PRODUCT", brand: run.brand?.slug ?? null, apifyRunId: run.apifyRunId, status: data.status, reason } });
        results.push({ runId: run.id, apifyRunId: run.apifyRunId, status: data.status, reason });
      } else {
        if (data.usageTotalUsd != null || computeUnitsOf(data) != null) await db.commerceRun.update({ where: { id: run.id }, data: { usageUsd: data.usageTotalUsd ?? run.usageUsd, computeUnits: computeUnitsOf(data) ?? run.computeUnits } });
        results.push({ runId: run.id, apifyRunId: run.apifyRunId, status: data.status });
      }
    } catch (error) {
      const e = error instanceof PipelineError ? error : new PipelineError("APIFY_RUN_FAILED", String(error));
      results.push({ runId: run.id, apifyRunId: run.apifyRunId, status: e.code, reason: e.message });
    }
  }
  // Official-source status of the products this collect touched (cheap: only those), then purge public pages.
  const touched = [...new Set(results.flatMap((r) => r.entityIds ?? []))];
  let official: Awaited<ReturnType<typeof verifyOfficial>> | undefined;
  if (touched.length) {
    try {
      official = await verifyOfficial(touched, now);
    } catch (error) {
      log.warn("inline official verification failed", { stage: "COMMERCE", error: String(error).slice(0, 200) });
    }
  }
  const dealStatus = await classifyOfferStatusesSafe({ now });
  const collected = results.filter((r) => r.status === "COLLECTED").length;
  if (collected) await revalidateCommerce(touched);
  return { status: "OK", trigger, checked: runs.length, collected, results: results.map((r) => ({ ...r, entityIds: undefined })), official: official ?? null, dealStatus };
}

// ── Freshness ────────────────────────────────────────────────────────────────

/** Offers older than PRODUCT_PRICE_MAX_AGE_HOURS (default 48) become STALE. Never deleted. */
export async function markStaleOffers(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - maxAgeMs("HIGH"));
  const r = await db.commerceOffer.updateMany({ where: { status: "FRESH", observedAt: { lt: cutoff } }, data: { status: "STALE" } });
  return r.count;
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

const STOP_CODES = new Set(["APIFY_NOT_CONFIGURED", "SWITCH_OFF", "BUDGET_EXHAUSTED"]);

export const isStopCode = (code: string | undefined) => !!code && STOP_CODES.has(code);

export type BrandRunUrls = {
  /** PRODUCT start URLs: re-checks, explicit productUrls, then discovered URLs (≤ maxProductsPerRun). */
  urls: string[];
  /** LISTING start URLs: the brand's official deal pages (crawlable ones). */
  listingUrls: string[];
  recheck: number;
  recheckDue: number;
  /** Explicit productUrls included. */
  explicit: number;
  discovery: string;
  reason?: string;
  robots: BrandRobots | null;
  /** Deal/product URLs left out (off-domain, robots.txt), with the reason. */
  skipped: Array<{ url: string; reason: string }>;
};

/**
 * The URLs of one brand run: offer pages due for a price re-check first (lib/commerce/recheck.ts),
 * then the brand's official deal pages (LISTING) and explicit productUrls, then newly discovered
 * product URLs up to maxProductsPerRun. Discovery is skipped when re-checks and explicit product
 * pages already fill the run. robots.txt of the official host is read once (its rules go to the page
 * function). Never throws.
 */
export async function brandRunUrls(brand: CommerceBrand, now: Date, opts: { discovery?: DiscoveryOptions } = {}): Promise<BrandRunUrls> {
  const cap = Math.max(1, brand.maxProductsPerRun);
  let robots: BrandRobots | null = null;
  try {
    robots = await fetchBrandRobots(brand.officialDomain);
  } catch (error) {
    log.warn("commerce robots.txt read failed", { stage: "COMMERCE", brand: brand.slug, error: String(error).slice(0, 200) });
  }
  const deal = crawlableStartUrls(brand.dealUrls ?? [], brand, robots);
  const explicit = crawlableStartUrls(brand.productUrls ?? [], brand, robots);
  const skipped = [...deal.skipped, ...explicit.skipped].slice(0, 20);
  let recheck: RecheckResult = { urls: [], due: 0, skipped: [] };
  try {
    recheck = await recheckCandidates(brand, now, cap);
  } catch (error) {
    log.warn("commerce re-check selection failed", { stage: "COMMERCE", brand: brand.slug, error: String(error).slice(0, 200) });
  }
  const head = [...new Set([...recheck.urls, ...explicit.urls])];
  const base = { listingUrls: deal.urls, recheck: Math.min(cap, recheck.urls.length), recheckDue: recheck.due, robots, skipped };
  if (head.length >= cap) {
    const urls = head.slice(0, cap);
    return { ...base, urls, explicit: urls.filter((u) => explicit.urls.includes(u) && !recheck.urls.includes(u)).length, discovery: "NOT_NEEDED", reason: `${recheck.urls.length} offer page(s) due for a price re-check${explicit.urls.length ? ` and ${explicit.urls.length} explicit product page(s)` : ""} fill the run` };
  }
  let d: DiscoveryResult;
  try {
    d = await discoverProductUrls(brand, opts.discovery);
  } catch (error) {
    d = { status: "ERROR", urls: [], reason: String(error).slice(0, 300) };
  }
  const urls = [...new Set([...head, ...(d.urls ?? [])])].slice(0, cap);
  return { ...base, urls, recheck: recheck.urls.length, explicit: urls.filter((u) => explicit.urls.includes(u) && !recheck.urls.includes(u)).length, discovery: d.status, reason: d.reason ?? (d.status !== "OK" ? d.status : undefined) };
}

export type BrandRunResult = StartResult & { brand: string; urls: number; recheck: number; dealPages: number; discovery: string };

/** Builds one brand's run (re-checks, deal pages + explicit product pages, then discovery) and starts it. Never throws. */
export async function startBrandRun(brand: CommerceBrand, trigger: string, now: Date, opts: { discovery?: DiscoveryOptions } = {}): Promise<BrandRunResult> {
  const b = await brandRunUrls(brand, now, opts);
  const r = await startProductRun(brand, b.urls, trigger, b.reason, { listingUrls: b.listingUrls, robots: b.robots, recheckUrls: b.recheck });
  if (r.code === "NO_URLS") await brandFailed(brand.id, `DISCOVERY_${b.discovery}`, r.reason ?? "no product URLs", now);
  return { ...r, brand: brand.slug, urls: b.urls.length + b.listingUrls.length, recheck: b.recheck, dealPages: b.listingUrls.length, discovery: b.discovery };
}

/** commerce-discover: offer pages due for a price re-check, then discovered product URLs, of due brands → one product run per brand. */
export async function runCommerceDiscover(trigger: string, now = new Date()) {
  if (!apifyConfigured()) return { status: "BLOCKED_BY_ENVIRONMENT", reason: "APIFY_API_TOKEN not configured", started: 0 };
  await ensureBrandsSeeded();
  // Seed fields added after the brands were imported (deal pages, product pages …): fills only empty ones; cheap when the seed is unchanged.
  try {
    await syncSeedFields();
  } catch (error) {
    log.warn("commerce seed sync failed", { stage: "COMMERCE", error: String(error).slice(0, 200) });
  }
  const limit = brandsPerRun();
  const brands = (await dueBrands(now, limit)).slice(0, limit);
  const results: Array<{ brand: string; status: string; discovery?: string; recheck?: number; dealPages?: number; reason?: string }> = [];
  for (const brand of brands) {
    const r = await startBrandRun(brand, trigger, now);
    results.push({ brand: brand.slug, status: r.status, discovery: r.discovery, ...(r.recheck ? { recheck: r.recheck } : {}), ...(r.dealPages ? { dealPages: r.dealPages } : {}), reason: r.reason });
    if (isStopCode(r.code)) break; // the same reason applies to every remaining brand
  }
  const started = results.filter((r) => r.status === "STARTED").length;
  const stopped = results.find((r) => r.status === "SKIPPED" && /budget|paused|not configured/i.test(r.reason ?? ""));
  return { status: stopped && !started ? "SKIPPED" : "OK", reason: stopped?.reason, brands: brands.length, started, results };
}

/** commerce-collect: collect finished runs, then age offers. */
export async function runCommerceCollect(trigger: string, now = new Date()) {
  const collected = await collectCommerceRuns(trigger, now);
  const stale = await markStaleOffers(now);
  // Offers that just went stale stop being shown as current: refresh the public pages.
  if (stale && !collected.collected) await revalidateCommerce();
  return { ...collected, staleOffers: stale };
}
