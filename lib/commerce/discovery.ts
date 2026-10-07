import type { CommerceBrand } from "@prisma/client";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { safeFetch, validateOutboundUrl } from "@/lib/net/safe-fetch";
import { globToRegex, normalizeUrl, robotsAllows } from "@/lib/pipeline/apify";
import { BRAND_LIMITS, onBrandDomain } from "./brands";

/**
 * Cheap, server-side, robots-respecting product URL discovery for one brand. No browser, no
 * Apify cost: it reads the brand's robots.txt and sitemaps and returns the product pages worth
 * handing to the crawler.
 *
 *  1. robots.txt of the official domain is read once. Same rules as `checkRobots` in
 *     lib/pipeline/apify.ts (4xx = the site publishes no rules; unreachable/5xx = do not crawl),
 *     but the body is kept so every candidate URL and its `Sitemap:` lines can be used.
 *  2. Sitemaps come from brand.discoveryUrls (admin-set) or, when empty, from robots.txt
 *     `Sitemap:` lines. Paths are never guessed. Sitemap indexes are followed to their child
 *     sitemaps; `.gz` files are skipped with a reason; at most 10 sitemap files are fetched per
 *     run and each is capped at 5 MB. Sitemaps must be on the brand's own domain (or subdomains)
 *     and allowed by that host's robots.txt. A discovery URL that returns HTML is read as a
 *     listing page (its same-domain links become candidates).
 *  3. Candidates must be on the official domain (exact host), allowed by robots.txt, and match
 *     brand.productUrlPatterns — or, when no patterns are set, the conservative heuristic in
 *     `looksLikeProductUrl` below.
 *  4. Deduped with normalizeUrl. Pages whose sitemap <lastmod> is newer than brand.lastCrawlAt
 *     come first (changed products), then undated ones, then unchanged ones; capped at
 *     brand.maxProductsPerRun.
 *
 * Never throws. Updates brand.robotsStatus / robotsCheckedAt when the brand has an id.
 */

export type DiscoveryStatus = "OK" | "ROBOTS_DISALLOWED" | "NO_SITEMAP" | "FETCH_FAILED" | "NO_PRODUCTS" | "ERROR";
/** ALLOWED: "/" is crawlable; DISALLOWED: robots.txt disallows "/" for all agents; NO_ROBOTS: 4xx (no rules); UNREACHABLE: could not be read. */
export type RobotsStatus = "ALLOWED" | "DISALLOWED" | "NO_ROBOTS" | "UNREACHABLE";

export type SitemapReport = { url: string; status: "READ" | "SKIPPED" | "FAILED"; kind?: "index" | "urlset" | "text" | "html"; entries?: number; reason?: string };

export type DiscoveryResult = {
  status: DiscoveryStatus;
  urls: string[];
  reason?: string;
  robotsStatus?: RobotsStatus;
  sitemaps?: SitemapReport[];
  counts?: { seen: number; otherLocale: number; nonUsSitemaps: number; offDomain: number; notProduct: number; robotsDisallowed: number; duplicates: number; candidates: number; changed: number };
};

export type DiscoveryBrand = Pick<CommerceBrand, "officialDomain" | "discoveryUrls" | "productUrlPatterns" | "maxProductsPerRun" | "lastCrawlAt"> & { id?: string | null; slug?: string; market?: string | null };

export type DiscoveryOptions = { now?: Date; persist?: boolean; maxSitemaps?: number; maxBytes?: number; timeoutMs?: number };

export const DISCOVERY_DEFAULTS = { maxSitemaps: 10, maxBytes: 5_000_000, timeoutMs: 15_000 } as const;

const userAgent = () => `Made4BuyersBot/1.0 (+${config.siteUrl()})`;

// ── Heuristic ────────────────────────────────────────────────────────────────

