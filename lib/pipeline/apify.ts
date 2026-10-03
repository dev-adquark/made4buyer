import type { ApifyRun, ReviewSource } from "@prisma/client";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { PipelineError } from "@/lib/errors";
import { log } from "@/lib/log";
import { safeFetch } from "@/lib/net/safe-fetch";
import { recordFailure, resolveFailures } from "./failures";
import { runIngestion, type IngestSummary } from "./ingest";

/**
 * Editorial review ingestion through the Apify Web Scraper (apify/web-scraper).
 *
 * Serverless functions can't wait for a crawl, so this is two idempotent jobs:
 *   scrape-sources  → for each enabled, due source: check robots.txt, start a run, record it
 *   collect-scrapes → poll unfinished runs; for SUCCEEDED ones fetch the dataset, map every
 *                     item strictly (coded rejections), and feed valid items to runIngestion
 * Only configured sources are crawled, only their allowed domains are accepted, robots.txt is
 * honoured, no proxies or login are used, and nothing missing is ever guessed.
 */

export const APIFY_SOURCE_PREFIX = "apify:";
export const sourceKey = (slug: string) => `${APIFY_SOURCE_PREFIX}${slug}`;

export function apifyConfigured(): boolean {
  return Boolean(config.apify.token());
}

// ── URL helpers ──────────────────────────────────────────────────────────

const TRACKING = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|cmpid$|ito$)/i;

/** Canonical form used for dedupe and as the item id: lower-case host, no hash, no tracking params, no trailing slash. */
export function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return null;
  }
}

/** Glob (`*` = within a path segment, `**` = across segments) → anchored regex source. */
export function globToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else out += "[^/]*";
    } else out += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return `^${out}/?(?:[?#].*)?$`;
}

export function hostAllowed(url: string, allowedDomains: string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return allowedDomains.some((d) => {
      const dom = d.toLowerCase().replace(/^\*\./, "");
      return host === dom || host.endsWith(`.${dom}`);
    });
  } catch {
    return false;
  }
}

// ── robots.txt (start URLs) ──────────────────────────────────────────────

/** Minimal robots.txt check for the `*` group: longest matching Allow/Disallow prefix wins. */
export function robotsAllows(robots: string, path: string): boolean {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const line of robots.split(/\r?\n/)) {
    const m = line.replace(/#.*/, "").trim().match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      lastWasAgent = false;
      if (value) current.rules.push({ allow: key === "allow", path: value });
    } else lastWasAgent = false;
  }
  const group = groups.find((g) => g.agents.includes("*"));
  if (!group) return true;
  let best: { allow: boolean; len: number } | null = null;
  for (const r of group.rules) {
    if (robotsPatternMatches(r.path, path) && (!best || r.path.length > best.len || (r.path.length === best.len && r.allow))) best = { allow: r.allow, len: r.path.length };
  }
  return best ? best.allow : true;
}

/**
 * robots.txt path match: `*` matches any run of characters, a trailing `$` anchors the end.
 * Iterative wildcard matching (no RegExp), so hostile rules cannot cause catastrophic backtracking.
 */
export function robotsPatternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const p = anchored ? pattern.slice(0, -1) : pattern;
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (j < path.length) {
    if (i < p.length && p[i] === "*") {
      star = i++;
      mark = j;
    } else if (i < p.length && p[i] === path[j]) {
      i++;
      j++;
    } else if (i === p.length && !anchored) {
      return true; // prefix match
    } else if (star >= 0) {
      i = star + 1;
      j = ++mark;
    } else return false;
  }
  while (i < p.length && p[i] === "*") i++;
  return i === p.length;
}

async function checkRobots(url: string): Promise<{ allowed: boolean; reason?: string }> {
  const u = new URL(url);
  const res = await safeFetch(`${u.origin}/robots.txt`, { timeoutMs: 8000, maxRedirects: 3, readBody: true, maxBytes: 500_000, standardPortsOnly: true });
  // 4xx: the site publishes no rules. Unreachable or 5xx: don't crawl until it can be read.
  if (!res.ok) return res.status >= 400 && res.status < 500 ? { allowed: true, reason: "no robots.txt" } : { allowed: false, reason: `robots.txt could not be read (${res.status || res.error?.kind}); not crawling until it can` };
  return { allowed: robotsAllows(res.body ?? "", u.pathname + u.search) };
}

