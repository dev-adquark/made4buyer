import type { CommerceBrand } from "@prisma/client";
import { config } from "@/lib/config";
import { safeFetch } from "@/lib/net/safe-fetch";
import { globToRegex, normalizeUrl, robotsAllows } from "@/lib/pipeline/apify";
import { isUsStorefront, looksLikeProductUrl, STOREFRONT_LOCALE_CODES } from "./discovery";
import { PRODUCT_PAGE_FUNCTION } from "./page-functions/product";

/**
 * Deal-page crawling: a brand's official SALE/DEAL pages (CommerceBrand.dealUrls) and its explicit
 * product pages (CommerceBrand.productUrls) become part of the brand's one Apify run.
 *
 *  - dealUrls are start URLs labelled LISTING; product URLs (re-checks, explicit productUrls,
 *    discovered URLs) are labelled PRODUCT.
 *  - From a LISTING page (depth 0) the crawler follows `a[href]` links, ONLY those matching the
 *    brand's productUrlPatterns (globs) or, when the brand has none, the conservative product-URL
 *    heuristic restricted to the exact official host (product-segment paths only). Depth 1 at most;
 *    a PRODUCT page never enqueues links (context.skipLinks()).
 *  - Three guards: Apify `globs` (what is enqueued), the page function (a followed page must be on the
 *    exact official host, match the follow patterns and be a US storefront path, else null), and the
 *    server (lib/commerce/pipeline.ts processRaw → followedPageAllowed below).
 *  - A listing page never yields a product: the page function returns null for it unless the
 *    listing URL is itself a product page.
 *  - robots.txt is respected by the actor (respectRobotsTxtFile) and its rules are passed to the
 *    page function, which fetches a Shopify product's `.js` JSON only when robots allows that path.
 *
 * Budget: the followed pages of one run are capped at min(brand.maxProductsPerRun,
 * COMMERCE_DEAL_PAGES_PER_RUN (default 40)); maxPagesPerCrawl is the start URLs plus that cap.
 */

function envNum(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw == null || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

/** COMMERCE_DEAL_PAGES_PER_RUN (default 40): at most this many pages followed from deal pages per run. */
export const dealPagesPerRun = () => envNum("COMMERCE_DEAL_PAGES_PER_RUN", 40, 1, 500);
/** Followed-page cap of one brand run: min(maxProductsPerRun, COMMERCE_DEAL_PAGES_PER_RUN). */
export const dealFollowCap = (brand: Pick<CommerceBrand, "maxProductsPerRun">) => Math.max(1, Math.min(Math.max(1, brand.maxProductsPerRun), dealPagesPerRun()));

const PRODUCT_SEGMENTS = ["products", "product", "p", "dp", "pd", "item", "items", "sku"] as const;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Apify globs for links worth following from a listing page: the brand's patterns, else product-segment paths on the exact host. */
export function followGlobs(brand: Pick<CommerceBrand, "officialDomain" | "productUrlPatterns">): string[] {
  if (brand.productUrlPatterns.length) return [...brand.productUrlPatterns];
  const host = brand.officialDomain.trim().toLowerCase();
  return [...PRODUCT_SEGMENTS.map((s) => `https://${host}/**/${s}/*`), `https://${host}/**/shop/*/*`];
}

/** Heuristic mode only: links that are never a new product for sale (same idea as discovery's NOT_A_NEW_PRODUCT). */
export function followExcludes(brand: Pick<CommerceBrand, "productUrlPatterns">): string[] {
  // Not-new items are never deals: never spend crawl budget on them, patterns or not.
  if (brand.productUrlPatterns.length) return ["**/*refurb*", "**/*renewed*", "**/*reconditioned*", "**/*open-box*", "**/*pre-owned*"];
  return ["**/*refurb*", "**/*renewed*", "**/*reconditioned*", "**/*open-box*", "**/*pre-owned*", "**/*gift-card*", "**/*giftcard*", "**/*e-gift*", "**/*recall*"];
}

/** Anchored regex sources (for the page function) equivalent to followGlobs. */
export function followPatterns(brand: Pick<CommerceBrand, "officialDomain" | "productUrlPatterns">): string[] {
  if (brand.productUrlPatterns.length) return brand.productUrlPatterns.map(globToRegex);
  const host = esc(brand.officialDomain.trim().toLowerCase());
  return [`^https://${host}(?:/[^?#]*)?/(?:${PRODUCT_SEGMENTS.join("|")})/[^/?#]+/?(?:[?#].*)?$`, `^https://${host}(?:/[^?#]*)?/shop/[^/?#]+/[^/?#]+/?(?:[?#].*)?$`];
}

/**
 * Server-side guard for a page reached by following a link (or a listing page that returned a
 * product): on the brand's exact official host, a US storefront path for a US-market brand, and a
 * product URL by the brand's patterns (or, without patterns, the conservative heuristic).
 */
export function followedPageAllowed(url: string, brand: Pick<CommerceBrand, "officialDomain" | "productUrlPatterns" | "market">): { ok: true } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  const host = brand.officialDomain.trim().toLowerCase();
  if (u.host.toLowerCase() !== host) return { ok: false, reason: `${u.host} is not the official host ${host}` };
  if ((brand.market ?? "US") === "US" && !isUsStorefront(url)) return { ok: false, reason: "not a US storefront page" };
  const norm = normalizeUrl(url) ?? url;
  if (brand.productUrlPatterns.length) {
    const ok = brand.productUrlPatterns.some((p) => new RegExp(globToRegex(p), "i").test(norm) || new RegExp(globToRegex(p), "i").test(url));
    return ok ? { ok: true } : { ok: false, reason: "does not match the brand's product URL patterns" };
  }
  return looksLikeProductUrl(norm) ? { ok: true } : { ok: false, reason: "not a product URL (heuristic)" };
}