/** Paths that are never product pages, whatever their slug looks like. */
const NON_PRODUCT_PATH = /(^|\/)(blog|blogs|news|newsroom|press|stories|article|articles|support|help|faq|kb|manuals?|drivers?|downloads?|careers?|jobs|legal|privacy|terms|policies|account|login|signin|cart|basket|checkout|search|compare|community|forum|forums|events?|investors?|about|contact|stores?|locations?|sitemap)(\/|$)/i;
/** Listings that are not a new product for sale: recalls, gift cards, refurbished/open-box, registrations. */
const NOT_A_NEW_PRODUCT = /(^|[\/_-])(recalls?|gift-?cards?|e-?gift|refurb|refurbished|renewed|reconditioned|open-?box|pre-?owned|warranty|registration)([\/_.-]|$)/i;
/** Country/language codes used as storefront path prefixes (ISO 3166-1 / 639-1 subsets). */
// Codes that are also everyday path words (tv, pc, id, it, is, do, go, me, so, to, no, ai, io) are left out.
export const STOREFRONT_LOCALE_CODES: readonly string[] = "ad ae af ag al am ao ar at au az ba bb bd be bf bg bh bi bj bn bo br bs bt bw by bz ca cd cf cg ch ci cl cm cn co cr cs cu cv cy cz da de dj dk dm dz ec ee eg el en er es et fa fi fj fm fr ga gb gd ge gh gm gn gq gr gt gw gy he hi hk hn hr ht hu ie il in iq ir ja jm jo jp ka ke kg kh ki kk km kn ko kp kr kw kz la lb lc li lk lr ls lt lu lv ly ma mc md mg mh mk ml mm mn mo mr ms mt mu my mv mw mx mz na nb ne ng ni nl nn np nr nz om pa pe pg ph pk pl pt pw py qa ro rs ru rw sa sb sc sd se sg si sk sl sm sn sq sr ss st sv sy sz td tg th tj tl tm tn tr tt tw tz ua ug uk us uy uz va vc ve vi vn vu ws ye za zh zm zw".split(" ");
const LOCALE_CODES = new Set(STOREFRONT_LOCALE_CODES);

/**
 * The storefront locale a URL path belongs to, or null when the path has no locale prefix.
 * Looks at the first two segments: "en-us", "cs-CZ", "eu-pl", "en_GB" or a bare "au" / "es".
 */
export function pathLocale(url: string): string | null {
  let segs: string[];
  try {
    segs = new URL(url).pathname.split("/").filter(Boolean).slice(0, 2);
  } catch {
    return null;
  }
  for (const seg of segs) {
    const s = seg.toLowerCase();
    if (/^[a-z]{2}[-_][a-z]{2}$/.test(s) && (LOCALE_CODES.has(s.slice(0, 2)) || LOCALE_CODES.has(s.slice(3)))) return s.replace("_", "-");
    if (LOCALE_CODES.has(s)) return s;
  }
  return null;
}

/** True for a US (or locale-neutral / plain English) storefront URL; false for any other country or language. */
export function isUsStorefront(url: string): boolean {
  const loc = pathLocale(url);
  return loc === null || loc === "us" || loc === "en" || loc.endsWith("-us");
}

