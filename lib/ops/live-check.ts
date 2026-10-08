/**
 * Read-only go-live preflight for the real integrations. Used by `npm run live:check` and by
 * Admin → Go-live checks (so it can run where the production secrets live).
 *
 * It makes one authenticated request to each configured provider and reports what came back.
 * It never writes to the database, never caches provider responses and never returns secret values: only variable names, statuses and counts.
 * Unconfigured integrations are BLOCKED_BY_ENVIRONMENT, not failures.
 */
import { config } from "@/lib/config";
import { redactString } from "@/lib/log";
import { db } from "@/lib/db";
import { checkGscAccess } from "@/lib/gsc";
import { actorInputFields, apifyAccount, buildActorInput } from "@/lib/pipeline/apify";
import { safeFetch } from "@/lib/net/safe-fetch";
import { checkPageSchema, contentApiHeaders, contentSourceName, expectedSchemaVersion, extractContentItems, nextContentPage } from "@/lib/pipeline/content-source";
import { findPexelsImage, pexelsSearch } from "@/lib/pipeline/pexels";
import { runIntegrityChecks } from "./integrity";
import { automationHealth } from "@/lib/automation/daily-article";
import { validateContentItem } from "@/lib/pipeline/validate";
import { affiliateConfigIssues, getAffiliateProvider, selectedProviderNames } from "@/lib/affiliate/provider";

export type LiveCheckStatus = "OK" | "BLOCKED_BY_ENVIRONMENT" | "AUTH_FAILED" | "RATE_LIMITED" | "PROVIDER_ERROR" | "INVALID_RESPONSE" | "EMPTY" | "FAIL";
export type LiveCheckResult = { integration: string; status: LiveCheckStatus; detail: Record<string, unknown> };
export type LiveCheckOptions = { product?: string; brand?: string };

let opts: LiveCheckOptions = {};
const arg = (name: "product" | "brand") => opts[name];
let results: LiveCheckResult[] = [];
const add = (integration: string, status: LiveCheckStatus, detail: Record<string, unknown> = {}) => results.push({ integration, status, detail });
const httpStatus = (s: number): LiveCheckStatus => (s === 401 || s === 403 ? "AUTH_FAILED" : s === 429 ? "RATE_LIMITED" : "PROVIDER_ERROR");

function environment() {
  const names = ["DATABASE_URL", "DIRECT_URL", "NEXT_PUBLIC_SITE_URL", "CRON_SECRET", "ADMIN_SESSION_SECRET", "CONTENT_API_URL", "CONTENT_API_KEY", "PEXELS_API_KEY", "GSC_SITE_URL", "GSC_SERVICE_ACCOUNT_JSON", "APIFY_API_TOKEN", "KEYWORD_TO_BLOG_API_URL", "KEYWORD_TO_BLOG_API_KEY", "KEYWORD_TO_BLOG_API_KEY_SECONDARY", "AFFILIATE_PROVIDER"];
  const set = Object.fromEntries(names.map((n) => [n, Boolean(process.env[n])]));
  const problems: string[] = [];
  for (const n of Object.keys(process.env)) if (n.startsWith("NEXT_PUBLIC_") && /KEY|SECRET|TOKEN|PASSWORD/i.test(n)) problems.push(`${n} would be exposed to the browser`);
  if (process.env.UNSAFE_ALLOW_LOOPBACK_FOR_TESTS === "true") problems.push("UNSAFE_ALLOW_LOOPBACK_FOR_TESTS is on (tests only)");
  add("environment", problems.length ? "FAIL" : "OK", { set, problems });
}