// ── Actor input ──────────────────────────────────────────────────────────

/**
 * Runs inside the crawled page (browser context). Extraction priority: JSON-LD → semantic
 * HTML → OpenGraph/meta. Returns null on non-review pages; never fills a missing field.
 */
export const PAGE_FUNCTION = `async function pageFunction(context) {
  const { request, customData } = context;
  const url = request.loadedUrl || request.url;
  const patterns = (customData && customData.reviewPatterns) || [];
  if (!patterns.some((p) => new RegExp(p).test(url))) return null;
  const meta = (sel) => { const el = document.querySelector(sel); return el ? (el.getAttribute("content") || el.getAttribute("href") || "").trim() || null : null; };
  const text = (el) => (el ? el.textContent.replace(/\\s+/g, " ").trim() : null);
  const nodes = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { const j = JSON.parse(s.textContent); for (const n of [].concat(j)) { nodes.push(n); if (n && n["@graph"]) nodes.push(...n["@graph"]); } } catch (e) {}
  }
  const typeOf = (n) => [].concat((n && n["@type"]) || []);
  const find = (...types) => nodes.find((n) => typeOf(n).some((t) => types.includes(t)));
  const review = find("Review", "CriticReview");
  const article = find("NewsArticle", "Article", "BlogPosting", "ReportageNewsArticle", "TechArticle") || review;
  const name = (v) => (v == null ? null : typeof v === "string" ? v : Array.isArray(v) ? name(v[0]) : v.name || null);
  const item = (review && review.itemReviewed) || find("Product") || null;
  const offer = item && item.offers ? [].concat(item.offers)[0] : null;
  const root = document.querySelector("article") || document.querySelector("main") || document.body;
  const paragraphs = [...root.querySelectorAll("p")].map(text).filter((p) => p && p.length > 40);
  const timeEl = root.querySelector("time[datetime]");
  const rating = review && review.reviewRating ? review.reviewRating : null;
  return {
    m4b: 1,
    url,
    canonicalUrl: meta('link[rel="canonical"]') || meta('meta[property="og:url"]') || url,
    title: (article && (article.headline || article.name)) || meta('meta[property="og:title"]') || text(document.querySelector("h1")),
    author: name(article && article.author) || meta('meta[name="author"]'),
    publisher: name(article && article.publisher) || meta('meta[property="og:site_name"]'),
    datePublished: (article && article.datePublished) || meta('meta[property="article:published_time"]') || (timeEl && timeEl.getAttribute("datetime")),
    dateModified: (article && article.dateModified) || meta('meta[property="article:modified_time"]'),
    excerpt: meta('meta[name="description"]') || meta('meta[property="og:description"]') || (article && article.description) || null,
    body: paragraphs.join("\\n\\n").slice(0, 60000) || null,
    rating: rating && rating.ratingValue != null ? Number(rating.ratingValue) : null,
    ratingScale: rating && rating.bestRating != null ? Number(rating.bestRating) : null,
    productName: name(item),
    brand: item ? name(item.brand) : null,
    model: item ? item.model || null : null,
    sku: item ? item.sku || null : null,
    mpn: item ? item.mpn || null : null,
    gtin: item ? item.gtin13 || item.gtin12 || item.gtin || null : null,
    price: offer && offer.price != null ? String(offer.price) : null,
    currency: offer ? offer.priceCurrency || null : null,
    image: meta('meta[property="og:image"]'),
    lang: document.documentElement.lang || null,
    extractedFrom: { jsonLd: Boolean(review || article), review: Boolean(review), product: Boolean(item) },
  };
}`;