// ── robots.txt rules for the page function ──────────────────────────────────

export type RobotsRule = { allow: boolean; path: string };

/** The `*` group rules of a robots.txt (all `*` groups merged), for the page function's own check of the Shopify `.js` path. */
export function robotsRulesFor(body: string): RobotsRule[] {
  const rules: RobotsRule[] = [];
  let agents: string[] = [];
  let lastWasAgent = false;
  for (const line of body.split(/\r?\n/)) {
    const m = line.replace(/#.*/, "").trim().match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      agents = lastWasAgent ? [...agents, value.toLowerCase()] : [value.toLowerCase()];
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if ((key === "allow" || key === "disallow") && value && agents.includes("*")) rules.push({ allow: key === "allow", path: value.slice(0, 500) });
    }
  }
  return rules.slice(0, 500);
}

/** Same rule evaluation as the page function (longest match wins, Allow on ties; `*` wildcard, `$` end). */
export function rulesAllow(rules: RobotsRule[], path: string): boolean {
  let best: { allow: boolean; len: number } | null = null;
  for (const r of rules) {
    const anchored = r.path.endsWith("$");
    const src = (anchored ? r.path.slice(0, -1) : r.path).split("*").map(esc).join(".*");
    if (!new RegExp(`^${src}${anchored ? "$" : ""}`).test(path)) continue;
    if (!best || r.path.length > best.len || (r.path.length === best.len && r.allow)) best = { allow: r.allow, len: r.path.length };
  }
  return best ? best.allow : true;
}

/** http only for loopback test hosts while the loopback test switch is on; https everywhere else. */
function originOf(domain: string): string {
  const host = domain.trim().toLowerCase();
  const loopback = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
  return `${loopback && config.allowLoopbackForTests() ? "http" : "https"}://${host}`;
}

export type BrandRobots = { status: "READ" | "NONE" | "UNREADABLE"; body: string; rules: RobotsRule[] | null; reason?: string };

/** robots.txt of the brand's official host, read once per run start. 4xx = no rules; unreachable/5xx = unreadable (nothing extra is fetched). */
export async function fetchBrandRobots(officialDomain: string): Promise<BrandRobots> {
  try {
    const res = await safeFetch(`${originOf(officialDomain)}/robots.txt`, { timeoutMs: 8_000, maxRedirects: 3, readBody: true, maxBytes: 500_000, standardPortsOnly: !config.allowLoopbackForTests(), headers: { "User-Agent": `Made4BuyersBot/1.0 (+${config.siteUrl()})`, Accept: "text/plain,*/*;q=0.5" } });
    if (res.ok) {
      const body = res.body ?? "";
      return { status: "READ", body, rules: robotsRulesFor(body) };
    }
    if (res.status >= 400 && res.status < 500) return { status: "NONE", body: "", rules: [] };
    return { status: "UNREADABLE", body: "", rules: null, reason: `robots.txt could not be read (${res.status || res.error?.kind})` };
  } catch (error) {
    return { status: "UNREADABLE", body: "", rules: null, reason: `robots.txt could not be read (${String(error).slice(0, 80)})` };
  }
}

