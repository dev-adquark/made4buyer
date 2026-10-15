/**
 * Direct product-page fetching: no Apify, no cloud actor, no proxy service and no per-run cost.
 * Used by runDirectBrandCrawl (lib/commerce/pipeline.ts) as a fully independent alternative to the
 * Apify-based commerce-discover/commerce-collect path — useful whenever Apify is not configured, not
 * working (an account/plan block, as opposed to a code bug), or simply not wanted.
 *
 * What it reads, with no JavaScript execution (a plain HTTP GET, robots.txt checked first):
 *   - every <script type="application/ld+json"> block (Product/Offer schema: most storefronts render
 *     this server-side for search engines, which is exactly what this app already depends on for
 *     Apify-sourced pages too — lib/commerce/normalize.ts reads the identical shape either way)
 *   - OpenGraph/product: meta tags, canonical URL, <title>, the first <h1>
 *   - on an apparent Shopify storefront (a /products/ path and a Shopify marker in the HTML): the
 *     same-origin <path>.js product JSON (one extra same-origin GET, itself robots-checked) — the
 *     strongest, most reliable price/compare-at-price source for Shopify brands, and nothing here
 *     needs a rendered page to read it
 *   - Shopify.currency / Shopify.country, when the theme inlines them as a <script> literal (common)
 *
 * What it cannot read (the one real trade-off of not running a browser): a previous/list price shown
 * only via CSS styling with no markup at all (no <s>/<del>/<strike>, no "was/compare/regular/MSRP"
 * text, no JSON-LD priceSpecification, no Shopify compare_at_price). staticPriceBlocks() below covers
 * the markup/text cases; a page that relies purely on a CSS class for strike-through is missed. This
 * only affects "previous price" detection — the current price (JSON-LD, meta, Shopify JSON) is read
 * exactly as reliably as the Apify path reads it.
 */
import { checkRobots } from "@/lib/pipeline/apify";
import { safeFetch } from "@/lib/net/safe-fetch";
import { decodeEntities, jsonLdBlocks, LOGO_USER_AGENT } from "./brand-logos";

const PAGE_MAX_BYTES = 3_000_000;
const PAGE_TIMEOUT_MS = 15_000;
const SHOPIFY_JSON_MAX_BYTES = 1_000_000;
const SHOPIFY_JSON_TIMEOUT_MS = 10_000;

export type DirectPageResult = { ok: true; page: Record<string, unknown> } | { ok: false; code: string; reason: string };

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function firstMatch(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  return m ? decodeEntities(stripTags(m[1])) || null : null;
}

function metaTags(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<meta\b[^>]*>/gi;
  for (const m of html.matchAll(re)) {
    const tag = m[0];
    const prop = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.trim().toLowerCase();
    const content = /\scontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (!prop || content == null || prop in out) continue;
    if (/^(og|product):/.test(prop) || prop === "twitter:title") out[prop] = decodeEntities(content.trim()).slice(0, 2000);
  }
  return out;
}