async function database() {
  if (!process.env.DATABASE_URL) return add("database", "BLOCKED_BY_ENVIRONMENT");
  try {
    await db.$queryRaw`SELECT 1`;
    const migrations = await db.$queryRaw<Array<{ migration_name: string; finished_at: Date | null }>>`SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at`;
    const noRls = await db.$queryRaw<Array<{ relname: string }>>`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`;
    const published = await db.normalizedReview.count({ where: { status: "PUBLISHED" } });
    const unfinished = migrations.filter((m) => !m.finished_at).map((m) => m.migration_name);
    add("database", unfinished.length || noRls.length ? "FAIL" : "OK", { host: new URL(process.env.DATABASE_URL).hostname, migrationsApplied: migrations.length, unfinished, tablesWithoutRls: noRls.map((r) => r.relname), publishedReviews: published });
  } catch (error) {
    add("database", "FAIL", { error: (error as Error).message.split("\n")[0] });
  }
}

/** First Content API page only: shape, schema validation, dates, pagination. */
async function contentApi(): Promise<{ productName?: string; brand?: string } | undefined> {
  const url = config.contentApi.url();
  if (!url) return void add("contentApi", "BLOCKED_BY_ENVIRONMENT", { missing: "CONTENT_API_URL" });
  const res = await safeFetch(url, { headers: contentApiHeaders(), timeoutMs: config.contentApi.timeoutMs(), maxRedirects: 3, readBody: true, maxBytes: 20_000_000 });
  if (!res.ok) return void add("contentApi", res.error ? "PROVIDER_ERROR" : httpStatus(res.status), { httpStatus: res.status, error: res.error?.kind, message: res.error?.message });
  let payload: unknown;
  try {
    payload = JSON.parse(res.body ?? "");
  } catch {
    return void add("contentApi", "INVALID_RESPONSE", { reason: "response is not JSON", contentType: res.headers?.["content-type"] });
  }
  const items = extractContentItems(payload);
  if (!items) return void add("contentApi", "INVALID_RESPONSE", { reason: "no items/results/data/reviews/articles array", topLevelKeys: payload && typeof payload === "object" ? Object.keys(payload).slice(0, 20) : typeof payload });
  const schema = checkPageSchema(payload, items, res.headers ?? {});
  if (!schema.ok) return void add("contentApi", "INVALID_RESPONSE", { reason: `CONTENT_API_SCHEMA_MISMATCH: ${schema.reason}`, declaredSchemaVersion: schema.declaredVersion ?? null, expectedSchemaVersion: expectedSchemaVersion(), fieldsSeen: schema.fieldsSeen });
  const issues: Record<string, number> = {};
  const fields: Record<string, number> = {};
  const dates: number[] = [];
  const ids = new Set<string>();
  let valid = 0;
  let duplicateIds = 0;
  let first: { productName?: string; brand?: string } | undefined;
  for (const item of items) {
    if (item && typeof item === "object") for (const k of Object.keys(item)) fields[k] = (fields[k] ?? 0) + 1;
    const v = validateContentItem(item);
    if (v.ok) {
      valid++;
      if (ids.has(v.value.sourceId)) duplicateIds++;
      ids.add(v.value.sourceId);
      if (v.value.publishedAt) dates.push(v.value.publishedAt.getTime());
      first ??= { productName: v.value.productName, brand: v.value.brand };
    } else for (const i of v.issues) issues[i.split(":")[0]] = (issues[i.split(":")[0]] ?? 0) + 1;
  }
  const next = nextContentPage(payload, new URL(url));
  add("contentApi", items.length ? "OK" : "EMPTY", {
    itemsOnFirstPage: items.length,
    valid,
    invalid: items.length - valid,
    invalidByField: issues,
    duplicateSourceIds: duplicateIds,
    fieldsSeen: fields,
    newestPublishedAt: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
    oldestPublishedAt: dates.length ? new Date(Math.min(...dates)).toISOString() : null,
    withoutPublicationDate: valid - dates.length,
    pagination: next ? "next link found (same origin)" : "no next link on first page",
    apiVersion: res.headers?.["api-version"] ?? res.headers?.["x-api-version"] ?? null,
    declaredSchemaVersion: schema.declaredVersion ?? null,
    expectedSchemaVersion: expectedSchemaVersion(),
  });
  return first;
}