/** A product path segment followed by a further segment: /product/x, /products/x, /p/x, /dp/x, /pd/x, /item/x, /sku/x. */
const PRODUCT_SEGMENT = /(^|\/)(products?|p|dp|pd|item|items|sku)\/[^/]+/i;
/** /shop/<category>/<page>: at least two segments below /shop/. */
const SHOP_PATH = /(^|\/)shop\/[^/]+\/[^/]+/i;
/** A token that mixes letters and digits, as model names do: xm5, s24, rtx4090, 9340a, mx3s. */
const MODEL_TOKEN = /^(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{2,}$/i;

/**
 * Conservative "is this a single product page?" test, used only when a brand has no
 * productUrlPatterns. A path qualifies when it is not under an obvious non-product section
 * (blog, support, legal, account, cart, search …) AND one of:
 *  - it contains a product segment with something after it: /product/…, /products/…, /p/…,
 *    /dp/…, /pd/…, /item(s)/…, /sku/…
 *  - it is at least two levels below /shop/: /shop/<category>/<product>
 *  - its last segment (minus .html/.htm/.aspx/.php) is a model-like slug: lowercase words
 *    joined by "-" or "_", one of which mixes letters and digits ("wh-1000xm5", "galaxy-s24-ultra",
 *    "mx-master-3s") — and it does not start with a year ("2024-gift-guide").
 */
export function looksLikeProductUrl(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  if (path === "/" || !path) return false;
  if (NON_PRODUCT_PATH.test(path) || NOT_A_NEW_PRODUCT.test(path)) return false;
  if (PRODUCT_SEGMENT.test(path) || SHOP_PATH.test(path)) return true;
  const segs = path.split("/").filter(Boolean);
  const last = (segs[segs.length - 1] ?? "").replace(/\.(html?|aspx?|php)$/i, "");
  if (last.length < 4 || last.length > 100 || /^(19|20)\d\d([-_]|$)/.test(last)) return false;
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i.test(last)) return false;
  return last.split(/[-_]/).some((t) => MODEL_TOKEN.test(t));
}

// ── Sitemap parsing ──────────────────────────────────────────────────────────

export type SitemapEntry = { loc: string; lastmod: Date | null };
export type ParsedSitemap = { kind: "index"; sitemaps: SitemapEntry[] } | { kind: "urlset"; urls: SitemapEntry[] } | { kind: "text"; urls: SitemapEntry[] } | { kind: "html"; urls: SitemapEntry[] };

const decodeXml = (s: string) =>
  s
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .trim();

const tag = (block: string, name: string) => {
  const m = block.match(new RegExp(`<(?:[a-z0-9]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[a-z0-9]+:)?${name}>`, "i"));
  return m ? decodeXml(m[1]) : null;
};

const parseDate = (s: string | null): Date | null => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Sitemap XML (index or urlset, any namespace prefix), a plain-text sitemap (one URL per line), or an HTML listing page. */
export function parseSitemap(body: string, baseUrl?: string): ParsedSitemap {
  const head = body.slice(0, 2000);
  if (/<(?:[a-z0-9]+:)?sitemapindex\b/i.test(head) || (/<(?:[a-z0-9]+:)?sitemap\b/i.test(body) && !/<(?:[a-z0-9]+:)?urlset\b/i.test(head))) {
    const sitemaps: SitemapEntry[] = [];
    for (const m of body.matchAll(/<(?:[a-z0-9]+:)?sitemap\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9]+:)?sitemap>/gi)) {
      const loc = tag(m[1], "loc");
      if (loc) sitemaps.push({ loc, lastmod: parseDate(tag(m[1], "lastmod")) });
    }
    if (sitemaps.length || /sitemapindex/i.test(head)) return { kind: "index", sitemaps };
  }
  if (/<(?:[a-z0-9]+:)?urlset\b/i.test(head)) {
    const urls: SitemapEntry[] = [];
    for (const m of body.matchAll(/<(?:[a-z0-9]+:)?url\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9]+:)?url>/gi)) {
      const loc = tag(m[1], "loc");
      if (loc) urls.push({ loc, lastmod: parseDate(tag(m[1], "lastmod")) });
    }
    return { kind: "urlset", urls };
  }
  if (/<(html|!doctype html|head|body)\b/i.test(head)) {
    const urls: SitemapEntry[] = [];
    for (const m of body.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi)) {
      try {
        urls.push({ loc: new URL(decodeXml(m[1]), baseUrl).toString(), lastmod: null });
      } catch {
        /* not a URL */
      }
    }
    return { kind: "html", urls };
  }
  const urls = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\/\S+$/i.test(l))
    .map((loc) => ({ loc, lastmod: null }));
  return { kind: "text", urls };
}