function canonicalUrlOf(html: string, pageUrl: string): string | null {
  const re = /<link\b[^>]*>/gi;
  for (const m of html.matchAll(re)) {
    const tag = m[0];
    if (!/rel\s*=\s*["']canonical["']/i.test(tag)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    try {
      return new URL(decodeEntities(href), pageUrl).toString();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * A static approximation of the browser page function's visual "was $X" detection: text struck
 * through by markup (<s>/<del>/<strike>) or carrying a previous-price label ("was", "regular price",
 * "MSRP", "compare at" …), near a number. No DOM, so no computed-style/visibility check: a page that
 * shows its previous price only through a CSS class (no matching tag or label text) is not detected.
 */
function staticPriceBlocks(html: string): Array<{ text: string; comparisons: Array<{ tag: string; struck: boolean; text: string; cls: string; aria: string; label: string }> }> {
  const out: Array<{ text: string; comparisons: Array<{ tag: string; struck: boolean; text: string; cls: string; aria: string; label: string }> }> = [];
  const struckRe = /<(s|del|strike)\b[^>]*>([\s\S]{0,200}?)<\/\1>/gi;
  for (const m of html.matchAll(struckRe)) {
    if (out.length >= 10) break;
    const text = stripTags(m[2]);
    if (!text || text.length > 80 || !/\d/.test(text)) continue;
    out.push({ text, comparisons: [{ tag: m[1].toLowerCase(), struck: true, text: decodeEntities(text), cls: "", aria: "", label: "" }] });
  }
  if (out.length < 10) {
    const labelled = /\b(was|regular price|reg\.?\s*price|original price|compare at|msrp|m\.s\.r\.p\.?|list price|rrp)\b[^0-9]{0,20}([$€£]\s?[0-9][0-9.,]*)/gi;
    for (const m of html.matchAll(labelled)) {
      if (out.length >= 10) break;
      const text = decodeEntities(`${m[1]} ${m[2]}`);
      out.push({ text, comparisons: [{ tag: "span", struck: false, text, cls: "", aria: "", label: decodeEntities(m[1]) }] });
    }
  }
  return out;
}

function shopifyMarker(html: string): boolean {
  return /cdn\.shopify\.com|\/cdn\/shop\/|Shopify\.shop\s*=|window\.Shopify\s*=/i.test(html);
}

function shopifyInlineVar(html: string, key: "currency" | "country"): string | null {
  const re = key === "currency" ? /Shopify\.currency\s*=\s*\{[^}]*?"active"\s*:\s*"([A-Za-z]{3})"/ : /Shopify\.country\s*=\s*["']([A-Za-z]{2})["']/;
  return re.exec(html)?.[1]?.toUpperCase() ?? null;
}

/**
 * Fetches a Shopify product's same-origin <path>.js JSON (variants, prices, compare-at prices,
 * availability) — a plain JSON GET, nothing a browser is needed for. robots.txt is checked by the
 * caller before this is reached (fetchDirectPage already checked the HTML page's own path; this one
 * checks its own).
 */
async function fetchShopifyProductJson(finalUrl: string): Promise<{ product: unknown; note: string | null }> {
  let jsUrl: string;
  try {
    const u = new URL(finalUrl);
    u.hash = "";
    jsUrl = `${u.origin}${u.pathname.replace(/\/+$/, "")}.js`;
  } catch {
    return { product: null, note: "could not build the product JSON URL" };
  }
  const robots = await checkRobots(jsUrl).catch((error: unknown) => ({ allowed: false, reason: String(error).slice(0, 150) }));
  if (!robots.allowed) return { product: null, note: `robots.txt disallows ${jsUrl}` };
  try {
    const res = await safeFetch(jsUrl, { headers: { "User-Agent": LOGO_USER_AGENT(), Accept: "application/json" }, timeoutMs: SHOPIFY_JSON_TIMEOUT_MS, maxRedirects: 2, readBody: true, maxBytes: SHOPIFY_JSON_MAX_BYTES });
    if (!res.ok || !res.body) return { product: null, note: `product JSON ${res.error ? res.error.kind : `HTTP ${res.status}`}` };
    const parsed: unknown = JSON.parse(res.body);
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { variants?: unknown }).variants)) return { product: parsed, note: null };
    return { product: null, note: "product JSON has no variants" };
  } catch (error) {
    return { product: null, note: `product JSON failed: ${String(error).slice(0, 100)}` };
  }
}

/**
 * Fetches one page directly and returns the same shape PRODUCT_PAGE_FUNCTION (Apify) returns, so the
 * rest of the pipeline (lib/commerce/normalize.ts onward: identity matching, facts, offers) needs no
 * change at all. robots.txt is checked first (lib/pipeline/apify.ts checkRobots, the same function
 * the rest of the commerce engine already uses); a disallowed or unreadable robots.txt refuses the
 * fetch rather than guessing.
 */
export async function fetchDirectPage(url: string, label: "PRODUCT" | "LISTING" | "LINKED" = "PRODUCT"): Promise<DirectPageResult> {
  const robots = await checkRobots(url).catch((error: unknown) => ({ allowed: false, reason: String(error).slice(0, 150) }));
  if (!robots.allowed) return { ok: false, code: "ROBOTS_DISALLOWED", reason: robots.reason ?? `robots.txt disallows ${url}` };
  const res = await safeFetch(url, { headers: { "User-Agent": LOGO_USER_AGENT(), Accept: "text/html,application/xhtml+xml" }, timeoutMs: PAGE_TIMEOUT_MS, maxRedirects: 5, readBody: true, maxBytes: PAGE_MAX_BYTES });
  if (!res.ok || !res.body) return { ok: false, code: res.error ? res.error.kind : `HTTP_${res.status}`, reason: res.error?.message ?? `HTTP ${res.status}` };
  const html = res.body;
  const finalUrl = res.finalUrl;

  let shopifyProduct: unknown = null;
  let shopifyNote: string | null = null;
  let path = "";
  try {
    path = new URL(finalUrl).pathname;
  } catch {
    /* finalUrl is always a URL safeFetch resolved; defensive only */
  }
  if (shopifyMarker(html) && /\/products\//.test(path)) {
    const r = await fetchShopifyProductJson(finalUrl);
    shopifyProduct = r.product;
    shopifyNote = r.note;
  }

  const page: Record<string, unknown> = {
    m4bCommerce: 1,
    url: finalUrl,
    requestUrl: url,
    crawlLabel: label,
    canonicalUrl: canonicalUrlOf(html, finalUrl),
    title: firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
    jsonLd: jsonLdBlocks(html),
    meta: metaTags(html),
    h1: firstMatch(html, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i),
    breadcrumbs: [],
    specTables: [],
    images: [],
    priceBlocks: staticPriceBlocks(html),
    shopifyProduct,
    shopifyCurrency: shopifyInlineVar(html, "currency"),
    shopifyCountry: shopifyInlineVar(html, "country"),
    shopifyNote,
    lang: /<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(html)?.[1] ?? null,
  };
  return { ok: true, page };
}