export function buildActorInput(source: Pick<ReviewSource, "slug" | "startUrls" | "reviewUrlPatterns" | "maxPagesPerRun">) {
  return {
    startUrls: source.startUrls.map((url) => ({ url })),
    linkSelector: "a[href]",
    // Only review pages are followed from the listing pages (depth 1). No proxy rotation, no login.
    globs: source.reviewUrlPatterns.map((glob) => ({ glob })),
    maxCrawlingDepth: 1,
    maxPagesPerCrawl: Math.max(1, source.maxPagesPerRun + source.startUrls.length),
    maxConcurrency: 2,
    respectRobotsTxtFile: true,
    injectJQuery: false,
    proxyConfiguration: { useApifyProxy: false },
    pageFunction: PAGE_FUNCTION,
    customData: { source: source.slug, reviewPatterns: source.reviewUrlPatterns.map(globToRegex) },
  };
}

// ── Item mapping (strict) ────────────────────────────────────────────────

export type ApifyItem = Record<string, unknown>;
export type MappedItem = { ok: true; raw: Record<string, unknown> } | { ok: false; code: "SOURCE_NOT_ALLOWED" | "APIFY_RESPONSE_INVALID"; reason: string; url?: string };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Maps one dataset item to the Content-API shape validateContentItem understands. Only fields
 * the page actually stated are passed on; images from the source are never marked licensed, so
 * they are not shown publicly (Pexels or our placeholder is used instead).
 */
export function mapApifyItem(item: ApifyItem, source: Pick<ReviewSource, "slug" | "name" | "allowedDomains" | "categoryHint">): MappedItem {
  if (!item || typeof item !== "object" || item.m4b !== 1) return { ok: false, code: "APIFY_RESPONSE_INVALID", reason: "item was not produced by the Made4Buyers page function" };
  const pageUrl = str(item.url);
  const canonical = normalizeUrl(str(item.canonicalUrl) ?? pageUrl ?? "") ?? (pageUrl ? normalizeUrl(pageUrl) : null);
  if (!pageUrl || !canonical) return { ok: false, code: "APIFY_RESPONSE_INVALID", reason: "item has no valid URL" };
  if (!hostAllowed(pageUrl, source.allowedDomains) || !hostAllowed(canonical, source.allowedDomains)) {
    return { ok: false, code: "SOURCE_NOT_ALLOWED", reason: `${new URL(canonical).hostname} is not an allowed domain for ${source.name}`, url: canonical };
  }
  const rating = num(item.rating);
  const scale = num(item.ratingScale);
  return {
    ok: true,
    raw: {
      id: canonical,
      title: str(item.title),
      body: str(item.body),
      summary: str(item.excerpt),
      url: canonical,
      canonicalUrl: canonical,
      publishedAt: str(item.datePublished),
      author: str(item.author),
      publisher: str(item.publisher) ?? source.name,
      // A rating only counts when the page published both a value and its scale.
      ...(rating !== undefined && scale !== undefined && scale > 0 ? { rating, ratingScale: scale } : {}),
      productName: str(item.productName),
      brand: str(item.brand),
      modelNumber: str(item.model) ?? str(item.mpn) ?? str(item.sku),
      price: str(item.price),
      currency: str(item.currency),
      imageUrl: str(item.image),
      imageLicenseVerified: false,
      category: source.categoryHint ?? undefined,
      contentKind: "REVIEW",
      sourceMeta: { scraper: "apify/web-scraper", source: source.slug, dateModified: str(item.dateModified) ?? null, gtin: str(item.gtin) ?? null, extractedFrom: item.extractedFrom ?? null },
    },
  };
}

// ── Apify API ────────────────────────────────────────────────────────────

type ApifyRunData = { id: string; status: string; defaultDatasetId?: string; finishedAt?: string | null; statusMessage?: string | null };