async function pexels(product?: { productName?: string; brand?: string }) {
  if (!config.images.pexelsKey()) return add("pexels", "BLOCKED_BY_ENVIRONMENT", { missing: "PEXELS_API_KEY" });
  // 1. Raw authenticated search: status, rate-limit headers, record fields.
  const raw = await pexelsSearch("data center servers", { perPage: 5 });
  const first = raw.photos[0];
  const api = {
    query: raw.query,
    httpStatus: raw.httpStatus,
    status: raw.status,
    rateLimit: raw.rateLimit,
    validPhotos: raw.photos.length,
    sample: first ? { id: first.id, imageUrl: first.src.landscape, photographer: first.photographer, photographerUrl: first.photographer_url ?? null, pexelsUrl: first.url, original: `${first.width}x${first.height}` } : null,
  };
  if (raw.status !== "OK") return add("pexels", raw.status === "AUTH_FAILED" ? "AUTH_FAILED" : raw.status === "INVALID_RESPONSE" ? "INVALID_RESPONSE" : raw.status === "EMPTY" ? "EMPTY" : "PROVIDER_ERROR", { api, reason: raw.reason });
  // 2. The pipeline's own choice for a product (photo of the product, else illustrative).
  const productName = arg("product") ?? product?.productName ?? "MacBook Air";
  const pick = await findPexelsImage({ productName, brand: arg("product") ? arg("brand") : product?.brand });
  add("pexels", "OK", { api, product: productName, choice: pick.image ? { subject: pick.image.subject, query: pick.image.searchQuery, attribution: pick.image.attribution, attributionUrl: pick.image.attributionUrl } : { none: pick.reason } });
}

async function gsc() {
  if (!config.gsc.siteUrl() || !config.gsc.serviceAccountJson()) return add("gsc", "BLOCKED_BY_ENVIRONMENT", { missing: [!config.gsc.siteUrl() && "GSC_SITE_URL", !config.gsc.serviceAccountJson() && "GSC_SERVICE_ACCOUNT_JSON"].filter(Boolean) });
  const access = await checkGscAccess();
  add("gsc", access.ok ? "OK" : /authentication/.test(access.reason) || access.httpStatus === 403 ? "AUTH_FAILED" : "FAIL", access);
}

/** Apify: token works, and the actor's input schema still has every field we send. */
async function apify() {
  if (!config.apify.token()) return add("apify", "BLOCKED_BY_ENVIRONMENT", { missing: "APIFY_API_TOKEN" });
  try {
    const account = await apifyAccount();
    const fields = await actorInputFields();
    const sent = Object.keys(buildActorInput({ slug: "check", startUrls: ["https://example.com"], reviewUrlPatterns: ["https://example.com/**"], maxPagesPerRun: 1 }));
    const unknown = fields ? sent.filter((f) => !fields.includes(f)) : [];
    const sources = await db.reviewSource.count({ where: { enabled: true } }).catch(() => null);
    add("apify", unknown.length ? "INVALID_RESPONSE" : "OK", { username: account.username, plan: account.plan, actor: config.apify.actorId(), inputSchemaChecked: Boolean(fields), unknownInputFields: unknown, enabledSources: sources });
  } catch (error) {
    const code = (error as { code?: string }).code;
    add("apify", code === "APIFY_AUTH_FAILED" ? "AUTH_FAILED" : "PROVIDER_ERROR", { error: (error as Error).message });
  }
}

/**
 * Keyword-to-Blog: even a request rejected at validation counts against the plan's daily quota,
 * so the live probe only runs when KEYWORD_TO_BLOG_PROBE=true. Otherwise configuration only.
 */