/** Start URLs a crawl may use: normalized, on the brand's exact host or its subdomains, allowed by robots.txt (unreadable robots = none). */
export function crawlableStartUrls(urls: string[], brand: Pick<CommerceBrand, "officialDomain">, robots: BrandRobots | null): { urls: string[]; skipped: Array<{ url: string; reason: string }> } {
  const out: string[] = [];
  const skipped: Array<{ url: string; reason: string }> = [];
  const host = brand.officialDomain.trim().toLowerCase();
  const base = host.replace(/^www\./, "");
  for (const raw of urls) {
    const n = normalizeUrl(raw);
    if (!n) {
      skipped.push({ url: raw, reason: "not a valid http(s) URL" });
      continue;
    }
    const u = new URL(n);
    if (!(u.host === host || u.hostname === base || u.hostname.endsWith(`.${base}`))) {
      skipped.push({ url: n, reason: `not on ${host}` });
      continue;
    }
    if (!robots || robots.status === "UNREADABLE") {
      skipped.push({ url: n, reason: robots?.reason ?? "robots.txt not read; not crawling until it can be" });
      continue;
    }
    // Rules are those of the official host; a subdomain's robots.txt is left to the actor (respectRobotsTxtFile).
    if (u.host === host && robots.status === "READ" && !robotsAllows(robots.body, u.pathname + u.search)) {
      skipped.push({ url: n, reason: `disallowed by robots.txt (${u.pathname})` });
      continue;
    }
    if (!out.includes(n)) out.push(n);
  }
  return { urls: out, skipped };
}

// ── Actor input ──────────────────────────────────────────────────────────────

type InputBrand = Pick<CommerceBrand, "slug" | "officialDomain" | "productUrlPatterns" | "maxProductsPerRun" | "market">;

const exactUrlRegex = (u: string) => `^${esc(u)}/?(?:[?#].*)?$`;

/** customData shared by product-only and deal runs (the page function reads it). */
export function pageCustomData(brand: InputBrand, productUrls: string[], robotsRules: RobotsRule[] | null, deal: boolean) {
  return {
    brand: brand.slug,
    productPatterns: brand.productUrlPatterns.length ? brand.productUrlPatterns.map(globToRegex) : productUrls.map(exactUrlRegex),
    officialHost: brand.officialDomain.trim().toLowerCase(),
    // null = robots.txt was not read: the page function then fetches nothing beyond the page itself.
    robotsRules,
    ...(deal
      ? {
          dealCrawl: true,
          followPatterns: followPatterns(brand),
          followCap: dealFollowCap(brand),
          usOnly: (brand.market ?? "US") === "US",
          localeCodes: STOREFRONT_LOCALE_CODES,
        }
      : {}),
  };
}

/**
 * Actor input of a run with deal pages: dealUrls (LISTING) + productUrls (PRODUCT), links followed
 * one level deep from listing pages only, matching the follow globs. In a brand run the price
 * re-checks come first (opts.leadingProductUrls), then the deal pages, then the other product URLs.
 */
export function buildDealActorInput(brand: InputBrand, dealUrls: string[], productUrls: string[], opts: { robotsRules?: RobotsRule[] | null; leadingProductUrls?: number } = {}) {
  const listing = [...new Set(dealUrls)];
  const products = [...new Set(productUrls)].filter((u) => !listing.includes(u));
  // Price re-checks (the first `leadingProductUrls` product URLs) lead; then deal pages; then the other product pages.
  const lead = Math.max(0, Math.min(products.length, opts.leadingProductUrls ?? 0));
  const product = (url: string) => ({ url, userData: { label: "PRODUCT" } });
  return {
    startUrls: [...products.slice(0, lead).map(product), ...listing.map((url) => ({ url, userData: { label: "LISTING" } })), ...products.slice(lead).map(product)],
    linkSelector: "a[href]",
    globs: followGlobs(brand).map((glob) => ({ glob })),
    excludes: followExcludes(brand).map((glob) => ({ glob })),
    maxCrawlingDepth: 1,
    maxPagesPerCrawl: listing.length + products.length + dealFollowCap(brand),
    maxConcurrency: 2,
    maxRequestRetries: 2,
    respectRobotsTxtFile: true,
    injectJQuery: false,
    // Web Scraper requires a proxy setting; Apify's default pool is its normal egress (no residential IPs, no evasion).
    proxyConfiguration: { useApifyProxy: true },
    pageFunction: PRODUCT_PAGE_FUNCTION,
    customData: pageCustomData(brand, products, opts.robotsRules ?? null, true),
  };
}