async function apifyRequest<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
  const token = config.apify.token();
  if (!token) throw new PipelineError("APIFY_NOT_CONFIGURED", "APIFY_API_TOKEN is not configured (BLOCKED_BY_ENVIRONMENT)");
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
    let err: { type?: string; message?: string; data?: { approvalUrl?: string } } = {};
    try {
      err = (JSON.parse(res.body ?? "") as { error?: typeof err }).error ?? {};
    } catch {
      /* non-JSON error */
    }
    // The account owner must approve the actor's permissions once in the Apify console.
    if (err.type === "full-permission-actor-not-approved") throw new PipelineError("APIFY_ACTOR_NOT_APPROVED", `Approve the actor's permissions in Apify first: ${err.data?.approvalUrl ?? "Apify console → Actors"}`, { status: res.status }, false);
    throw new PipelineError("APIFY_AUTH_FAILED", `Apify rejected the request (HTTP ${res.status}${err.type ? `, ${err.type}` : ""})`, { status: res.status }, false);
  }
  if (!res.ok) throw new PipelineError("APIFY_RUN_FAILED", `Apify request failed: ${res.error ? res.error.kind : `HTTP ${res.status}`}`, { status: res.status }, true);
  try {
    return JSON.parse(res.body ?? "") as T;
  } catch {
    throw new PipelineError("APIFY_RESPONSE_INVALID", "Apify returned invalid JSON");
  }
}

const actorPath = () => `/acts/${encodeURIComponent(config.apify.actorId().replace("/", "~"))}`;

export async function apifyAccount() {
  const { data } = await apifyRequest<{ data?: { username?: string; plan?: { id?: string } } }>("/users/me");
  return { username: data?.username ?? null, plan: data?.plan?.id ?? null };
}

/** Top-level input fields the actor's current build accepts (used by go-live checks to catch drift). */
export async function actorInputFields(): Promise<string[] | null> {
  try {
    const { data } = await apifyRequest<{ data?: { inputSchema?: string | { properties?: Record<string, unknown> } } }>(`${actorPath()}/builds/default`);
    const schema = typeof data?.inputSchema === "string" ? (JSON.parse(data.inputSchema) as { properties?: Record<string, unknown> }) : data?.inputSchema;
    return schema?.properties ? Object.keys(schema.properties) : null;
  } catch {
    return null;
  }
}

// ── Jobs ─────────────────────────────────────────────────────────────────

const ACTIVE = ["READY", "RUNNING"];
const FAILED = ["FAILED", "ABORTED", "TIMED-OUT", "TIMING-OUT", "ABORTING"];

export async function startSourceRun(source: ReviewSource, trigger: string): Promise<{ status: string; runId?: string; reason?: string }> {
  const active = await db.apifyRun.findFirst({ where: { sourceId: source.id, status: { in: [...ACTIVE, "SUCCEEDED", "COLLECTING"] } } });
  if (active) return { status: "SKIPPED", reason: `run ${active.apifyRunId} is still ${active.status}` };
  for (const url of source.startUrls) {
    const robots = await checkRobots(url);
    if (!robots.allowed) {
      const reason = robots.reason ?? `robots.txt disallows ${url}`;
      await recordFailure({ stage: "CONTENT_FETCH", code: "ROBOTS_DISALLOWED", message: reason, entityType: "review_source", entityId: source.id });
      return { status: "ROBOTS_DISALLOWED", reason };
    }
  }
  try {
    const q = new URLSearchParams({ timeout: String(config.apify.runTimeoutSecs()), memory: String(config.apify.memoryMb()) });
    const { data } = await apifyRequest<{ data?: ApifyRunData }>(`${actorPath()}/runs?${q}`, { method: "POST", body: buildActorInput(source) });
    if (!data?.id) throw new PipelineError("APIFY_RESPONSE_INVALID", "Apify did not return a run id");
    await db.apifyRun.create({ data: { sourceId: source.id, apifyRunId: data.id, datasetId: data.defaultDatasetId ?? null, status: data.status ?? "READY", trigger } });
    await db.reviewSource.update({ where: { id: source.id }, data: { lastRunAt: new Date() } });
    await resolveFailures({ stage: "CONTENT_FETCH", entityType: "review_source", entityId: source.id });
    log.info("apify run started", { stage: "CONTENT_FETCH", source: source.slug, runId: data.id });
    return { status: "STARTED", runId: data.id };
  } catch (error) {
    const e = error instanceof PipelineError ? error : new PipelineError("APIFY_RUN_FAILED", String(error));
    await recordFailure({ stage: "CONTENT_FETCH", code: e.code, message: e.message, entityType: "review_source", entityId: source.id, retryable: e.retryable });
    return { status: e.code, reason: e.message };
  }
}

