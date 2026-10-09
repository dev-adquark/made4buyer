import type { ApifyRun, ReviewSource } from "@prisma/client";
import { config } from "@/lib/config";
import { guardedApiCall, onceInInvocation } from "@/lib/ops/api-guard";
import { db } from "@/lib/db";
import { PipelineError } from "@/lib/errors";
import { log } from "@/lib/log";
import { safeFetch } from "@/lib/net/safe-fetch";
import { LockHeldError, withLock } from "@/lib/jobs/lock";
import { recordFailure, resolveFailures } from "./failures";
import { recordReviewRunUsage, reviewScrapeBudget } from "./review-budget";
import { runIngestion, type IngestSummary } from "./ingest";
import { recordSourceFailure, recordSourceRun } from "./source-health";

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
  // Every "User-agent: *" group applies (some sites split them, e.g. three separate * groups).
  const rules = groups.filter((g) => g.agents.includes("*")).flatMap((g) => g.rules);
  if (!rules.length) return true;
  let best: { allow: boolean; len: number } | null = null;
  for (const r of rules) {
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

export async function checkRobots(url: string): Promise<{ allowed: boolean; reason?: string }> {
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
  const metas = (sel) => [...document.querySelectorAll(sel)].map((el) => (el.getAttribute("content") || "").trim()).filter(Boolean);
  const text = (el) => (el ? el.textContent.replace(/\\s+/g, " ").trim() : null);
  const abs = (v) => { try { return v ? new URL(v, url).toString() : null; } catch (e) { return null; } };
  // Every JSON-LD node, however deeply nested (@graph, Product.review, mainEntity …).
  const nodes = [];
  const walk = (v, depth) => {
    if (!v || typeof v !== "object" || depth > 8) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (v["@type"]) nodes.push(v);
    for (const k of Object.keys(v)) if (k !== "@context") walk(v[k], depth + 1);
  };
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) { try { walk(JSON.parse(s.textContent), 0); } catch (e) {} }
  const typeOf = (n) => [].concat((n && n["@type"]) || []).map((t) => String(t).toLowerCase());
  const find = (...types) => nodes.find((n) => typeOf(n).some((t) => types.includes(t)));
  const findAll = (...types) => nodes.filter((n) => typeOf(n).some((t) => types.includes(t)));
  const name = (v) => (v == null ? null : typeof v === "string" ? v.trim() || null : Array.isArray(v) ? name(v[0]) : (v.name && String(v.name).trim()) || null);
  const val = (v) => (v == null || v === "" ? null : v);
  const num = (v) => { const n = Number(v); return v != null && v !== "" && Number.isFinite(n) ? n : null; };
  const review = find("review", "criticreview");
  const products = findAll("product", "softwareapplication");
  const item = (review && review.itemReviewed && typeof review.itemReviewed === "object" ? review.itemReviewed : null)
    || products.find((p) => p.review && [].concat(p.review).includes(review)) || products[0] || null;
  const article = find("newsarticle", "article", "blogposting", "reportagenewsarticle", "techarticle") || review;
  const webPage = find("webpage");
  const offers = item && item.offers ? [].concat(item.offers) : [];
  const offer = offers[0] || null;
  const notes = (v) => (v && v.itemListElement ? [].concat(v.itemListElement) : []).map((e) => name(e) || name(e && e.item)).filter(Boolean).slice(0, 20);
  // Content root: the <article> (or <main>) with the most paragraph text.
  const cands = [...document.querySelectorAll("article"), document.querySelector("main")].filter(Boolean);
  const size = (el) => [...el.querySelectorAll("p")].reduce((n, p) => n + (p.textContent || "").length, 0);
  const root = cands.sort((a, b) => size(b) - size(a))[0] || document.body;
  const skip = 'nav, aside, footer, header, form, [role="navigation"], [class*="related"], [class*="newsletter"], [class*="share"], [class*="comment"]';
  const blocks = [];
  for (const el of root.querySelectorAll("h2, h3, h4, p, li, table, blockquote, figcaption")) {
    if (el.closest(skip)) continue;
    const tag = el.tagName.toLowerCase();
    if (tag !== "li" && tag !== "table" && el.parentElement && el.parentElement.closest("li, table, blockquote")) continue;
    if (tag === "table") {
      const rows = [...el.querySelectorAll("tr")].map((tr) => [...tr.querySelectorAll("th, td")].map(text).join(" | ")).filter(Boolean);
      if (rows.length) blocks.push(rows.join("\\n"));
      continue;
    }
    const t = text(el);
    if (!t) continue;
    if (tag === "h2" || tag === "h3" || tag === "h4") blocks.push("## " + t);
    else if (tag === "li") { if (!el.parentElement || !el.parentElement.closest(skip)) blocks.push("• " + t); }
    else if (tag === "p" && t.length < 25) continue;
    else blocks.push(t);
  }
  let body = blocks.join("\\n\\n");
  const ldBody = article && typeof article.articleBody === "string" ? article.articleBody.trim() : "";
  if (ldBody.length > body.length * 1.5 && body.length < 1500) body = ldBody;
  const timeEl = root.querySelector("time[datetime]");
  const rating = review && review.reviewRating ? review.reviewRating : null;
  const agg = item && item.aggregateRating ? item.aggregateRating : null;
  const crumbs = find("breadcrumblist");
  const faq = find("faqpage");
  const tags = [...new Set([...metas('meta[property="article:tag"]'), ...[].concat((article && article.keywords) || []).flatMap((k) => String(k).split(",")), ...(meta('meta[name="keywords"]') || "").split(",")].map((t) => t.trim()).filter(Boolean))].slice(0, 30);
  const images = [];
  for (const img of root.querySelectorAll("figure img, img")) {
    if (img.closest(skip) || images.length >= 12) continue;
    const src = abs(img.currentSrc || img.getAttribute("src"));
    if (!src || src.startsWith("data:")) continue;
    const fig = img.closest("figure");
    const w = num(img.getAttribute("width")), h = num(img.getAttribute("height"));
    if ((w && w < 200) || (h && h < 150) || /logo|avatar|icon|banner|promo/i.test(src)) continue;
    images.push({ url: src, alt: img.getAttribute("alt") || null, caption: fig ? text(fig.querySelector("figcaption")) : null, width: num(img.getAttribute("width")), height: num(img.getAttribute("height")) });
  }
  return {
    m4b: 1,
    url,
    canonicalUrl: meta('link[rel="canonical"]') || meta('meta[property="og:url"]') || url,
    title: (article && (article.headline || article.name)) || meta('meta[property="og:title"]') || text(document.querySelector("h1")),
    author: name(article && article.author) || name(review && review.author) || meta('meta[name="author"]'),
    authorUrl: abs((article && article.author && [].concat(article.author)[0] && [].concat(article.author)[0].url) || (review && review.author && [].concat(review.author)[0] && [].concat(review.author)[0].url) || null),
    publisher: name(article && article.publisher) || meta('meta[property="og:site_name"]'),
    datePublished: val(article && article.datePublished) || val(review && review.datePublished) || meta('meta[property="article:published_time"]') || meta('meta[property="article:first_published_time"]') || (timeEl && timeEl.getAttribute("datetime")),
    dateModified: val(article && article.dateModified) || val(review && review.dateModified) || val(webPage && webPage.dateModified) || meta('meta[property="article:modified_time"]') || meta('meta[property="og:updated_time"]'),
    excerpt: meta('meta[name="description"]') || meta('meta[property="og:description"]') || (article && article.description) || null,
    body: body.slice(0, 60000) || null,
    rating: rating ? num(rating.ratingValue) : null,
    ratingScale: rating ? num(rating.bestRating) : null,
    ratingWorst: rating ? num(rating.worstRating) : null,
    aggregateRating: agg ? { value: num(agg.ratingValue), count: num(agg.reviewCount) || num(agg.ratingCount), best: num(agg.bestRating) } : null,
    pros: review ? notes(review.positiveNotes) : [],
    cons: review ? notes(review.negativeNotes) : [],
    productName: name(item) ? name(item).replace(/\s+review$/i, "").trim() || null : null,
    brand: item ? name(item.brand) : null,
    model: item ? val(item.model) : null,
    sku: item ? val(item.sku) : null,
    mpn: item ? val(item.mpn) : null,
    gtin: item ? val(item.gtin13) || val(item.gtin12) || val(item.gtin14) || val(item.gtin8) || val(item.gtin) : null,
    price: offer && val(offer.price) != null ? String(offer.price) : offer && val(offer.lowPrice) != null ? String(offer.lowPrice) : null,
    currency: offer ? val(offer.priceCurrency) : null,
    availability: offer && offer.availability ? String(offer.availability).replace(/^https?:\\/\\/schema\\.org\\//, "") : null,
    offerUrl: offer ? abs(val(offer.url)) : null,
    image: meta('meta[property="og:image"]'),
    imageAlt: meta('meta[property="og:image:alt"]'),
    images,
    tags,
    section: (article && name(article.articleSection)) || meta('meta[property="article:section"]'),
    breadcrumbs: crumbs && crumbs.itemListElement ? [].concat(crumbs.itemListElement).map((e) => ({ position: num(e.position), name: name(e) || name(e.item), url: abs(e.item && typeof e.item === "object" ? e.item["@id"] || e.item.url : e.item) })).filter((c) => c.name) : [],
    faq: faq && faq.mainEntity ? [].concat(faq.mainEntity).map((q) => ({ q: name(q), a: q.acceptedAnswer ? text(new DOMParser().parseFromString(String(q.acceptedAnswer.text || ""), "text/html").body) : null })).filter((x) => x.q && x.a).slice(0, 20) : [],
    wordCount: article ? num(article.wordCount) : null,
    lang: document.documentElement.lang || null,
    extractedFrom: { jsonLd: Boolean(review || article), review: Boolean(review), product: Boolean(item), structuredBody: blocks.length > 0 },
  };
}`;

export function buildActorInput(source: Pick<ReviewSource, "slug" | "startUrls" | "reviewUrlPatterns" | "maxPagesPerRun">) {
  return {
    startUrls: source.startUrls.map((url) => ({ url })),
    linkSelector: "a[href]",
    // Only review pages are followed from the listing pages (depth 1). No login.
    globs: source.reviewUrlPatterns.map((glob) => ({ glob })),
    maxCrawlingDepth: 1,
    maxPagesPerCrawl: Math.max(1, source.maxPagesPerRun + source.startUrls.length),
    maxConcurrency: 2,
    respectRobotsTxtFile: true,
    injectJQuery: false,
    // Web Scraper requires a proxy setting. Apify's default datacenter pool is its normal egress:
    // no residential IPs and no block evasion. robots.txt and the source's terms still decide.
    proxyConfiguration: { useApifyProxy: true },
    pageFunction: PAGE_FUNCTION,
    customData: { source: source.slug, reviewPatterns: source.reviewUrlPatterns.map(globToRegex) },
  };
}

// ── Item mapping (strict) ────────────────────────────────────────────────

export type ApifyItem = Record<string, unknown>;
export type MappedItem = { ok: true; raw: Record<string, unknown> } | { ok: false; code: "SOURCE_NOT_ALLOWED" | "APIFY_RESPONSE_INVALID"; reason: string; url?: string };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const arr = (v: unknown) => (Array.isArray(v) && v.length ? v : undefined);

/** Everything else the page stated that Made4Buyers can use, without empty keys. Never filled in. */
export function sourceDataOf(item: ApifyItem): Record<string, unknown> | undefined {
  const strings = (v: unknown) => arr(v)?.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
  const ids = Object.fromEntries(Object.entries({ sku: str(item.sku), mpn: str(item.mpn), gtin: str(item.gtin), model: str(item.model) }).filter(([, v]) => v));
  const rating = num(item.rating) !== undefined ? { value: num(item.rating), best: num(item.ratingScale) ?? null, worst: num(item.ratingWorst) ?? null } : undefined;
  const agg = item.aggregateRating && typeof item.aggregateRating === "object" ? (item.aggregateRating as Record<string, unknown>) : undefined;
  const data: Record<string, unknown> = {
    pros: strings(item.pros),
    cons: strings(item.cons),
    breadcrumbs: arr(item.breadcrumbs),
    faq: arr(item.faq),
    images: arr(item.images),
    tags: strings(item.tags),
    section: str(item.section),
    authorUrl: str(item.authorUrl),
    identifiers: Object.keys(ids).length ? ids : undefined,
    rating,
    aggregateRating: agg && num(agg.value) !== undefined ? agg : undefined,
    wordCount: num(item.wordCount),
    lang: str(item.lang),
    imageAlt: str(item.imageAlt),
  };
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  return Object.keys(clean).length ? clean : undefined;
}

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
      updatedAt: str(item.dateModified),
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
      tags: arr(item.tags),
      // The product page the source linked (its offer URL), kept with provenance; never shown as a live price.
      productUrl: (() => {
        const u = str(item.offerUrl);
        return u && /^https?:\/\//i.test(u) && normalizeUrl(u) !== canonical ? u : undefined;
      })(),
      availability: str(item.availability),
      sourceData: sourceDataOf(item),
      contentKind: "REVIEW",
      // The full original item (minus the body, stored above) so a better mapping can be replayed without re-crawling.
      sourceMeta: { scraper: "apify/web-scraper", source: source.slug, dateModified: str(item.dateModified) ?? null, gtin: str(item.gtin) ?? null, extractedFrom: item.extractedFrom ?? null, raw: { ...item, body: undefined } },
    },
  };
}

// ── Apify API ────────────────────────────────────────────────────────────

type ApifyRunData = { id: string; status: string; defaultDatasetId?: string; finishedAt?: string | null; statusMessage?: string | null; usageTotalUsd?: number | null };

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

/**
 * Starts one review run for a source, under the review-scraping spending cap: the budget check, the
 * Apify call and the run's record happen under one lock, so concurrent or repeated triggers (every
 * scheduler, Admin "Run now") cannot each pass the check before any of them is recorded. Fail closed:
 * a budget that cannot be read, or a lock held by another start, starts nothing.
 */
export async function startSourceRun(source: ReviewSource, trigger: string): Promise<{ status: string; runId?: string; reason?: string }> {
  try {
    return await withLock(REVIEW_BUDGET_LOCK, 2 * 60_000, () => startSourceRunUnderCap(source, trigger));
  } catch (error) {
    if (error instanceof LockHeldError) {
      log.warn("api call skipped", { stage: "API_GUARD", api: "apify", unit: `start:source:${source.id}`, trigger, code: "REVIEW_BUDGET_BUSY", reason: "another review run is being started; this trigger starts nothing" });
      return { status: "SKIPPED", reason: "REVIEW_BUDGET_BUSY: another review run is being started" };
    }
    log.warn("api call skipped", { stage: "API_GUARD", api: "apify", unit: `start:source:${source.id}`, trigger, code: "REVIEW_BUDGET_UNVERIFIED", reason: String(error).slice(0, 200) });
    return { status: "BUDGET_UNVERIFIED", reason: `review-scraping budget could not be verified: ${String(error).slice(0, 200)}` };
  }
}

const REVIEW_BUDGET_LOCK = "apify-review-budget";

async function startSourceRunUnderCap(source: ReviewSource, trigger: string): Promise<{ status: string; runId?: string; reason?: string }> {
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
    // One start per source per due slot: the basis is the source's previous run, so a duplicate trigger
    // that saw the same previous run finds the marker and does not start (or bill) a second run.
    const last = await db.apifyRun.findFirst({ where: { sourceId: source.id }, orderBy: { startedAt: "desc" }, select: { apifyRunId: true } });
    const guarded = await guardedApiCall({
      api: "apify",
      unit: `start:source:${source.id}`,
      idempotencyBasis: last?.apifyRunId ?? "first",
      trigger,
      config: [() => (apifyConfigured() ? null : { code: "APIFY_NOT_CONFIGURED", reason: "APIFY_API_TOKEN not configured" })],
      params: () => (source.startUrls.length && source.startUrls.every((u) => /^https?:\/\//i.test(u)) ? null : { code: "INVALID_PARAMS", reason: `source ${source.slug} has no valid start URLs` }),
      budget: [
        async () => {
          let b: Awaited<ReturnType<typeof reviewScrapeBudget>>;
          try {
            b = await reviewScrapeBudget();
          } catch (error) {
            // Fail closed: no verified spend, no paid run.
            return { code: "BUDGET_UNVERIFIED", reason: `review-scraping spend could not be read: ${String(error).slice(0, 160)}` };
          }
          return b.allowed ? null : { code: "BUDGET_EXHAUSTED", reason: `review-scraping budget would be exceeded: spent ≈$${b.spentUsd.toFixed(2)} (${b.unknownRuns} run(s) at ≈$${b.perRunUsd.toFixed(2)} not yet reported) + this run ≈$${b.perRunUsd.toFixed(2)} of $${b.budgetUsd.toFixed(2)} (REVIEW_SCRAPE_MONTHLY_BUDGET_USD)` };
        },
      ],
      call: () => apifyRequest<{ data?: ApifyRunData }>(`${actorPath()}/runs?${q}`, { method: "POST", body: buildActorInput(source) }),
      validate: (r) => (r?.data?.id ? null : { code: "APIFY_RESPONSE_INVALID", reason: "Apify did not return a run id" }),
    });
    if (guarded.status === "SKIPPED") return { status: guarded.code === "BUDGET_EXHAUSTED" || guarded.code === "BUDGET_UNVERIFIED" ? guarded.code : "SKIPPED", reason: `${guarded.code}: ${guarded.reason}` };
    if (guarded.status === "INVALID_RESPONSE") throw new PipelineError("APIFY_RESPONSE_INVALID", guarded.reason);
    const { data } = guarded.value;
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
  // Healthy, high-priority sources first; a source paused by source health waits out its backoff.
  const sources = await db.reviewSource.findMany({ where: { enabled: true }, orderBy: [{ priority: "desc" }, { lastRunAt: { sort: "asc", nulls: "first" } }] });
  const now = Date.now();
  const results: Array<{ source: string; status: string; reason?: string }> = [];
  for (const s of sources) {
    if (s.pausedUntil && s.pausedUntil.getTime() > now) {
      results.push({ source: s.slug, status: "PAUSED", reason: s.healthNote ?? `paused until ${s.pausedUntil.toISOString()}` });
      continue;
    }
    // 30 minutes of slack: a daily cron lands a few seconds short of 24 h, which must not skip a day.
    if (s.lastRunAt && now - s.lastRunAt.getTime() < s.crawlFrequencyHours * 3_600_000 - 30 * 60_000) continue;
    const r = await startSourceRun(s, trigger);
    results.push({ source: s.slug, status: r.status, reason: r.reason });
  }
  return { status: "OK", started: results.filter((r) => r.status === "STARTED").length, results };
}

async function refreshRun(run: ApifyRun): Promise<ApifyRun> {
  // One status read per run per job invocation (reused by every later step of the same invocation).
  const { data } = await onceInInvocation(`apify:status:${run.apifyRunId}`, () => apifyRequest<{ data?: ApifyRunData }>(`/actor-runs/${encodeURIComponent(run.apifyRunId)}`));
  if (!data?.status) throw new PipelineError("APIFY_RESPONSE_INVALID", "Apify run status missing");
  // What the run cost so far (final once it has ended): counted against the review-scraping cap.
  await recordReviewRunUsage(run.apifyRunId, data.usageTotalUsd, run.startedAt);
  return db.apifyRun.update({ where: { id: run.id }, data: { status: data.status, datasetId: data.defaultDatasetId ?? run.datasetId, finishedAt: data.finishedAt ? new Date(data.finishedAt) : run.finishedAt, error: FAILED.includes(data.status) ? (data.statusMessage ?? data.status).slice(0, 500) : null } });
}

export type CollectResult = { runId: string; status: string; items: number; accepted: number; rejected: number; rejections: Record<string, number>; ingest?: Pick<IngestSummary, "runId" | "normalized" | "duplicates" | "failedNormalization" | "queued"> };

/** Fetches a finished run's dataset once (claimed atomically) and ingests valid items. */
export async function collectRun(run: ApifyRun, trigger: string): Promise<CollectResult> {
  // Write readiness before the download: the items can only be saved when ingestion is free. Otherwise
  // the dataset would be read, fail to save, and be read again at the next collect.
  const ingestLock = await db.jobLock.findUnique({ where: { name: "ingestion" } }).catch(() => null);
  if (ingestLock && ingestLock.expiresAt > new Date()) {
    log.warn("api call skipped", { stage: "API_GUARD", api: "apify", unit: `dataset:${run.apifyRunId}`, trigger, code: "WRITE_NOT_READY", reason: "ingestion is running (lock held); the dataset is read at the next collect" });
    return { runId: run.apifyRunId, status: "SKIPPED", items: 0, accepted: 0, rejected: 0, rejections: { WRITE_NOT_READY: 1 } };
  }
  const claimed = await db.apifyRun.updateMany({ where: { id: run.id, status: "SUCCEEDED" }, data: { status: "COLLECTING" } });
  if (!claimed.count) return { runId: run.apifyRunId, status: "ALREADY_COLLECTED", items: 0, accepted: 0, rejected: 0, rejections: {} };
  const source = await db.reviewSource.findUniqueOrThrow({ where: { id: run.sourceId } });
  try {
    if (!run.datasetId) throw new PipelineError("APIFY_RESPONSE_INVALID", "Run has no dataset");
    const q = new URLSearchParams({ clean: "true", format: "json", limit: String(config.apify.maxItemsPerCollect()) });
    const datasetId = run.datasetId;
    const got = await guardedApiCall({
      api: "apify",
      unit: `dataset:${run.apifyRunId}`,
      trigger,
      config: [() => (apifyConfigured() ? null : { code: "APIFY_NOT_CONFIGURED", reason: "APIFY_API_TOKEN not configured" })],
      call: () => onceInInvocation(`apify:dataset:${datasetId}`, () => apifyRequest<unknown>(`/datasets/${encodeURIComponent(datasetId)}/items?${q}`)),
      validate: (r) => (Array.isArray(r) ? null : { code: "APIFY_RESPONSE_INVALID", reason: "Dataset items response is not an array" }),
    });
    if (got.status === "SKIPPED") throw new PipelineError("APIFY_RUN_FAILED", `${got.code}: ${got.reason}`);
    if (got.status === "INVALID_RESPONSE") throw new PipelineError("APIFY_RESPONSE_INVALID", got.reason);
    const items = got.value as unknown[];
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
    const f = ingest?.freshness;
    const notFresh = f ? f.stale + f.unknown + f.invalidDate : 0;
    const rejected = Object.values(rejections).reduce((n, x) => n + x, 0) + (ingest?.failedNormalization ?? 0) + notFresh;
    await db.apifyRun.update({ where: { id: run.id }, data: { status: "COLLECTED", collectedAt: new Date(), itemCount: pages.length, accepted: ingest ? ingest.normalized : 0, rejected, ingestRunId: ingest?.runId ?? null, freshCount: f?.fresh ?? 0, staleCount: f?.stale ?? 0, unknownFreshnessCount: f ? f.unknown + f.invalidDate : 0 } });
    if (pages.length) await recordSourceRun(source.id, f, new Date(), (rejections.DUPLICATE_REVIEW ?? 0) + (ingest?.duplicates ?? 0));
    else await recordSourceFailure(source.id, "empty dataset");
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
    if (!e.retryable) await recordSourceFailure(source.id, e.code);
    await recordFailure({ stage: "CONTENT_FETCH", code: e.code, message: e.message, entityType: "apify_run", entityId: run.id, retryable: e.retryable });
    return { runId: run.apifyRunId, status: e.code, items: 0, accepted: 0, rejected: 0, rejections: { [e.code]: 1 } };
  }
}

/** Polls unfinished runs and collects finished ones. */
export async function runCollectScrapes(trigger: string) {
  if (!apifyConfigured()) return { status: "BLOCKED_BY_ENVIRONMENT", reason: "APIFY_API_TOKEN not configured", collected: 0 };
  const runs = await db.apifyRun.findMany({ where: { status: { in: [...ACTIVE, "SUCCEEDED"] } }, orderBy: { startedAt: "asc" }, take: 20, include: { source: { select: { enabled: true } } } });
  const results: Array<CollectResult | { runId: string; status: string; error?: string }> = [];
  for (const { source, ...r } of runs) {
    // A source disabled after its run started (e.g. its terms forbid crawling) is never ingested.
    if (!source.enabled) {
      if (ACTIVE.includes(r.status)) await apifyRequest(`/actor-runs/${r.apifyRunId}/abort`, { method: "POST" }).catch(() => undefined);
      await db.apifyRun.update({ where: { id: r.id }, data: { status: "SOURCE_DISABLED", finishedAt: r.finishedAt ?? new Date(), error: "Source was disabled before collection; nothing ingested" } });
      results.push({ runId: r.apifyRunId, status: "SOURCE_DISABLED" });
      continue;
    }
    try {
      const fresh = ACTIVE.includes(r.status) ? await refreshRun(r) : r;
      if (fresh.status === "SUCCEEDED") results.push(await collectRun(fresh, trigger));
      else if (FAILED.includes(fresh.status)) {
        await recordFailure({ stage: "CONTENT_FETCH", code: "APIFY_RUN_FAILED", message: `Apify run ${fresh.apifyRunId} ended ${fresh.status}: ${fresh.error ?? ""}`, entityType: "apify_run", entityId: fresh.id });
        await recordSourceFailure(fresh.sourceId, `run ended ${fresh.status}`);
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