async function keywordToBlog() {
  const url = config.aiGuides.url();
  const key = config.aiGuides.key();
  if (!url || !key) return add("keywordToBlog", "BLOCKED_BY_ENVIRONMENT", { missing: [!url && "KEYWORD_TO_BLOG_API_URL", !key && "KEYWORD_TO_BLOG_API_KEY"].filter(Boolean) });
  if (process.env.KEYWORD_TO_BLOG_PROBE !== "true") return add("keywordToBlog", "OK", { configured: true, probed: false, note: "not called: every request, even a rejected one, uses daily quota (set KEYWORD_TO_BLOG_PROBE=true to probe)" });
  const res = await safeFetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" }, body: "{}", timeoutMs: 20000, maxRedirects: 0, readBody: true, maxBytes: 100_000 });
  let code: string | undefined;
  try {
    code = (JSON.parse(res.body ?? "") as { error?: { code?: string } }).error?.code;
  } catch {
    /* non-JSON */
  }
  if (res.status === 400 && code === "VALIDATION_ERROR") return add("keywordToBlog", "OK", { auth: "accepted", note: "probed with an empty request (uses one daily request)" });
  if (res.status === 401 || res.status === 403) return add("keywordToBlog", "AUTH_FAILED", { httpStatus: res.status, code });
  add("keywordToBlog", "PROVIDER_ERROR", { httpStatus: res.status, code, error: res.error?.kind });
}

/** Affiliate provider: configuration only ("none" keeps every retailer link plain). No affiliate link is generated or followed. */
function affiliate() {
  const provider = getAffiliateProvider();
  const selected = selectedProviderNames();
  const issues = affiliateConfigIssues();
  if (selected.every((n) => n === "none")) return add("affiliateProvider", "BLOCKED_BY_ENVIRONMENT", { provider: "none", missing: ["AFFILIATE_PROVIDER"], note: "no affiliate provider: retailer links stay plain" });
  if (!provider.active || issues.unknown.length) return add("affiliateProvider", issues.unknown.length ? "FAIL" : "BLOCKED_BY_ENVIRONMENT", { provider: selected.join(","), active: provider.active, unknownProviders: issues.unknown, missing: issues.missingEnv, note: "links stay plain until every listed variable is set" });
  add("affiliateProvider", issues.missingEnv.length ? "FAIL" : "OK", { provider: provider.name, active: true, missing: issues.missingEnv, note: "retailer links may carry provider-generated affiliate URLs (run the affiliate-links job to apply)" });
}

/** Runs every probe once. Read-only: no DB writes, no provider caching, no secret values. */
/** Read-only database consistency audit (duplicates, invalid references, unbuilt pages). */
async function integrity() {
  if (!process.env.DATABASE_URL) return add("dataIntegrity", "BLOCKED_BY_ENVIRONMENT", { missing: "DATABASE_URL" });
  try {
    const r = await runIntegrityChecks();
    add("dataIntegrity", r.ok ? "OK" : "FAIL", r.checks);
  } catch (error) {
    add("dataIntegrity", "FAIL", { error: String(error).slice(0, 300) });
  }
}

/** Daily article automation: scheduler running, provider healthy, nothing stuck. */
async function automation() {
  if (!process.env.DATABASE_URL) return add("dailyArticles", "BLOCKED_BY_ENVIRONMENT", { missing: "DATABASE_URL" });
  try {
    const h = await automationHealth();
    add("dailyArticles", h.ok ? "OK" : "FAIL", { problems: h.problems, lastPublished: h.lastPublished, queued: h.queued });
  } catch (error) {
    add("dailyArticles", "FAIL", { error: String(error).slice(0, 300) });
  }
}

export async function runLiveCheck(options: LiveCheckOptions = {}) {
  opts = options;
  results = [];
  environment();
  await database();
  const product = await contentApi();
  await pexels(product);
  await gsc();
  await apify();
  await keywordToBlog();
  affiliate();
  await integrity();
  await automation();
  const failed = results.filter((r) => !["OK", "BLOCKED_BY_ENVIRONMENT", "EMPTY"].includes(r.status));
  return { checkedAt: new Date().toISOString(), ok: failed.length === 0, results };
}

// ── Integration readiness (Admin → Integrations) ──────────────────────────

export type ReadinessStatus = "READY" | "BLOCKED_BY_ENVIRONMENT" | "ERROR";
export type IntegrationReadiness = {
  key: string;
  name: string;
  status: ReadinessStatus;
  /** Env var NAMES that must be set (never values). */
  missingEnv: string[];
  /** Optional env var names that are not set. */
  optionalMissing: string[];
  lastSuccessAt: string | null;
  lastError: { at: string; message: string } | null;
  note?: string;
};

