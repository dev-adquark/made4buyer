/**
 * Read-only go-live preflight for the real integrations. Used by `npm run live:check` and by
 * Admin → Go-live checks (so it can run where the production secrets live).
 *
 * It makes one authenticated request to each configured provider and reports what came back.
 * It never writes to the database, never caches provider responses, never follows affiliate
 * links and never returns secret values: only variable names, statuses and counts.
 * Unconfigured integrations are BLOCKED_BY_ENVIRONMENT, not failures.
 */
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { checkGscAccess } from "@/lib/gsc";
import { actorInputFields, apifyAccount, buildActorInput } from "@/lib/pipeline/apify";
import { safeFetch } from "@/lib/net/safe-fetch";
import { contentApiHeaders, extractContentItems, nextContentPage } from "@/lib/pipeline/content-source";
import { findPexelsImage, pexelsSearch } from "@/lib/pipeline/pexels";
import { runIntegrityChecks } from "./integrity";
import { automationHealth } from "@/lib/automation/daily-article";
import { validateContentItem } from "@/lib/pipeline/validate";
import { fetchSovrnCampaigns, sovrnApprovalStatus } from "@/lib/sovrn/account";
import { buildSovrnRequestUrl } from "@/lib/sovrn/client";
import { buildQueryString, extractOfferArray, isProviderAffiliateUrl, normalizeOffers, rankOffers } from "@/lib/sovrn/offers";

export type LiveCheckStatus = "OK" | "BLOCKED_BY_ENVIRONMENT" | "AUTH_FAILED" | "RATE_LIMITED" | "PROVIDER_ERROR" | "INVALID_RESPONSE" | "EMPTY" | "FAIL";
export type LiveCheckResult = { integration: string; status: LiveCheckStatus; detail: Record<string, unknown> };
export type LiveCheckOptions = { product?: string; brand?: string };

let opts: LiveCheckOptions = {};
const arg = (name: "product" | "brand") => opts[name];
let results: LiveCheckResult[] = [];
const add = (integration: string, status: LiveCheckStatus, detail: Record<string, unknown> = {}) => results.push({ integration, status, detail });
const httpStatus = (s: number): LiveCheckStatus => (s === 401 || s === 403 ? "AUTH_FAILED" : s === 429 ? "RATE_LIMITED" : "PROVIDER_ERROR");

function environment() {
  const names = ["DATABASE_URL", "DIRECT_URL", "NEXT_PUBLIC_SITE_URL", "CRON_SECRET", "ADMIN_SESSION_SECRET", "CONTENT_API_URL", "CONTENT_API_KEY", "SOVRN_API_URL", "SOVRN_API_KEY", "SOVRN_SITE_KEY", "PEXELS_API_KEY", "GSC_SITE_URL", "GSC_SERVICE_ACCOUNT_JSON", "APIFY_API_TOKEN", "KEYWORD_TO_BLOG_API_URL", "KEYWORD_TO_BLOG_API_KEY", "KEYWORD_TO_BLOG_API_KEY_SECONDARY", "SOVRN_SITE_STATUS"];
  const set = Object.fromEntries(names.map((n) => [n, Boolean(process.env[n])]));
  const problems: string[] = [];
  const secret = process.env.SOVRN_API_KEY;
  if (secret && secret === process.env.SOVRN_SITE_KEY) problems.push("SOVRN_SITE_KEY holds the SECRET key. It must be the public site key; the site key is disabled until fixed, and the secret should be regenerated in Sovrn");
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
  });
  return first;
}