/** Starts runs for enabled sources whose crawl interval has elapsed. */
export async function runScrapeSources(trigger: string) {
  if (!apifyConfigured()) return { status: "BLOCKED_BY_ENVIRONMENT", reason: "APIFY_API_TOKEN not configured", started: 0 };
  const sources = await db.reviewSource.findMany({ where: { enabled: true }, orderBy: { lastRunAt: { sort: "asc", nulls: "first" } } });
  const now = Date.now();
  const results: Array<{ source: string; status: string; reason?: string }> = [];
  for (const s of sources) {
    if (s.lastRunAt && now - s.lastRunAt.getTime() < s.crawlFrequencyHours * 3_600_000) continue;
    const r = await startSourceRun(s, trigger);
    results.push({ source: s.slug, status: r.status, reason: r.reason });
  }
  return { status: "OK", started: results.filter((r) => r.status === "STARTED").length, results };
}

async function refreshRun(run: ApifyRun): Promise<ApifyRun> {
  const { data } = await apifyRequest<{ data?: ApifyRunData }>(`/actor-runs/${encodeURIComponent(run.apifyRunId)}`);
  if (!data?.status) throw new PipelineError("APIFY_RESPONSE_INVALID", "Apify run status missing");
  return db.apifyRun.update({ where: { id: run.id }, data: { status: data.status, datasetId: data.defaultDatasetId ?? run.datasetId, finishedAt: data.finishedAt ? new Date(data.finishedAt) : run.finishedAt, error: FAILED.includes(data.status) ? (data.statusMessage ?? data.status).slice(0, 500) : null } });
}

export type CollectResult = { runId: string; status: string; items: number; accepted: number; rejected: number; rejections: Record<string, number>; ingest?: Pick<IngestSummary, "runId" | "normalized" | "duplicates" | "failedNormalization" | "queued"> };