export function sitemapLinesFromRobots(robots: string): string[] {
  const out: string[] = [];
  for (const line of robots.split(/\r?\n/)) {
    const m = line.replace(/#.*/, "").trim().match(/^sitemap\s*:\s*(\S+)$/i);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// ── Discovery ────────────────────────────────────────────────────────────────

type Robots = { status: RobotsStatus; body: string; reason?: string };

/** http only for loopback test hosts while the loopback test switch is on; https everywhere else. */
function originOf(domain: string): string {
  const host = domain.trim().toLowerCase();
  const loopback = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
  return `${loopback && config.allowLoopbackForTests() ? "http" : "https"}://${host}`;
}

async function fetchRobots(origin: string, timeoutMs: number): Promise<Robots> {
  const res = await safeFetch(`${origin}/robots.txt`, { timeoutMs: Math.min(timeoutMs, 10_000), maxRedirects: 3, readBody: true, maxBytes: 500_000, standardPortsOnly: true, headers: { "User-Agent": userAgent(), Accept: "text/plain,*/*;q=0.5" } });
  if (!res.ok) {
    if (res.status >= 400 && res.status < 500) return { status: "NO_ROBOTS", body: "" };
    return { status: "UNREACHABLE", body: "", reason: `robots.txt could not be read (${res.status || res.error?.kind}); not crawling until it can` };
  }
  const body = res.body ?? "";
  return { status: robotsAllows(body, "/") ? "ALLOWED" : "DISALLOWED", body };
}

const pathOf = (u: URL) => u.pathname + u.search;

async function persistRobots(brand: DiscoveryBrand, status: RobotsStatus, now: Date) {
  if (!brand.id) return;
  try {
    await db.commerceBrand.update({ where: { id: brand.id }, data: { robotsStatus: status, robotsCheckedAt: now } });
  } catch (error) {
    log.warn("commerce discovery: robots status not saved", { brand: brand.slug, error: String(error).slice(0, 200) });
  }
}

export async function discoverProductUrls(brand: DiscoveryBrand, options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const now = options.now ?? new Date();
  try {
    return await discover(brand, options, now);
  } catch (error) {
    // Unexpected failure: reported, never thrown.
    return { status: "FETCH_FAILED", urls: [], reason: `discovery failed: ${String(error instanceof Error ? error.message : error).slice(0, 300)}` };
  }
}

async function discover(brand: DiscoveryBrand, options: DiscoveryOptions, now: Date): Promise<DiscoveryResult> {
  const maxSitemaps = options.maxSitemaps ?? DISCOVERY_DEFAULTS.maxSitemaps;
  const maxBytes = options.maxBytes ?? DISCOVERY_DEFAULTS.maxBytes;
  const timeoutMs = options.timeoutMs ?? DISCOVERY_DEFAULTS.timeoutMs;
  const persist = options.persist ?? true;
  const official = brand.officialDomain.trim().toLowerCase();
  const origin = originOf(official);
  if (!validateOutboundUrl(`${origin}/`, { standardPortsOnly: true }).url) return { status: "FETCH_FAILED", urls: [], reason: `official domain ${official} is not a public host` };

  // 1. robots.txt of the official domain.
  const robots = await fetchRobots(origin, timeoutMs);
  if (persist) await persistRobots(brand, robots.status, now);
  if (robots.status === "UNREACHABLE") return { status: "FETCH_FAILED", urls: [], reason: robots.reason, robotsStatus: robots.status };
  const robotsByOrigin = new Map<string, Robots>([[origin, robots]]);
  const robotsFor = async (u: URL) => {
    const o = u.origin;
    let r = robotsByOrigin.get(o);
    if (!r) robotsByOrigin.set(o, (r = await fetchRobots(o, timeoutMs)));
    return r;
  };

  // 2. Sitemap sources: admin discovery URLs, else robots.txt Sitemap: lines. Never guessed.
  const sources = brand.discoveryUrls.length ? brand.discoveryUrls : sitemapLinesFromRobots(robots.body);
  const sitemaps: SitemapReport[] = [];
  const queue: string[] = [];
  for (const s of sources) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      sitemaps.push({ url: s, status: "SKIPPED", reason: "not a valid URL" });
      continue;
    }
    if (!onBrandDomain(u, official)) sitemaps.push({ url: s, status: "SKIPPED", reason: `not on ${official}` });
    else queue.push(u.toString());
  }
  if (!queue.length) {
    const reason = sources.length ? "no sitemap on the brand's domain" : brand.discoveryUrls.length ? "no discovery URLs" : "no discovery URLs set and robots.txt lists no Sitemap";
    return { status: robots.status === "DISALLOWED" ? "ROBOTS_DISALLOWED" : "NO_SITEMAP", urls: [], reason: robots.status === "DISALLOWED" ? "robots.txt disallows the site" : reason, robotsStatus: robots.status, sitemaps };
  }

  const entries: SitemapEntry[] = [];
  const queued = new Set(queue);
  const counts0 = { nonUsSitemaps: 0 };
  const usOnly = (brand.market ?? "US") === "US";
  let fetched = 0;
  let read = 0;
  let robotsBlockedSitemaps = 0;
  while (queue.length) {
    const url = queue.shift()!;
    const u = new URL(url);
    if (/\.gz$/i.test(u.pathname)) {
      sitemaps.push({ url, status: "SKIPPED", reason: "gzip sitemaps are not read" });
      continue;
    }
    if (fetched >= maxSitemaps) {
      sitemaps.push({ url, status: "SKIPPED", reason: `sitemap cap reached (${maxSitemaps} per run)` });
      continue;
    }
    const r = await robotsFor(u);
    if (r.status === "UNREACHABLE" || !robotsAllows(r.body, pathOf(u))) {
      robotsBlockedSitemaps++;
      sitemaps.push({ url, status: "SKIPPED", reason: r.status === "UNREACHABLE" ? (r.reason ?? "robots.txt unreachable") : "disallowed by robots.txt" });
      continue;
    }
    fetched++;
    const res = await safeFetch(url, { timeoutMs, maxRedirects: 3, readBody: true, maxBytes, standardPortsOnly: true, headers: { "User-Agent": userAgent(), Accept: "application/xml,text/xml,text/plain,text/html;q=0.8,*/*;q=0.5" } });
    if (!res.ok || res.body === undefined) {
      sitemaps.push({ url, status: "FAILED", reason: res.error ? `${res.error.kind}: ${res.error.message}`.slice(0, 200) : `HTTP ${res.status}` });
      continue;
    }
    let finalUrl: URL;
    try {
      finalUrl = new URL(res.finalUrl);
    } catch {
      finalUrl = u;
    }
    if (!onBrandDomain(finalUrl, official)) {
      sitemaps.push({ url, status: "SKIPPED", reason: `redirected off ${official}` });
      continue;
    }
    read++;
    const parsed = parseSitemap(res.body, res.finalUrl);
    if (parsed.kind === "index") {
      sitemaps.push({ url, status: "READ", kind: "index", entries: parsed.sitemaps.length });
      // Product-looking and recently changed child sitemaps first, so the cap keeps the useful ones.
      const since = brand.lastCrawlAt?.getTime() ?? 0;
      const children = [...parsed.sitemaps].sort((a, b) => childScore(b, since) - childScore(a, since));
      for (const c of children) {
        let cu: URL;
        try {
          cu = new URL(c.loc, res.finalUrl);
        } catch {
          continue;
        }
        const key = cu.toString();
        if (queued.has(key)) continue;
        queued.add(key);
        if (!onBrandDomain(cu, official)) sitemaps.push({ url: key, status: "SKIPPED", reason: `not on ${official}` });
        else if (usOnly && !isUsStorefront(key)) counts0.nonUsSitemaps++;
        else queue.push(key);
      }
    } else {
      sitemaps.push({ url, status: "READ", kind: parsed.kind, entries: parsed.urls.length });
      entries.push(...parsed.urls);
    }
  }

  if (!read) {
    const failed = sitemaps.filter((s) => s.status === "FAILED").length;
    if (robotsBlockedSitemaps && !failed) return { status: "ROBOTS_DISALLOWED", urls: [], reason: "the brand's sitemaps are disallowed by robots.txt", robotsStatus: robots.status, sitemaps };
    return { status: failed ? "FETCH_FAILED" : "NO_SITEMAP", urls: [], reason: failed ? `no sitemap could be read (${failed} failed)` : "no readable sitemap (gzip-only, off-domain or capped)", robotsStatus: robots.status, sitemaps };
  }

  // 3. Candidate product URLs.
  const patterns = brand.productUrlPatterns.map((p) => new RegExp(globToRegex(p), "i"));
  const counts = { seen: entries.length, otherLocale: 0, nonUsSitemaps: counts0.nonUsSitemaps, offDomain: 0, notProduct: 0, robotsDisallowed: 0, duplicates: 0, candidates: 0, changed: 0 };
  const best = new Map<string, SitemapEntry>();
  for (const e of entries) {
    const norm = normalizeUrl(e.loc);
    if (!norm) {
      counts.notProduct++;
      continue;
    }
    const u = new URL(norm);
    if (u.host !== official) {
      counts.offDomain++;
      continue;
    }
    if (usOnly && !isUsStorefront(norm)) {
      counts.otherLocale++;
      continue;
    }
    if (patterns.length ? !patterns.some((re) => re.test(norm)) : !looksLikeProductUrl(norm)) {
      counts.notProduct++;
      continue;
    }
    if (!robotsAllows(robots.body, pathOf(u))) {
      counts.robotsDisallowed++;
      continue;
    }
    const prev = best.get(norm);
    if (prev) {
      counts.duplicates++;
      if ((e.lastmod?.getTime() ?? 0) > (prev.lastmod?.getTime() ?? 0)) best.set(norm, { loc: norm, lastmod: e.lastmod });
      continue;
    }
    best.set(norm, { loc: norm, lastmod: e.lastmod });
  }
  counts.candidates = best.size;

  if (!best.size) {
    if (counts.robotsDisallowed) return { status: "ROBOTS_DISALLOWED", urls: [], reason: `all ${counts.robotsDisallowed} product URL(s) are disallowed by robots.txt`, robotsStatus: robots.status, sitemaps, counts };
    return { status: "NO_PRODUCTS", urls: [], reason: `no product URLs among ${counts.seen} sitemap entries${patterns.length ? " matching the brand's product URL patterns" : ""}`, robotsStatus: robots.status, sitemaps, counts };
  }

  // 4. Changed products first (lastmod after the last crawl), then undated, then unchanged; newest first within each.
  const since = brand.lastCrawlAt?.getTime();
  const rank = (e: SitemapEntry) => {
    if (!e.lastmod) return 1;
    return since === undefined || e.lastmod.getTime() > since ? 0 : 2;
  };
  const sorted = [...best.values()].sort((a, b) => rank(a) - rank(b) || (b.lastmod?.getTime() ?? 0) - (a.lastmod?.getTime() ?? 0) || a.loc.localeCompare(b.loc));
  counts.changed = sorted.filter((e) => rank(e) === 0 && e.lastmod).length;
  const cap = Math.max(BRAND_LIMITS.maxProductsPerRun.min, Math.min(BRAND_LIMITS.maxProductsPerRun.max, brand.maxProductsPerRun || 20));
  const urls = sorted.slice(0, cap).map((e) => e.loc);
  return { status: "OK", urls, reason: `${urls.length} of ${best.size} product URL(s)${since !== undefined ? `, ${counts.changed} changed since the last crawl` : ""}`, robotsStatus: robots.status, sitemaps, counts };
}

function childScore(c: SitemapEntry, since: number): number {
  let s = 0;
  if (/product|pdp|catalog|shop|store/i.test(c.loc)) s += 2;
  if (/blog|news|image|video|help|support|article|press/i.test(c.loc)) s -= 2;
  if (c.lastmod && c.lastmod.getTime() > since) s += 1;
  return s;
}