const isSet = (n: string) => Boolean(process.env[n]?.trim());
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const newer = (a: Date | null | undefined, b: Date | null | undefined) => Boolean(a && (!b || a.getTime() > b.getTime()));
const OK_STATUSES = new Set(["OK", "EMPTY", "BLOCKED_BY_ENVIRONMENT"]);

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/**
 * One row per integration: READY / BLOCKED_BY_ENVIRONMENT / ERROR, the last successful call
 * recorded in the database, the latest unresolved error, and the exact missing env var names.
 * Read-only: no provider is called here (use "Run checks" for live calls).
 */
export async function integrationReadiness(now = new Date()): Promise<IntegrationReadiness[]> {
  const hasDb = isSet("DATABASE_URL");
  const q = <T>(fn: () => Promise<T>, fallback: T) => (hasDb ? safe(fn, fallback) : Promise.resolve(fallback));
  const lastLive = await q(() => db.auditLog.findFirst({ where: { action: "integrations.live_check" }, orderBy: { createdAt: "desc" }, select: { createdAt: true, metadata: true } }), null);
  const liveResults = ((lastLive?.metadata as { results?: LiveCheckResult[] } | null)?.results ?? []) as LiveCheckResult[];
  const live = (k: string) => liveResults.find((r) => r.integration === k);
  const liveError = (k: string): { at: Date; message: string } | null => {
    const r = live(k);
    if (!r || OK_STATUSES.has(r.status) || !lastLive) return null;
    const d = r.detail as { reason?: unknown; error?: unknown; message?: unknown; httpStatus?: unknown };
    return { at: lastLive.createdAt, message: `live check ${r.status}${d.reason || d.error || d.message ? `: ${String(d.reason ?? d.error ?? d.message).slice(0, 200)}` : d.httpStatus ? ` (HTTP ${String(d.httpStatus)})` : ""}` };
  };
  const liveOkAt = (k: string) => (live(k)?.status === "OK" ? (lastLive?.createdAt ?? null) : null);
  const latest = (...ds: Array<Date | null | undefined>) => ds.filter((d): d is Date => Boolean(d)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const pickError = (...es: Array<{ at: Date; message: string } | null | undefined>) => es.filter((e): e is { at: Date; message: string } => Boolean(e)).sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null;
  const failure = (where: Record<string, unknown>) =>
    q(async () => {
      const f = await db.pipelineFailure.findFirst({ where: { resolvedAt: null, ...where }, orderBy: { lastOccurredAt: "desc" }, select: { lastOccurredAt: true, errorCode: true, message: true } });
      return f ? { at: f.lastOccurredAt, message: `${f.errorCode}: ${f.message.slice(0, 200)}` } : null;
    }, null);
  const jobRun = (job: string, status: string) => q(() => db.jobRun.findFirst({ where: { job, status }, orderBy: { startedAt: "desc" }, select: { startedAt: true, error: true, reason: true } }), null);

  const row = (r: Omit<IntegrationReadiness, "status" | "lastSuccessAt" | "lastError"> & { success: Date | null; error: { at: Date; message: string } | null; forceError?: string }): IntegrationReadiness => {
    const status: ReadinessStatus = r.missingEnv.length ? "BLOCKED_BY_ENVIRONMENT" : r.forceError || (r.error && newer(r.error.at, r.success)) ? "ERROR" : "READY";
    const lastError = r.forceError ? { at: now.toISOString(), message: r.forceError } : r.error ? { at: r.error.at.toISOString(), message: redactString(r.error.message) } : null;
    return { key: r.key, name: r.name, status, missingEnv: r.missingEnv, optionalMissing: r.optionalMissing, lastSuccessAt: iso(r.success), lastError, note: r.note };
  };
  const need = (...names: string[]) => names.filter((n) => !isSet(n));
  const rows: IntegrationReadiness[] = [];

  // Content API
  {
    const ok = await q(() => db.ingestionRun.findFirst({ where: { source: contentSourceName(), status: { in: ["COMPLETED", "COMPLETED_WITH_ERRORS"] } }, orderBy: { startedAt: "desc" }, select: { completedAt: true, startedAt: true } }), null);
    const err = await failure({ stage: "CONTENT_FETCH", entityId: "content-api" });
    rows.push(row({ key: "contentApi", name: "Content API", missingEnv: need("CONTENT_API_URL"), optionalMissing: need("CONTENT_API_KEY", "CONTENT_API_SOURCE_NAME", "CONTENT_API_SCHEMA_VERSION"), success: latest(ok?.completedAt ?? ok?.startedAt, liveOkAt("contentApi")), error: pickError(err, liveError("contentApi")), note: "Contract: docs/CONTENT_API_CONTRACT.md. Verify with `npx tsx scripts/verify-content-api.ts`." }));
  }
  // Apify
  {
    const ok = await q(() => db.apifyRun.findFirst({ where: { status: { in: ["SUCCEEDED", "COLLECTING", "COLLECTED"] } }, orderBy: { startedAt: "desc" }, select: { finishedAt: true, startedAt: true } }), null);
    const err = await failure({ errorCode: { in: ["APIFY_AUTH_FAILED", "APIFY_ACTOR_NOT_APPROVED", "APIFY_RESPONSE_INVALID"] } });
    rows.push(row({ key: "apify", name: "Apify", missingEnv: need("APIFY_API_TOKEN"), optionalMissing: need("APIFY_ACTOR_ID"), success: latest(ok?.finishedAt ?? ok?.startedAt, liveOkAt("apify")), error: pickError(err, liveError("apify")), note: "Verify a rotated token with `npx tsx scripts/verify-apify-token.ts`." }));
  }
  // Pexels
  {
    const ok = await q(() => db.imageAsset.findFirst({ where: { providerPhotoId: { startsWith: "pexels:" } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }), null);
    rows.push(row({ key: "pexels", name: "Pexels images", missingEnv: need("PEXELS_API_KEY"), optionalMissing: [], success: latest(ok?.createdAt, liveOkAt("pexels")), error: liveError("pexels") }));
  }
  // Feedico coupon feed
  {
    const ok = await jobRun("feedico-coupons", "SUCCEEDED");
    const src = await q(() => db.commerceSource.findUnique({ where: { slug: "feedico" }, select: { lastError: true, crawlStatus: true, lastCrawlAt: true } }), null);
    const err = src?.lastError && src.lastCrawlAt && src.crawlStatus !== "OK" ? { at: src.lastCrawlAt, message: `${src.crawlStatus}: ${src.lastError}` } : null;
    rows.push(row({ key: "feedico", name: "Feedico coupon feed", missingEnv: need("FEEDICO_API_KEY"), optionalMissing: [], success: ok?.startedAt ?? null, error: err, note: "Feed codes are public (labelled Via Feedico) while listed within 14 days. Verify with `npx tsx scripts/verify-feedico.ts`." }));
  }
  // Keyword-to-Blog
  {
    const ok = await q(() => db.normalizedReview.findFirst({ where: { kind: "AI_GUIDE" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }), null);
    const failed = await jobRun("daily-article", "FAILED");
    rows.push(row({ key: "keywordToBlog", name: "Keyword-to-Blog", missingEnv: need("KEYWORD_TO_BLOG_API_URL", "KEYWORD_TO_BLOG_API_KEY"), optionalMissing: need("KEYWORD_TO_BLOG_API_KEY_SECONDARY"), success: latest(ok?.createdAt, liveOkAt("keywordToBlog")), error: pickError(failed ? { at: failed.startedAt, message: `daily-article job failed: ${(failed.error ?? failed.reason ?? "").slice(0, 200)}` } : null, liveError("keywordToBlog")) }));
  }
  // Affiliate
  {
    const selected = selectedProviderNames().filter((n) => n !== "none");
    const issues = affiliateConfigIssues();
    const ok = await q(() => db.commerceOffer.findFirst({ where: { affiliateStatus: "AFFILIATED" }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }), null);
    rows.push(
      row({
        key: "affiliate",
        name: "Affiliate links",
        missingEnv: selected.length ? issues.missingEnv : ["AFFILIATE_PROVIDER"],
        optionalMissing: [],
        success: ok?.updatedAt ?? null,
        error: null,
        forceError: issues.unknown.length ? `unknown AFFILIATE_PROVIDER value(s): ${issues.unknown.join(", ")} (use amazon, skimlinks, impact or none)` : undefined,
        note: selected.length ? `AFFILIATE_PROVIDER=${selected.join(",")}` : "AFFILIATE_PROVIDER=none: every retailer link stays plain. Set it to amazon, skimlinks and/or impact plus that provider's variables.",
      }),
    );
  }
  // Google Search Console
  {
    const ok = await q(() => db.searchIndexCheck.findFirst({ where: { verdict: { not: "ERROR" } }, orderBy: { checkedAt: "desc" }, select: { checkedAt: true } }), null);
    const bad = await q(() => db.searchIndexCheck.findFirst({ where: { verdict: "ERROR" }, orderBy: { checkedAt: "desc" }, select: { checkedAt: true, error: true } }), null);
    const maint = await q(() => db.auditLog.findFirst({ where: { action: "gsc.maintenance" }, orderBy: { createdAt: "desc" }, select: { createdAt: true, metadata: true } }), null);
    const maintStatus = (maint?.metadata as { status?: string } | null)?.status;
    rows.push(
      row({
        key: "gsc",
        name: "Google Search Console",
        missingEnv: need("GSC_SITE_URL", "GSC_SERVICE_ACCOUNT_JSON"),
        optionalMissing: need("GOOGLE_SITE_VERIFICATION"),
        success: latest(ok?.checkedAt, maintStatus === "OK" ? maint?.createdAt : null, liveOkAt("gsc")),
        error: pickError(bad ? { at: bad.checkedAt, message: `URL inspection: ${(bad.error ?? "").slice(0, 200)}` } : null, maint && maintStatus === "ERROR" ? { at: maint.createdAt, message: "sitemap/analytics sync failed (see the audit log entry gsc.maintenance)" } : null, liveError("gsc")),
        note: "Verify with `npx tsx scripts/verify-gsc.ts`.",
      }),
    );
  }
  // Analytics (first-party events always; external ID optional)
  {
    const ok = await q(() => db.analyticsEvent.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }), null);
    rows.push(row({ key: "analytics", name: "Analytics", missingEnv: need("DATABASE_URL"), optionalMissing: need("NEXT_PUBLIC_ANALYTICS_ID"), success: ok?.createdAt ?? null, error: null, note: "First-party events are stored in the database; NEXT_PUBLIC_ANALYTICS_ID adds an external analytics ID (public, not a secret)." }));
  }
  // Cron
  {
    const ok = await q(() => db.jobRun.findFirst({ where: { trigger: "cron", status: { in: ["SUCCEEDED", "SKIPPED", "PAUSED"] } }, orderBy: { startedAt: "desc" }, select: { startedAt: true } }), null);
    const failed = await q(() => db.jobRun.findFirst({ where: { trigger: "cron", status: "FAILED" }, orderBy: { startedAt: "desc" }, select: { startedAt: true, job: true, error: true } }), null);
    const stale = hasDb && isSet("CRON_SECRET") && (!ok || now.getTime() - ok.startedAt.getTime() > 36 * 3_600_000);
    rows.push(
      row({
        key: "cron",
        name: "Scheduled jobs (cron)",
        missingEnv: need("CRON_SECRET"),
        optionalMissing: [],
        success: ok?.startedAt ?? null,
        error: failed ? { at: failed.startedAt, message: `${failed.job} failed: ${(failed.error ?? "").slice(0, 200)}` } : null,
        forceError: stale ? "no scheduled (cron) job run recorded in the last 36 hours" : undefined,
      }),
    );
  }
  return rows;
}
