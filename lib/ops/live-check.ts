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
import { searchPexels } from "@/lib/pipeline/pexels";
import { validateContentItem } from "@/lib/pipeline/validate";
import { buildSovrnRequestUrl } from "@/lib/sovrn/client";
import { buildQueryString, extractOfferArray, isProviderAffiliateUrl, normalizeOffers, rankOffers } from "@/lib/sovrn/offers";

export type LiveCheckStatus = "OK" | "BLOCKED_BY_ENVIRONMENT" | "AUTH_FAILED" | "PROVIDER_ERROR" | "INVALID_RESPONSE" | "EMPTY" | "FAIL";
export type LiveCheckResult = { integration: string; status: LiveCheckStatus; detail: Record<string, unknown> };
export type LiveCheckOptions = { product?: string; brand?: string };

let opts: LiveCheckOptions = {};
const arg = (name: "product" | "brand") => opts[name];
let results: LiveCheckResult[] = [];
const add = (integration: string, status: LiveCheckStatus, detail: Record<string, unknown> = {}) => results.push({ integration, status, detail });
const httpStatus = (s: number): LiveCheckStatus => (s === 401 || s === 403 ? "AUTH_FAILED" : "PROVIDER_ERROR");

function environment() {
  const names = ["DATABASE_URL", "DIRECT_URL", "NEXT_PUBLIC_SITE_URL", "CRON_SECRET", "ADMIN_SESSION_SECRET", "CONTENT_API_URL", "CONTENT_API_KEY", "SOVRN_API_URL", "SOVRN_API_KEY", "SOVRN_SITE_KEY", "PEXELS_API_KEY", "GSC_SITE_URL", "GSC_SERVICE_ACCOUNT_JSON", "APIFY_API_TOKEN", "KEYWORD_TO_BLOG_API_URL", "KEYWORD_TO_BLOG_API_KEY", "SOVRN_SITE_STATUS"];
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
  if (!res.ok) return add("sovrn", res.error ? "PROVIDER_ERROR" : httpStatus(res.status), { query: buildQueryString(query), httpStatus: res.status, error: res.error?.kind, hint: res.status === 401 || res.status === 403 ? "check SOVRN_API_KEY is the secret key" : undefined });
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
  const productName = arg("product") ?? product?.productName ?? "MacBook Air";
  const r = await searchPexels(productName, arg("product") ? arg("brand") : product?.brand);
  if (r.image) return add("pexels", "OK", { product: productName, attribution: r.image.attribution, attributionUrl: r.image.attributionUrl, license: r.image.license });
  // "No relevant photo" is the relevance filter working, not a provider failure.
  add("pexels", /HTTP 40[13]/.test(r.reason ?? "") ? "AUTH_FAILED" : /no Pexels photo/.test(r.reason ?? "") ? "EMPTY" : "PROVIDER_ERROR", { product: productName, reason: r.reason });
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

/** Keyword-to-Blog: an empty request is rejected at validation when the key is valid, so no quota is used. */
async function keywordToBlog() {
  const url = config.aiGuides.url();
  const key = config.aiGuides.key();
  if (!url || !key) return add("keywordToBlog", "BLOCKED_BY_ENVIRONMENT", { missing: [!url && "KEYWORD_TO_BLOG_API_URL", !key && "KEYWORD_TO_BLOG_API_KEY"].filter(Boolean) });
  const res = await safeFetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" }, body: "{}", timeoutMs: 20000, maxRedirects: 0, readBody: true, maxBytes: 100_000 });
  let code: string | undefined;
  try {
    code = (JSON.parse(res.body ?? "") as { error?: { code?: string } }).error?.code;
  } catch {
    /* non-JSON */
  }
  if (res.status === 400 && code === "VALIDATION_ERROR") return add("keywordToBlog", "OK", { auth: "accepted", note: "checked without generating (no quota used)" });
  if (res.status === 401 || res.status === 403) return add("keywordToBlog", "AUTH_FAILED", { httpStatus: res.status, code });
  add("keywordToBlog", "PROVIDER_ERROR", { httpStatus: res.status, code, error: res.error?.kind });
}

/** Sovrn's approval of this site is only knowable from the Sovrn dashboard; it is never inferred. */
function sovrnSite() {
  const status = config.sovrn.siteStatus();
  add("sovrnSiteApproval", status === "APPROVED" ? "OK" : status === "DENIED" ? "FAIL" : "EMPTY", {
    SOVRN_SITE_STATUS: status,
    commerceScript: config.sovrn.commerceScript() ? (config.sovrn.siteKey() ? "installed on public pages" : "enabled but SOVRN_SITE_KEY missing") : "not installed (SOVRN_COMMERCE_SCRIPT=false)",
    note: status === "APPROVED" ? "set by the site owner from the Sovrn dashboard" : "Complete Sovrn's site approval, then set SOVRN_SITE_STATUS to what the Sovrn dashboard shows.",
  });
}

/** Runs every probe once. Read-only: no DB writes, no provider caching, no secret values. */
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
  sovrnSite();
  const failed = results.filter((r) => !["OK", "BLOCKED_BY_ENVIRONMENT", "EMPTY"].includes(r.status));
  return { checkedAt: new Date().toISOString(), ok: failed.length === 0, results };
}