/** Fetches a finished run's dataset once (claimed atomically) and ingests valid items. */
export async function collectRun(run: ApifyRun, trigger: string): Promise<CollectResult> {
  const claimed = await db.apifyRun.updateMany({ where: { id: run.id, status: "SUCCEEDED" }, data: { status: "COLLECTING" } });
  if (!claimed.count) return { runId: run.apifyRunId, status: "ALREADY_COLLECTED", items: 0, accepted: 0, rejected: 0, rejections: {} };
  const source = await db.reviewSource.findUniqueOrThrow({ where: { id: run.sourceId } });
  try {
    if (!run.datasetId) throw new PipelineError("APIFY_RESPONSE_INVALID", "Run has no dataset");
    const q = new URLSearchParams({ clean: "true", format: "json", limit: String(config.apify.maxItemsPerCollect()) });
    const items = await apifyRequest<unknown>(`/datasets/${encodeURIComponent(run.datasetId)}/items?${q}`);
    if (!Array.isArray(items)) throw new PipelineError("APIFY_RESPONSE_INVALID", "Dataset items response is not an array");
    const pages = items.filter((i): i is ApifyItem => Boolean(i) && typeof i === "object" && (i as ApifyItem).m4b === 1);
    const rejections: Record<string, number> = {};
    const valid: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const item of pages) {
      const m = mapApifyItem(item, source);
      if (m.ok && seen.has(String(m.raw.id))) {
        // Same page crawled twice in one run (e.g. with tracking parameters): keep the first.
        rejections.DUPLICATE_REVIEW = (rejections.DUPLICATE_REVIEW ?? 0) + 1;
      } else if (m.ok) {
        seen.add(String(m.raw.id));
        valid.push(m.raw);
      } else {
        rejections[m.code] = (rejections[m.code] ?? 0) + 1;
        await recordFailure({ stage: "VALIDATION", code: m.code, message: `${m.reason}${m.url ? ` (${m.url})` : ""}`, entityType: "apify_run", entityId: run.id, retryable: false });
      }
    }
    if (!pages.length) {
      await recordFailure({ stage: "CONTENT_FETCH", code: "APIFY_EMPTY_DATASET", message: `Run ${run.apifyRunId} for ${source.name} produced no review pages (${items.length} raw items). Check the start URLs and review URL patterns.`, entityType: "review_source", entityId: source.id });
    }
    const ingest = valid.length ? await runIngestion({ trigger: `apify:${trigger}`, items: valid, source: sourceKey(source.slug) }) : undefined;
    const rejected = Object.values(rejections).reduce((n, x) => n + x, 0) + (ingest?.failedNormalization ?? 0);
    await db.apifyRun.update({ where: { id: run.id }, data: { status: "COLLECTED", collectedAt: new Date(), itemCount: pages.length, accepted: ingest ? ingest.normalized : 0, rejected, ingestRunId: ingest?.runId ?? null } });
    log.info("apify run collected", { stage: "CONTENT_FETCH", source: source.slug, runId: run.apifyRunId, items: pages.length, valid: valid.length });
    return {
      runId: run.apifyRunId,
      status: "COLLECTED",
      items: pages.length,
      accepted: ingest?.normalized ?? 0,
      rejected,
      rejections: { ...rejections, ...(ingest?.reasons ?? {}) },
      ingest: ingest && { runId: ingest.runId, normalized: ingest.normalized, duplicates: ingest.duplicates, failedNormalization: ingest.failedNormalization, queued: ingest.queued },
    };
  } catch (error) {
    const e = error instanceof PipelineError ? error : new PipelineError("APIFY_RUN_FAILED", String(error));
    // Release the claim so the next collect retries (ingestion itself is idempotent per URL).
    await db.apifyRun.update({ where: { id: run.id }, data: { status: e.retryable ? "SUCCEEDED" : "COLLECT_FAILED", error: e.message.slice(0, 500) } });
    await recordFailure({ stage: "CONTENT_FETCH", code: e.code, message: e.message, entityType: "apify_run", entityId: run.id, retryable: e.retryable });
    return { runId: run.apifyRunId, status: e.code, items: 0, accepted: 0, rejected: 0, rejections: { [e.code]: 1 } };
  }
}

/** Polls unfinished runs and collects finished ones. */
export async function runCollectScrapes(trigger: string) {
  if (!apifyConfigured()) return { status: "BLOCKED_BY_ENVIRONMENT", reason: "APIFY_API_TOKEN not configured", collected: 0 };
  const runs = await db.apifyRun.findMany({ where: { status: { in: [...ACTIVE, "SUCCEEDED"] } }, orderBy: { startedAt: "asc" }, take: 20 });
  const results: Array<CollectResult | { runId: string; status: string; error?: string }> = [];
  for (const r of runs) {
    try {
      const fresh = ACTIVE.includes(r.status) ? await refreshRun(r) : r;
      if (fresh.status === "SUCCEEDED") results.push(await collectRun(fresh, trigger));
      else if (FAILED.includes(fresh.status)) {
        await recordFailure({ stage: "CONTENT_FETCH", code: "APIFY_RUN_FAILED", message: `Apify run ${fresh.apifyRunId} ended ${fresh.status}: ${fresh.error ?? ""}`, entityType: "apify_run", entityId: fresh.id });
        results.push({ runId: fresh.apifyRunId, status: fresh.status, error: fresh.error ?? undefined });
      } else results.push({ runId: fresh.apifyRunId, status: fresh.status });
    } catch (error) {
      const e = error instanceof PipelineError ? error : new PipelineError("APIFY_RUN_FAILED", String(error));
      await recordFailure({ stage: "CONTENT_FETCH", code: e.code, message: e.message, entityType: "apify_run", entityId: r.id, retryable: e.retryable });
      results.push({ runId: r.apifyRunId, status: e.code, error: e.message });
    }
  }
  return { status: "OK", checked: runs.length, collected: results.filter((r) => r.status === "COLLECTED").length, results };
}