/** One Sovrn search, parsed and ranked in memory (nothing cached, no link followed). */
async function sovrn(product?: { productName?: string; brand?: string }) {
  const base = config.sovrn.apiUrl();
  const key = config.sovrn.apiKey();
  if (!base || !key) return add("sovrn", "BLOCKED_BY_ENVIRONMENT", { missing: [!base && "SOVRN_API_URL", !key && "SOVRN_API_KEY"].filter(Boolean) });
  const productName = arg("product") ?? product?.productName;
  if (!productName) return add("sovrn", "FAIL", { reason: "no product to search: pass --product, or configure the Content API" });
  const query = { productName, brand: arg("product") ? arg("brand") : product?.brand };
  const res = await safeFetch(buildSovrnRequestUrl(base, buildQueryString(query), config.sovrn.queryParam()), { headers: { Accept: "application/json", Authorization: `${config.sovrn.authScheme()} ${key}` }, timeoutMs: config.sovrn.timeoutMs(), maxRedirects: 2, readBody: true, maxBytes: 5_000_000 });
  if (!res.ok) return add("sovrn", res.error ? "PROVIDER_ERROR" : httpStatus(res.status), { query: buildQueryString(query), httpStatus: res.status, error: res.error?.kind, hint: res.status === 401 ? "Sovrn rejected the request: usually the site is not yet approved for the Price Comparison API (check the Sovrn dashboard); if it is approved, check SOVRN_API_KEY is the secret key" : res.status === 403 ? "Sovrn does not recognise this site key: check SOVRN_SITE_KEY / the site path" : undefined });
  let payload: unknown;
  try {
    payload = JSON.parse(res.body ?? "");
  } catch {
    return add("sovrn", "INVALID_RESPONSE", { reason: "response is not JSON" });
  }
  if (!extractOfferArray(payload)) return add("sovrn", "INVALID_RESPONSE", { reason: "no offer array", topLevelKeys: payload && typeof payload === "object" ? Object.keys(payload).slice(0, 20) : typeof payload });
  const offers = normalizeOffers(payload);
  const ranked = rankOffers(query, offers, { minScore: config.sovrn.minScore(), trustedMerchants: config.sovrn.trustedMerchants() });
  const best = ranked[0];
  add("sovrn", offers.length ? "OK" : "EMPTY", {
    query: buildQueryString(query),
    offers: offers.length,
    viable: ranked.filter((r) => r.viable).length,
    withMerchant: offers.filter((o) => o.merchantName).length,
    withPrice: offers.filter((o) => o.price !== undefined).length,
    withProviderDeeplink: offers.filter((o) => o.providerAffiliateUrl && isProviderAffiliateUrl(o.providerAffiliateUrl)).length,
    best: best ? { title: best.offer.title, merchant: best.offer.merchantName ?? null, score: best.breakdown.total, viable: best.viable, notes: best.breakdown.notes } : null,
  });
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

/** Sovrn's approval of this site: live from the Campaigns API (campaign matching SOVRN_SITE_KEY), else SOVRN_SITE_STATUS. */
async function sovrnSite() {
  const account = await fetchSovrnCampaigns({ bypassCache: true });
  const approval = await sovrnApprovalStatus();
  const { status, source } = approval;
  add("sovrnSiteApproval", status === "APPROVED" ? "OK" : status === "DENIED" ? "FAIL" : "EMPTY", {
    status,
    source,
    campaignId: approval.campaign?.campaignId ?? null,
    campaignName: approval.campaign?.name ?? null,
    accountCampaigns: account.status === "OK" ? account.campaigns.length : null,
    campaignsApi: account.status === "OK" ? "OK" : `${account.status}: ${account.message}`,
    SOVRN_SITE_STATUS: config.sovrn.siteStatus(),
    commerceScript: config.sovrn.commerceScript() ? (config.sovrn.siteKey() ? "installed on public pages" : "enabled but SOVRN_SITE_KEY missing") : "not installed (SOVRN_COMMERCE_SCRIPT=false)",
    note:
      approval.message ??
      (status === "APPROVED" ? "approved by Sovrn" : "Complete Sovrn's site review in the Sovrn dashboard; until approved, merchants are not affiliatable and the price API refuses requests."),
  });
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
  await sovrn(product);
  await pexels(product);
  await gsc();
  await apify();
  await keywordToBlog();
  await sovrnSite();
  await integrity();
  await automation();
  const failed = results.filter((r) => !["OK", "BLOCKED_BY_ENVIRONMENT", "EMPTY"].includes(r.status));
  return { checkedAt: new Date().toISOString(), ok: failed.length === 0, results };
}
