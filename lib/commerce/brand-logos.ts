import { createHash } from "node:crypto";
import type { CommerceBrand } from "@prisma/client";
import { revalidatePath, revalidateTag } from "next/cache";
import { allowed } from "@/lib/automation/settings";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { safeFetch, type SafeFetchResult } from "@/lib/net/safe-fetch";
import { robotsAllows } from "@/lib/pipeline/apify";
import { isFreeLicence } from "@/lib/products/commons-image";
import { registrableDomain } from "@/lib/products/page-extract";
import { wikidataEnabled } from "@/lib/products/wikidata";
import { commerceAudit } from "./audit";
import { ensureBrandsSeeded } from "./brands";
import { recordVerification } from "./verification-events";

/**
 * Official brand logos (CommerceBrand.logo*), read only from verified sources, in this order:
 *
 *  1. the brand's OFFICIAL site (CommerceBrand.officialDomain home page; robots.txt respected; one
 *     page request): a JSON-LD Organization/Brand `logo` whose name (and url, when stated) is the
 *     brand's; then <link rel="icon" | "apple-touch-icon" | "mask-icon"> icons that are SVG or at
 *     least 96 px. The logo file must be https on the brand's registrable domain or one of its own
 *     subdomains (images.<domain>, cdn.<domain>); third-party CDNs are rejected.
 *  2. Wikidata: the item whose official website (P856) is on the brand's registrable domain AND whose
 *     label is the brand's name; its logo image (P154) is a Wikimedia Commons file (freely licensed).
 *
 * No search engine, logo aggregator or stock site is ever used, and nothing is guessed: a brand with
 * no verified logo keeps its monogram. Every candidate file is fetched (≤ 2 MB) and checked: HTTP
 * 200, an image content type (SVG / PNG / WebP / JPEG) that agrees with the bytes, decodable
 * dimensions, not a tracking pixel, not a platform's default favicon, not a hero/banner photo, and
 * for SVG no script, event handler or external reference (logos are only ever rendered via <img>).
 * The URL and its provenance are stored; the file is linked, never re-hosted.
 *
 * Job "brand-logos": brands never checked, checked over 30 days ago, or FAILED over a day ago
 * (BRAND_LOGOS_PER_RUN, default 15), ≤ 1 request per second per host. An admin override
 * (logoLocked) is never overwritten. Every check writes a LOGO verification event; a change of the
 * shown logo or status is audited.
 */

export const LOGO_SOURCES = ["official-jsonld", "official-icon", "wikidata-commons", "admin-url"] as const;
export type LogoSource = (typeof LOGO_SOURCES)[number];
export type LogoStatus = "VERIFIED" | "NOT_FOUND" | "FAILED" | "REJECTED";

export const LOGO_RECHECK_DAYS = 30;
export const LOGO_FAILED_RETRY_HOURS = 24;
export const LOGO_MAX_BYTES = 2_000_000;
const PAGE_MAX_BYTES = 8_000_000;
const MAX_JSONLD_FETCHES = 2;
const MAX_ICON_FETCHES = 3;
const ICON_MIN_PX = 96;
const LOGO_MIN_PX = 64;
const PIXEL_MAX_PX = 15;

const SITE = () => (process.env.NEXT_PUBLIC_SITE_URL || "https://made4buyers.vercel.app").replace(/\/+$/, "");
export const LOGO_USER_AGENT = () => `Made4BuyersBot/1.0 (+${SITE()})`;
const WIKIDATA_API = () => process.env.WIKIDATA_API_URL || "https://www.wikidata.org/w/api.php";
const COMMONS_API = () => process.env.COMMONS_API_URL || "https://commons.wikimedia.org/w/api.php";
/** Commons file lookups (not search) follow the same off switch as Commons search. */
const commonsEnabled = () => !["0", "false", "off", "no"].includes((process.env.COMMONS_SEARCH_ENABLED ?? "").trim().toLowerCase());
export const brandLogosPerRun = () => {
  const n = Number(process.env.BRAND_LOGOS_PER_RUN);
  return Number.isFinite(n) && n >= 1 ? Math.min(100, Math.floor(n)) : 15;
};
const paceMsDefault = () => {
  const n = Number(process.env.BRAND_LOGOS_PACE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 1000;
};

// ── Names and domains (pure) ─────────────────────────────────────────────────

const CORPORATE = new Set(["inc", "incorporated", "corp", "corporation", "co", "company", "llc", "ltd", "limited", "plc", "gmbh", "ag", "sa", "nv", "bv", "kk", "group", "holdings", "technologies", "technology", "electronics", "operating", "usa", "us", "america", "international", "global", "the", "com", "net", "io", "labs", "innovation", "innovations", "brands", "industries", "enterprises"]);
const STORE_WORDS = new Set(["store", "shop", "direct", "official"]);

function words(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** "Apple Inc." → "apple"; "The Sharper Image Company" → "sharperimage"; corporate suffixes and a leading "The" removed, spaces/punctuation ignored. */
export function brandKeyOf(name: string): string {
  const w = words(name);
  while (w.length > 1 && CORPORATE.has(w[w.length - 1])) w.pop();
  while (w.length > 1 && w[0] === "the") w.shift();
  return w.join("");
}

/**
 * Whether `candidate` (a JSON-LD Organization name, a Wikidata label) names the brand. Exact after
 * normalization; a store-front brand ("Google Store", "PlayStation Direct") also matches the company
 * it is the store of ("Google", "PlayStation"), never the reverse (brand "Apple" ≠ "Apple Store").
 * Returns "exact" | "store" | null.
 */
export function brandNameMatch(brandName: string, candidate: string | null | undefined): "exact" | "store" | null {
  if (!candidate) return null;
  // "NVIDIA - World Leader in AI Computing", "Acme | Official Site": the name before a tagline separator.
  const head = candidate.split(/\s+[-–—|:]\s+/)[0];
  if (head && head !== candidate) {
    const m = brandNameMatch(brandName, head);
    if (m) return m;
  }
  const b = brandKeyOf(brandName);
  const c = brandKeyOf(candidate);
  if (!b || !c) return null;
  if (b === c) return "exact";
  const w = words(brandName);
  while (w.length > 1 && (STORE_WORDS.has(w[w.length - 1]) || CORPORATE.has(w[w.length - 1]))) w.pop();
  return w.join("") === c ? "store" : null;
}

function hostOfDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

const isLoopbackHost = (host: string) => /^(127\.0\.0\.1|localhost)$/.test(host);

/** Origin of the brand's official site: https, except loopback test hosts while the loopback test switch is on. */
export function officialOrigin(officialDomain: string): string {
  const host = hostOfDomain(officialDomain);
  const loopback = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
  return `${loopback && config.allowLoopbackForTests() ? "http" : "https"}://${host}`;
}

/** Hosts that are NEVER the brand's own, even when a subdomain-looking path suggests it. */
const THIRD_PARTY_HOST = /(^|\.)(cloudfront\.net|akamaihd\.net|akamaized\.net|azureedge\.net|fastly\.net|cdn\.shopify\.com|shopifycdn\.com|wixstatic\.com|squarespace-cdn\.com|scene7\.com|imgix\.net|cloudinary\.com|ctfassets\.net|contentful\.com|sanity\.io|googleusercontent\.com|gstatic\.com|amazonaws\.com|wp\.com|cdninstagram\.com|fbcdn\.net|twimg\.com)$/i;

/**
 * Whether a logo URL is acceptable for a brand: https on the brand's registrable domain or one of
 * its subdomains. A third-party CDN (cloudfront, cdn.shopify.com, scene7, cloudinary …) is not the
 * brand's own host and is rejected. Loopback (http) only in tests.
 */
export function logoHostCheck(raw: string, officialDomain: string): { ok: true } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "logo URL could not be parsed" };
  }
  const host = u.hostname.toLowerCase();
  const brandHost = hostOfDomain(officialDomain).replace(/:\d+$/, "");
  if (config.allowLoopbackForTests() && isLoopbackHost(host) && isLoopbackHost(brandHost)) return u.protocol === "http:" || u.protocol === "https:" ? { ok: true } : { ok: false, reason: "not http(s)" };
  if (u.protocol !== "https:") return { ok: false, reason: `logo URL is not https (${u.protocol.replace(":", "")})` };
  if (u.port && u.port !== "443") return { ok: false, reason: "logo URL names a port" };
  if (THIRD_PARTY_HOST.test(host)) return { ok: false, reason: `logo is on a third-party CDN (${host}), not on ${registrableDomain(brandHost)}` };
  const want = registrableDomain(brandHost);
  if (registrableDomain(host) !== want) return { ok: false, reason: `logo host ${host} is not on the brand's domain ${want}` };
  return { ok: true };
}

/** https upload.wikimedia.org/wikipedia/commons/… or a thumb.wikimedia.org Commons thumbnail (loopback only in tests). */
export function isCommonsUpload(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol === "https:" && u.hostname === "upload.wikimedia.org" && u.pathname.startsWith("/wikipedia/commons/")) return true;
    if (u.protocol === "https:" && u.hostname === "thumb.wikimedia.org" && u.pathname.startsWith("/wikipedia/commons/thumb/")) return true;
    return config.allowLoopbackForTests() && isLoopbackHost(u.hostname);
  } catch {
    return false;
  }
}

/** The Commons file name of an upload URL ("…/thumb/a/ab/Name.svg/512px-Name.svg.png" → "Name.svg"). */
export function commonsFileName(raw: string): string | null {
  try {
    const parts = new URL(raw).pathname.split("/").filter(Boolean);
    const thumb = parts.indexOf("thumb");
    const name = thumb >= 0 ? parts[thumb + 3] : parts[parts.length - 1];
    return name ? decodeURIComponent(name) : null;
  } catch {
    return null;
  }
}

// ── HTML: JSON-LD and icon links (pure) ──────────────────────────────────────

export type LogoCandidate = { url: string; source: "official-jsonld" | "official-icon"; note: string; declaredPx?: number | null; svgHint?: boolean; icon?: boolean };
export type CandidateRejection = { url: string | null; source: LogoSource; reason: string };

const ORG_TYPES = new Set(["organization", "corporation", "brand", "onlinestore", "onlinebusiness", "store", "localbusiness", "electronicsstore", "company"]);

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/gi, "/")
    .replace(/&amp;/g, "&");
}

function typesOf(node: Record<string, unknown>): string[] {
  const t = node["@type"];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === "string").map((x) => x.replace(/^.*[/#]/, "").toLowerCase());
}

function absolute(raw: string, base: string): string | null {
  try {
    return new URL(decodeEntities(raw.trim()), base).toString();
  } catch {
    return null;
  }
}

/** JSON-LD blocks of a page (invalid blocks skipped). */
export function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const text = m[1].replace(/^\s*<!--/, "").replace(/-->\s*$/, "").replace(/^\s*\/\/<!\[CDATA\[/, "").replace(/\/\/\]\]>\s*$/, "").trim();
    if (!text) continue;
    try {
      out.push(JSON.parse(text));
    } catch {
      try {
        out.push(JSON.parse(decodeEntities(text)));
      } catch {
        /* not JSON */
      }
    }
  }
  return out;
}

/**
 * JSON-LD Organization/Brand logos for the brand (string, ImageObject.url/contentUrl, or an @id
 * reference into @graph). Organizations whose name is not the brand (a parent company, a retailer,
 * a sub-brand) or whose url is off the brand's domain are rejected with a reason.
 */
export function extractJsonLdLogos(html: string, pageUrl: string, brand: { name: string; officialDomain: string }): { candidates: LogoCandidate[]; rejected: CandidateRejection[] } {
  const nodes: Record<string, unknown>[] = [];
  const byId = new Map<string, Record<string, unknown>>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 200)) walk(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    nodes.push(o);
    if (typeof o["@id"] === "string") byId.set(o["@id"], { ...(byId.get(o["@id"]) ?? {}), ...o });
    for (const [k, x] of Object.entries(o)) if (k !== "@context") walk(x, depth + 1);
  };
  for (const b of jsonLdBlocks(html)) walk(b, 0);

  const candidates: LogoCandidate[] = [];
  const rejected: CandidateRejection[] = [];
  const seen = new Set<string>();
  const logoUrls = (logo: unknown, depth = 0): string[] => {
    if (depth > 3 || logo == null) return [];
    if (typeof logo === "string") return [logo];
    if (Array.isArray(logo)) return logo.flatMap((x) => logoUrls(x, depth + 1));
    if (typeof logo === "object") {
      const o = logo as Record<string, unknown>;
      const direct = [o.url, o.contentUrl].filter((x): x is string => typeof x === "string");
      if (direct.length) return direct;
      if (typeof o["@id"] === "string") {
        const ref = byId.get(o["@id"]);
        if (ref && ref !== o) return logoUrls({ url: ref.url, contentUrl: ref.contentUrl }, depth + 1);
        // An @id that is itself the image URL.
        if (/\.(svg|png|webp|jpe?g)(\?|$)/i.test(o["@id"])) return [o["@id"]];
      }
    }
    return [];
  };

  for (const n of nodes) {
    if (!typesOf(n).some((t) => ORG_TYPES.has(t))) continue;
    if (n.logo === undefined) continue;
    const merged = typeof n["@id"] === "string" ? { ...(byId.get(n["@id"]) ?? {}), ...n } : n;
    const names = [merged.name, merged.legalName, merged.alternateName].flat().filter((x): x is string => typeof x === "string");
    const nameMatch = names.map((x) => brandNameMatch(brand.name, x)).find(Boolean) ?? null;
    const urls = logoUrls(merged.logo).map((u) => absolute(u, pageUrl)).filter((u): u is string => Boolean(u));
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      if (!nameMatch) {
        rejected.push({ url, source: "official-jsonld", reason: names.length ? `JSON-LD ${typesOf(n)[0] ?? "Organization"} "${names[0].slice(0, 60)}" is not ${brand.name} (parent, retailer or other brand)` : "JSON-LD logo has no organization name to confirm the brand" });
        continue;
      }
      const orgUrl = typeof merged.url === "string" ? absolute(merged.url, pageUrl) : null;
      if (orgUrl) {
        const host = (() => {
          try {
            return new URL(orgUrl).hostname;
          } catch {
            return "";
          }
        })();
        const want = registrableDomain(hostOfDomain(brand.officialDomain).replace(/:\d+$/, ""));
        if (registrableDomain(host) !== want && !(config.allowLoopbackForTests() && isLoopbackHost(host))) {
          rejected.push({ url, source: "official-jsonld", reason: `JSON-LD organization url ${host} is not the brand's domain ${want}` });
          continue;
        }
      }
      candidates.push({ url, source: "official-jsonld", note: `JSON-LD ${typesOf(n)[0] ?? "organization"} "${names[0]?.slice(0, 60) ?? brand.name}" logo${nameMatch === "store" ? " (the company this store belongs to)" : ""}` });
    }
  }
  return { candidates, rejected };
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}

/** Largest declared size in a `sizes` attribute ("180x180", "16x16 32x32", "any" → null). */
export function declaredIconPx(sizes: string | undefined): number | null {
  let best: number | null = null;
  for (const m of (sizes ?? "").matchAll(/(\d+)\s*[xX×]\s*(\d+)/g)) {
    const px = Math.min(Number(m[1]), Number(m[2]));
    if (!best || px > best) best = px;
  }
  return best;
}

/**
 * Icon candidates from <link> tags, best first: SVG icons, apple-touch-icons (largest first), PNG/WebP
 * icons declared ≥ 96 px, undeclared PNG icons (decoded size checked later), then the Safari
 * mask-icon (SVG). .ico files and icons declared under 96 px are skipped with a reason.
 */
export function extractIconCandidates(html: string, pageUrl: string): { candidates: LogoCandidate[]; rejected: CandidateRejection[] } {
  const head = html.slice(0, 600_000);
  type Ranked = LogoCandidate & { rank: number };
  const ranked: Ranked[] = [];
  const rejected: CandidateRejection[] = [];
  const seen = new Set<string>();
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const rel = (a.rel ?? "").toLowerCase().split(/\s+/);
    if (!a.href) continue;
    const isApple = rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed");
    const isMask = rel.includes("mask-icon");
    const isIcon = rel.includes("icon");
    if (!isApple && !isMask && !isIcon) continue;
    const url = absolute(a.href, pageUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const path = (() => {
      try {
        return new URL(url).pathname.toLowerCase();
      } catch {
        return "";
      }
    })();
    const svg = (a.type ?? "").toLowerCase() === "image/svg+xml" || path.endsWith(".svg");
    const ico = (a.type ?? "").toLowerCase().includes("icon") || path.endsWith(".ico");
    const px = declaredIconPx(a.sizes);
    if (ico && !svg) {
      rejected.push({ url, source: "official-icon", reason: ".ico favicon (not an accepted logo format)" });
      continue;
    }
    if (isMask) {
      if (svg) ranked.push({ url, source: "official-icon", note: "Safari mask-icon (SVG)", svgHint: true, icon: true, declaredPx: null, rank: 4 });
      continue;
    }
    if (svg) {
      ranked.push({ url, source: "official-icon", note: `${isApple ? "apple-touch-icon" : "icon"} (SVG)`, svgHint: true, icon: true, declaredPx: null, rank: 0 });
      continue;
    }
    if (px !== null && px < ICON_MIN_PX) {
      rejected.push({ url, source: "official-icon", reason: `icon declared ${px} px (under ${ICON_MIN_PX} px)` });
      continue;
    }
    if (isApple) ranked.push({ url, source: "official-icon", note: `apple-touch-icon${px ? ` ${px} px` : ""}`, declaredPx: px, icon: true, rank: 1 - (px ?? 180) / 10_000 });
    else if (px) ranked.push({ url, source: "official-icon", note: `icon ${px} px`, declaredPx: px, icon: true, rank: 2 - px / 10_000 });
    else ranked.push({ url, source: "official-icon", note: "icon (size not declared)", declaredPx: null, icon: true, rank: 3 });
  }
  ranked.sort((x, y) => x.rank - y.rank);
  return { candidates: ranked.map((c) => ({ url: c.url, source: c.source, note: c.note, declaredPx: c.declaredPx, svgHint: c.svgHint, icon: c.icon })), rejected };
}

// ── Image checks (pure) ─────────────────────────────────────────────────────

export type ImageFormat = { mime: "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml"; width: number; height: number };

const svgLength = (v: string | undefined): number | null => {
  if (!v) return null;
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*(px)?$/i);
  return m ? Number(m[1]) : null;
};

/** Root <svg> element attributes, or null when the text is not an SVG document. */
function svgRoot(text: string): Record<string, string> | null {
  const m = text.slice(0, 200_000).match(/<svg\b[^>]*>/i);
  return m ? attrs(m[0]) : null;
}

/** Dimensions of an SVG: its viewBox (preferred) or numeric width/height. Null when it has neither. */
export function svgDimensions(text: string): { width: number; height: number } | null {
  const a = svgRoot(text);
  if (!a) return null;
  const vb = (a.viewbox ?? "").trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) return { width: Math.round(vb[2] * 100) / 100, height: Math.round(vb[3] * 100) / 100 };
  const w = svgLength(a.width);
  const h = svgLength(a.height);
  return w && h ? { width: w, height: h } : null;
}

/**
 * Why an SVG is unsafe to keep, or null when it is safe. We only render logos through <img> (scripts
 * never run there), but a logo that carries script, event handlers, external references or entity
 * declarations is not a plain logo file and is rejected rather than cleaned.
 */
export function svgUnsafeReason(text: string): string | null {
  if (/<script\b/i.test(text)) return "SVG contains <script>";
  if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(text)) return "SVG contains an on* event attribute";
  if (/<!ENTITY/i.test(text)) return "SVG declares XML entities";
  if (/<foreignObject\b/i.test(text)) return "SVG embeds foreign content";
  if (/(?:xlink:)?href\s*=\s*["']\s*(?!#|data:image\/(?:png|jpeg|gif|webp);)[^"']+["']/i.test(text)) return "SVG references an external resource (href)";
  if (/url\(\s*["']?\s*(?:https?:|\/\/|javascript:)/i.test(text)) return "SVG references an external resource (url())";
  if (/@import\b/i.test(text)) return "SVG imports external CSS";
  if (/javascript:/i.test(text)) return "SVG contains a javascript: URL";
  return null;
}

const WHITE = /^(#fff(f)?|#ffffff(ff)?|white|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\)|rgba\(\s*255\s*,\s*255\s*,\s*255\s*,[^)]*\))$/i;

/**
 * True when every colour an SVG paints with is white (a "reversed" logo for dark backgrounds): it
 * would be invisible on the neutral chip. Shapes with no fill paint black, so an SVG with a shape and
 * no colour at all is not white.
 */
export function svgIsAllWhite(text: string): boolean {
  const colours = [...text.matchAll(/(?:\b(?:fill|stroke|stop-color)\s*[=:]\s*["']?\s*)(#[0-9a-f]{3,8}|[a-z]+|rgba?\([^)]*\))/gi)].map((m) => m[1].trim()).filter((c) => !/^(none|transparent|currentcolor|inherit|url)$/i.test(c));
  if (!colours.length) return false;
  return colours.every((c) => WHITE.test(c));
}

const REVERSED_NAME = /(^|[/_.-])(white|reverse[d]?|inverse|inverted|negative|knockout|light)([/_.-]|$)/i;

/** Format and pixel size from the file's own bytes (PNG IHDR, JPEG SOFn, WebP VP8/VP8L/VP8X, SVG root). */
export function sniffImage(bytes: Buffer): ImageFormat | null {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a && bytes.toString("latin1", 12, 16) === "IHDR") {
    return { mime: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
        i += marker === 0xff ? 1 : 2;
        continue;
      }
      const len = bytes.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: "image/jpeg", height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
      }
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  if (bytes.length >= 30 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") {
    const chunk = bytes.toString("latin1", 12, 16);
    if (chunk === "VP8 " && bytes.length >= 30) return { mime: "image/webp", width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L" && bytes.length >= 25) {
      const b = bytes.readUInt32LE(21);
      return { mime: "image/webp", width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X" && bytes.length >= 30) return { mime: "image/webp", width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    return null;
  }
  const head = bytes.toString("utf8", 0, Math.min(bytes.length, 200_000)).replace(/^﻿/, "");
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg\b/i.test(head)) {
    const d = svgDimensions(head);
    return d ? { mime: "image/svg+xml", width: d.width, height: d.height } : null;
  }
  return null;
}

/** Platform default favicons (a store/site builder's own icon, shown when the site set none). */
const PLATFORM_DEFAULT = [
  { platform: "shopify.com", re: /(^|\/)(shopify[-_]?favicon|favicon[-_]?shopify)[^/]*$|\/cdn\/shop\/[^?]*\/default[-_]?favicon/i },
  { platform: "squarespace.com", re: /squarespace[^?]*\/(universal\/)?default[-_]?favicon|\/universal\/default-favicon/i },
  { platform: "wix.com", re: /(wixstatic\.com|parastorage\.com)[^?]*\/(pfavico|favicon)|wix[-_]?favicon/i },
  { platform: "", re: /(^|\/)(default[-_]?favicon|favicon[-_]?default|placeholder[-_]?(logo|icon))[^/]*$/i },
];
/** sha256 of known platform default icon files (filled from verified fetches only). */
export const PLATFORM_DEFAULT_SHA256 = new Set<string>();

/** Why `url` (or its bytes) is a platform's default icon, or null. A platform's own brand is exempt (Shopify's own icon on shopify.com). */
export function platformDefaultReason(url: string, officialDomain: string, bytes?: Buffer): string | null {
  const brand = registrableDomain(hostOfDomain(officialDomain).replace(/:\d+$/, ""));
  for (const p of PLATFORM_DEFAULT) {
    if (p.platform && p.platform === brand) continue;
    if (p.re.test(url)) return `platform default icon${p.platform ? ` (${p.platform})` : ""}, not the brand's`;
  }
  if (bytes && PLATFORM_DEFAULT_SHA256.has(createHash("sha256").update(bytes).digest("hex"))) return "platform default icon (known file)";
  return null;
}

const HERO_NAME = /(^|[/_.-])(hero|banner|og[-_]?image|share[-_]?image|social[-_]?(share|image)|header[-_]?image|background|bg[-_]|carousel|slide|lifestyle|campaign)([/_.-]|\d|$)/i;
const ALLOWED_MIME = new Set(["image/svg+xml", "image/png", "image/webp", "image/jpeg"]);

export type ImageCheck = { ok: true; format: ImageFormat; sha256: string } | { ok: false; reason: string; format?: ImageFormat };

/**
 * Validates a fetched logo file. `kind`: "logo" (JSON-LD / Wikidata logo) or "icon" (link icon:
 * SVG or ≥ 96 px). Official-site files are also checked for hero/banner photos.
 */
export function checkLogoFile(input: { url: string; contentType: string | null | undefined; bytes: Buffer; kind: "logo" | "icon"; officialDomain: string; source: LogoSource }): ImageCheck {
  const declared = (input.contentType ?? "").split(";")[0].trim().toLowerCase();
  const format = sniffImage(input.bytes);
  if (!format) {
    if (/svg/.test(declared) || /<svg\b/i.test(input.bytes.toString("utf8", 0, 4000))) return { ok: false, reason: "SVG has neither a viewBox nor a numeric width/height" };
    return { ok: false, reason: `not a decodable SVG/PNG/WebP/JPEG image (content-type ${declared || "none"})` };
  }
  if (!ALLOWED_MIME.has(declared)) return { ok: false, reason: `content-type ${declared || "none"} is not an accepted image type`, format };
  if (declared !== format.mime) return { ok: false, reason: `content-type ${declared} does not match the file (${format.mime})`, format };
  if (format.mime === "image/svg+xml") {
    const text = input.bytes.toString("utf8");
    const unsafe = svgUnsafeReason(text);
    if (unsafe) return { ok: false, reason: unsafe, format };
    if (svgIsAllWhite(text)) return { ok: false, reason: "all-white (reversed) logo: invisible on a light background", format };
  }
  try {
    if (REVERSED_NAME.test(new URL(input.url).pathname)) return { ok: false, reason: "file name marks a white/reversed logo variant (for dark backgrounds)", format };
  } catch {
    /* checked elsewhere */
  }
  if (format.width <= PIXEL_MAX_PX || format.height <= PIXEL_MAX_PX) {
    if (format.mime !== "image/svg+xml" || format.width <= 1 || format.height <= 1) return { ok: false, reason: `${format.width}×${format.height}: a tracking pixel or too small to be a logo`, format };
  }
  const platform = platformDefaultReason(input.url, input.officialDomain, input.bytes);
  if (platform) return { ok: false, reason: platform, format };
  if (format.mime !== "image/svg+xml") {
    const min = Math.min(format.width, format.height);
    const max = Math.max(format.width, format.height);
    if (input.kind === "icon" && min < ICON_MIN_PX) return { ok: false, reason: `icon is ${format.width}×${format.height} (under ${ICON_MIN_PX} px)`, format };
    if (input.kind === "logo" && max < LOGO_MIN_PX) return { ok: false, reason: `logo is ${format.width}×${format.height} (too small)`, format };
    if (input.source !== "wikidata-commons") {
      const aspect = format.width / format.height;
      if (format.width >= 1000 && format.height >= 500) return { ok: false, reason: `${format.width}×${format.height} image: a hero/banner photo size, not a logo`, format };
      if (format.mime === "image/jpeg" && min >= 400 && aspect > 0.6 && aspect < 2.5) return { ok: false, reason: `${format.width}×${format.height} JPEG: a photo, not a logo`, format };
    }
  }
  if (input.source !== "wikidata-commons") {
    try {
      const path = new URL(input.url).pathname;
      if (HERO_NAME.test(path) && !/logo/i.test(path)) return { ok: false, reason: "file name marks a hero/banner/share image, not a logo", format };
    } catch {
      /* checked elsewhere */
    }
  }
  return { ok: true, format, sha256: createHash("sha256").update(input.bytes).digest("hex") };
}

// ── Wikidata (pure part) ─────────────────────────────────────────────────────

type WdSnak = { datavalue?: { value?: unknown } };
type WdClaim = { mainsnak?: WdSnak; rank?: string; qualifiers?: Record<string, unknown[]> };
export type WdEntity = { id: string; labels?: Record<string, { value: string }>; claims?: Record<string, WdClaim[]> };

const claimValues = (e: WdEntity, p: string) => (e.claims?.[p] ?? []).filter((c) => c.rank !== "deprecated");

/** The official-website hosts (P856) of an item. */
export function officialWebsites(e: WdEntity): string[] {
  return claimValues(e, "P856")
    .map((c) => c.mainsnak?.datavalue?.value)
    .filter((v): v is string => typeof v === "string")
    .map((v) => {
      try {
        return new URL(v).hostname.toLowerCase();
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

/** The current logo file (P154): preferred rank first, then a value without an end time (P582). */
export function logoFileOf(e: WdEntity): string | null {
  const claims = claimValues(e, "P154").filter((c) => typeof c.mainsnak?.datavalue?.value === "string");
  const current = claims.filter((c) => !c.qualifiers?.P582);
  const pick = current.find((c) => c.rank === "preferred") ?? claims.find((c) => c.rank === "preferred") ?? current[0] ?? null;
  return (pick?.mainsnak?.datavalue?.value as string | undefined) ?? null;
}

/**
 * The one Wikidata item that IS the brand: P856 on the brand's registrable domain (exact) AND the
 * English label naming the brand (exact first; a store-front brand may match its company). Two
 * equally good items → ambiguous, none used.
 */
export function pickWikidataItem(items: WdEntity[], brand: { name: string; officialDomain: string }): { item: WdEntity; file: string; match: "exact" | "store" } | { item: null; reason: string; none?: boolean } {
  const want = registrableDomain(hostOfDomain(brand.officialDomain).replace(/:\d+$/, ""));
  const ok: Array<{ item: WdEntity; match: "exact" | "store" }> = [];
  const notes: string[] = [];
  for (const e of items) {
    const label = e.labels?.en?.value ?? "";
    const hosts = officialWebsites(e);
    const onDomain = hosts.some((h) => registrableDomain(h) === want || (config.allowLoopbackForTests() && isLoopbackHost(h) && isLoopbackHost(want.replace(/:\d+$/, ""))));
    const match = brandNameMatch(brand.name, label);
    if (!onDomain) {
      if (match) notes.push(`${e.id} "${label}" official website ${hosts.join(", ") || "none"} is not ${want}`);
      continue;
    }
    if (!match) {
      notes.push(`${e.id} "${label}" is on ${want} but its label is not ${brand.name}`);
      continue;
    }
    ok.push({ item: e, match });
  }
  if (!ok.length) return notes.length ? { item: null, reason: `no Wikidata item with both the domain and the name: ${notes.slice(0, 3).join("; ")}` } : { item: null, none: true, reason: `no Wikidata item with official website on ${want} named ${brand.name}` };
  const exact = ok.filter((x) => x.match === "exact");
  const pool = exact.length ? exact : ok;
  const withLogo = pool.filter((x) => logoFileOf(x.item));
  if (!withLogo.length) return { item: null, none: true, reason: `Wikidata ${pool.map((x) => x.item.id).join(", ")} has no logo image (P154)` };
  const files = new Set(withLogo.map((x) => logoFileOf(x.item)));
  if (files.size > 1) return { item: null, reason: `ambiguous: ${withLogo.map((x) => x.item.id).join(", ")} all match ${brand.name} with different logos` };
  return { item: withLogo[0].item, file: logoFileOf(withLogo[0].item)!, match: withLogo[0].match };
}

// ── Fetching (polite, SSRF-safe) ─────────────────────────────────────────────

const lastHit = new Map<string, number>();

async function pace(url: string, minMs: number): Promise<void> {
  if (minMs <= 0) return;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return;
  }
  // Reserve the slot before waiting, so concurrent checks of one host stay ≥ minMs apart.
  const at = Math.max(Date.now(), (lastHit.get(host) ?? 0) + minMs);
  lastHit.set(host, at);
  const wait = at - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export type ResolveOptions = { paceMs?: number; robots?: Map<string, Promise<RobotsResult>> };
type RobotsResult = { ok: boolean; body: string; reason?: string };

const standardPorts = () => !config.allowLoopbackForTests();

async function get(url: string, opts: ResolveOptions, extra: { accept: string; maxBytes: number; binary?: boolean; json?: boolean }): Promise<SafeFetchResult> {
  await pace(url, opts.paceMs ?? paceMsDefault());
  return safeFetch(url, { timeoutMs: 12_000, maxRedirects: 4, readBody: true, maxBytes: extra.maxBytes, standardPortsOnly: standardPorts(), bodyEncoding: extra.binary ? "latin1" : "utf8", headers: { "User-Agent": LOGO_USER_AGENT(), Accept: extra.accept } });
}

function robotsFor(origin: string, opts: ResolveOptions): Promise<RobotsResult> {
  const cache = (opts.robots ??= new Map());
  let p = cache.get(origin);
  if (!p) {
    p = get(`${origin}/robots.txt`, opts, { accept: "text/plain,*/*;q=0.5", maxBytes: 500_000 }).then((r): RobotsResult => {
      if (r.ok) return { ok: true, body: r.body ?? "" };
      if (r.status >= 400 && r.status < 500) return { ok: true, body: "" };
      return { ok: false, body: "", reason: `robots.txt unreadable (${r.status || r.error?.kind})` };
    });
    cache.set(origin, p);
  }
  return p;
}

async function robotsAllow(url: string, opts: ResolveOptions): Promise<{ ok: true } | { ok: false; reason: string; blocked: boolean }> {
  const u = new URL(url);
  const r = await robotsFor(u.origin, opts);
  if (!r.ok) return { ok: false, reason: r.reason ?? "robots.txt unreadable", blocked: false };
  return robotsAllows(r.body, u.pathname + u.search) ? { ok: true } : { ok: false, reason: `robots.txt disallows ${u.pathname}`, blocked: true };
}

export type VerifiedLogo = { url: string; source: LogoSource; sourceUrl: string; license: string | null; width: number; height: number; mime: string; note: string };
export type LogoAttempt = { source: LogoSource; url: string | null; result: "VERIFIED" | "REJECTED" | "FAILED" | "SKIPPED"; reason: string };
export type LogoResolution = { status: LogoStatus; logo: VerifiedLogo | null; reason: string; attempts: LogoAttempt[] };

/** Fetches one candidate file and runs every check (host rule first, then robots, then the bytes). */
async function verifyFile(url: string, kind: "logo" | "icon", source: LogoSource, officialDomain: string, opts: ResolveOptions): Promise<{ ok: true; format: ImageFormat; finalUrl: string } | { ok: false; reason: string; failed: boolean }> {
  const commons = source === "wikidata-commons";
  const host = commons ? (isCommonsUpload(url) ? ({ ok: true } as const) : ({ ok: false, reason: "not a Wikimedia Commons upload URL" } as const)) : logoHostCheck(url, officialDomain);
  if (!host.ok) return { ok: false, reason: host.reason, failed: false };
  if (!commons) {
    const robots = await robotsAllow(url, opts);
    if (!robots.ok) return { ok: false, reason: robots.reason, failed: !robots.blocked };
  }
  const res = await get(url, opts, { accept: "image/svg+xml,image/png,image/webp,image/jpeg;q=0.9", maxBytes: LOGO_MAX_BYTES, binary: true });
  if (res.error?.kind === "RESPONSE_TOO_LARGE") return { ok: false, reason: `file larger than ${LOGO_MAX_BYTES / 1_000_000} MB`, failed: false };
  if (res.status !== 200 || res.body === undefined) return { ok: false, reason: `HTTP ${res.status || res.error?.kind || "error"} fetching the file`, failed: res.status === 0 || res.status >= 500 || res.status === 403 || res.status === 429 };
  // A redirect must not leave the brand's own hosts (or Commons).
  const finalHost = commons ? (isCommonsUpload(res.finalUrl) ? ({ ok: true } as const) : ({ ok: false, reason: "redirected off Wikimedia Commons" } as const)) : logoHostCheck(res.finalUrl, officialDomain);
  if (!finalHost.ok) return { ok: false, reason: `redirected: ${finalHost.reason}`, failed: false };
  const check = checkLogoFile({ url: res.finalUrl, contentType: res.headers["content-type"], bytes: Buffer.from(res.body, "latin1"), kind, officialDomain, source });
  if (!check.ok) return { ok: false, reason: check.reason, failed: false };
  return { ok: true, format: check.format, finalUrl: res.finalUrl };
}

type CommonsInfo = { url: string; mime: string; width: number; height: number; size: number; thumburl?: string; thumbwidth?: number; thumbheight?: number; descriptionurl?: string; license: string | null; categories: string };

/** Commons adds utm_* tracking to file URLs; the file is the same without them. */
const stripUtm = (u: string) => u.replace(/\?utm_[^#]*$/, "");

/**
 * Why a Commons file tagged as a logo is really a photograph (Wikidata P154 is sometimes a product or
 * storefront photo), or null. JPEG files and files categorised as camera/Flickr photos are never logos.
 */
export function commonsPhotoReason(info: { mime: string; categories: string }): string | null {
  if (info.mime === "image/jpeg") return "Commons file is a JPEG photograph, not a logo file";
  if (/\bTaken with\b|\bPhotos? taken\b|\bFlickr images\b|\bPhotographs? (of|by)\b/i.test(info.categories)) return "Commons file is categorised as a photograph, not a logo";
  return null;
}

async function commonsInfo(fileName: string, opts: ResolveOptions): Promise<CommonsInfo | null> {
  const q = new URLSearchParams({ action: "query", titles: `File:${fileName}`, prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiurlwidth: "512", format: "json" });
  const r = await get(`${COMMONS_API()}?${q}`, opts, { accept: "application/json", maxBytes: 1_000_000 });
  if (!r.ok || !r.body) return null;
  try {
    const j = JSON.parse(r.body) as { query?: { pages?: Record<string, { imageinfo?: Array<Record<string, unknown> & { extmetadata?: Record<string, { value?: string }> }> }> } };
    const info = Object.values(j.query?.pages ?? {})[0]?.imageinfo?.[0];
    if (!info || typeof info.url !== "string") return null;
    return {
      url: stripUtm(info.url),
      mime: String(info.mime ?? ""),
      width: Number(info.width) || 0,
      height: Number(info.height) || 0,
      size: Number(info.size) || 0,
      // Commons now adds utm_* tracking to thumbnail URLs; the file is the same without them.
      thumburl: typeof info.thumburl === "string" ? stripUtm(info.thumburl) : undefined,
      thumbwidth: Number(info.thumbwidth) || undefined,
      thumbheight: Number(info.thumbheight) || undefined,
      descriptionurl: typeof info.descriptionurl === "string" ? info.descriptionurl : undefined,
      license: info.extmetadata?.LicenseShortName?.value?.replace(/<[^>]+>/g, "").trim() || null,
      categories: String(info.extmetadata?.Categories?.value ?? "").slice(0, 2000),
    };
  } catch {
    return null;
  }
}

async function wdJson<T>(params: Record<string, string>, opts: ResolveOptions): Promise<T | null> {
  const r = await get(`${WIKIDATA_API()}?${new URLSearchParams({ ...params, format: "json" })}`, opts, { accept: "application/json", maxBytes: 3_000_000 });
  if (!r.ok || !r.body) return null;
  try {
    return JSON.parse(r.body) as T;
  } catch {
    return null;
  }
}

/** A Commons file as a displayable logo: the original SVG (≤ 2 MB), a raster ≤ 1024 px, else the 512 px Commons thumbnail. */
async function verifyCommonsFile(fileName: string, sourceUrl: string, officialDomain: string, opts: ResolveOptions, note: string): Promise<{ logo: VerifiedLogo } | { reason: string; failed: boolean }> {
  if (!commonsEnabled()) return { reason: "Commons lookups disabled (COMMONS_SEARCH_ENABLED=false)", failed: false };
  const info = await commonsInfo(fileName, opts);
  if (!info) return { reason: `Commons file "${fileName}" could not be read`, failed: true };
  if (!info.license || !isFreeLicence(info.license)) return { reason: `Commons file licence "${info.license ?? "unknown"}" is not a free licence`, failed: false };
  const photo = commonsPhotoReason(info);
  if (photo) return { reason: `"${fileName}": ${photo}`, failed: false };
  const svg = info.mime === "image/svg+xml";
  const useOriginal = svg ? info.size > 0 && info.size <= LOGO_MAX_BYTES : info.size <= LOGO_MAX_BYTES && Math.max(info.width, info.height) <= 1024;
  const url = useOriginal ? info.url : (info.thumburl ?? null);
  if (!url) return { reason: "Commons file too large and no thumbnail offered", failed: false };
  const v = await verifyFile(url, "logo", "wikidata-commons", officialDomain, opts);
  if (!v.ok) return { reason: `Commons file: ${v.reason}`, failed: v.failed };
  return { logo: { url: v.finalUrl, source: "wikidata-commons", sourceUrl, license: info.license, width: Math.round(v.format.width), height: Math.round(v.format.height), mime: v.format.mime, note } };
}

/**
 * Resolves a brand's official logo. Never throws for network problems (they become FAILED
 * attempts); never returns a logo that failed a check.
 */
export async function resolveBrandLogo(brand: { name: string; officialDomain: string }, opts: ResolveOptions = {}): Promise<LogoResolution> {
  const attempts: LogoAttempt[] = [];
  let failed = false;
  const origin = officialOrigin(brand.officialDomain);
  const home = `${origin}/`;

  // 1. Official site.
  const robots = await robotsAllow(home, opts);
  if (!robots.ok) {
    attempts.push({ source: "official-jsonld", url: home, result: robots.blocked ? "SKIPPED" : "FAILED", reason: robots.reason });
    if (!robots.blocked) failed = true;
  } else {
    const page = await get(home, opts, { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", maxBytes: PAGE_MAX_BYTES });
    const off = page.ok ? logoHostCheck(page.finalUrl, brand.officialDomain) : null;
    if (!page.ok || !page.body) {
      failed = true;
      attempts.push({ source: "official-jsonld", url: home, result: "FAILED", reason: `home page ${page.error ? `${page.error.kind} (HTTP ${page.status})` : `HTTP ${page.status}`}` });
    } else if (off && !off.ok) {
      attempts.push({ source: "official-jsonld", url: page.finalUrl, result: "REJECTED", reason: `home page redirected off the brand's domain (${off.reason})` });
    } else {
      const html = page.body;
      const jsonld = extractJsonLdLogos(html, page.finalUrl, brand);
      for (const r of jsonld.rejected) attempts.push({ source: r.source, url: r.url, result: "REJECTED", reason: r.reason });
      let fetched = 0;
      for (const c of jsonld.candidates) {
        const host = logoHostCheck(c.url, brand.officialDomain);
        if (!host.ok) {
          attempts.push({ source: c.source, url: c.url, result: "REJECTED", reason: host.reason });
          continue;
        }
        if (fetched++ >= MAX_JSONLD_FETCHES) break;
        const v = await verifyFile(c.url, "logo", c.source, brand.officialDomain, opts);
        if (v.ok) {
          attempts.push({ source: c.source, url: v.finalUrl, result: "VERIFIED", reason: c.note });
          return { status: "VERIFIED", logo: { url: v.finalUrl, source: c.source, sourceUrl: page.finalUrl, license: null, width: Math.round(v.format.width), height: Math.round(v.format.height), mime: v.format.mime, note: c.note }, reason: `${c.note} on ${new URL(page.finalUrl).hostname}`, attempts };
        }
        if (v.failed) failed = true;
        attempts.push({ source: c.source, url: c.url, result: v.failed ? "FAILED" : "REJECTED", reason: v.reason });
      }
      const icons = extractIconCandidates(html, page.finalUrl);
      // .ico files and icons declared under 96 px are not logo candidates at all (not a rejected logo).
      for (const r of icons.rejected) attempts.push({ source: r.source, url: r.url, result: "SKIPPED", reason: r.reason });
      fetched = 0;
      for (const c of icons.candidates) {
        const host = logoHostCheck(c.url, brand.officialDomain);
        if (!host.ok) {
          attempts.push({ source: c.source, url: c.url, result: "REJECTED", reason: host.reason });
          continue;
        }
        const platform = platformDefaultReason(c.url, brand.officialDomain);
        if (platform) {
          attempts.push({ source: c.source, url: c.url, result: "REJECTED", reason: platform });
          continue;
        }
        if (fetched++ >= MAX_ICON_FETCHES) break;
        const v = await verifyFile(c.url, "icon", c.source, brand.officialDomain, opts);
        if (v.ok) {
          attempts.push({ source: c.source, url: v.finalUrl, result: "VERIFIED", reason: c.note });
          return { status: "VERIFIED", logo: { url: v.finalUrl, source: c.source, sourceUrl: page.finalUrl, license: null, width: Math.round(v.format.width), height: Math.round(v.format.height), mime: v.format.mime, note: c.note }, reason: `${c.note} on ${new URL(page.finalUrl).hostname}`, attempts };
        }
        if (v.failed) failed = true;
        attempts.push({ source: c.source, url: c.url, result: v.failed ? "FAILED" : "REJECTED", reason: v.reason });
      }
      if (!jsonld.candidates.length && !jsonld.rejected.length && !icons.candidates.length && !icons.rejected.length) attempts.push({ source: "official-icon", url: page.finalUrl, result: "SKIPPED", reason: "home page has no JSON-LD organization logo and no icon links" });
    }
  }

  // 2. Wikidata → Commons.
  if (!wikidataEnabled()) {
    attempts.push({ source: "wikidata-commons", url: null, result: "SKIPPED", reason: "Wikidata disabled (WIKIDATA_ENABLED=false)" });
  } else {
    const found = await wdJson<{ search?: Array<{ id: string }> }>({ action: "wbsearchentities", search: brand.name, language: "en", type: "item", limit: "10" }, opts);
    if (!found) {
      failed = true;
      attempts.push({ source: "wikidata-commons", url: null, result: "FAILED", reason: "Wikidata search unavailable" });
    } else {
      const ids = (found.search ?? []).map((s) => s.id).filter((id) => /^Q\d+$/.test(id)).slice(0, 10);
      const got = ids.length ? await wdJson<{ entities?: Record<string, WdEntity> }>({ action: "wbgetentities", ids: ids.join("|"), props: "labels|claims", languages: "en" }, opts) : { entities: {} };
      if (!got) {
        failed = true;
        attempts.push({ source: "wikidata-commons", url: null, result: "FAILED", reason: "Wikidata entities unavailable" });
      } else {
        const items = ids.map((id) => got.entities?.[id]).filter((e): e is WdEntity => Boolean(e)).map((e, i) => ({ ...e, id: e.id ?? ids[i] }));
        const pick = pickWikidataItem(items, brand);
        if (!pick.item) attempts.push({ source: "wikidata-commons", url: null, result: "none" in pick && pick.none ? "SKIPPED" : "REJECTED", reason: pick.reason });
        else {
          const itemUrl = `https://www.wikidata.org/wiki/${pick.item.id}`;
          const note = `Wikidata ${pick.item.id} "${pick.item.labels?.en?.value ?? brand.name}" logo (P154)${pick.match === "store" ? " (the company this store belongs to)" : ""}`;
          const v = await verifyCommonsFile(pick.file, itemUrl, brand.officialDomain, opts, note);
          if ("logo" in v) {
            attempts.push({ source: "wikidata-commons", url: v.logo.url, result: "VERIFIED", reason: note });
            return { status: "VERIFIED", logo: v.logo, reason: `${note}, ${v.logo.license}`, attempts };
          }
          if (v.failed) failed = true;
          attempts.push({ source: "wikidata-commons", url: null, result: v.failed ? "FAILED" : "REJECTED", reason: `${pick.item.id}: ${v.reason}` });
        }
      }
    }
  }

  const rejected = attempts.filter((a) => a.result === "REJECTED");
  const status: LogoStatus = rejected.length ? "REJECTED" : failed ? "FAILED" : "NOT_FOUND";
  const reasons = attempts.filter((a) => a.result !== "VERIFIED").map((a) => `${a.source}: ${a.reason}`);
  return { status, logo: null, reason: reasons.slice(0, 6).join(" · ").slice(0, 900) || "no logo found on the official site or Wikidata", attempts };
}

// ── Admin override validation ────────────────────────────────────────────────

/**
 * Validates an admin-pasted logo URL with the same rules: on the brand's own domain (fetched and
 * checked like an official logo) or a Wikimedia Commons file (licence read from Commons).
 */
export async function validateOverrideUrl(brand: { name: string; officialDomain: string }, raw: string, opts: ResolveOptions = {}): Promise<{ ok: true; logo: VerifiedLogo } | { ok: false; reason: string }> {
  const url = raw.trim();
  if (!url || url.length > 2000) return { ok: false, reason: "Paste the full https URL of the logo file" };
  if (isCommonsUpload(url) && !config.allowLoopbackForTests()) {
    const name = commonsFileName(url);
    if (!name) return { ok: false, reason: "Could not read the Commons file name" };
    const v = await verifyCommonsFile(name, `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(name.replace(/ /g, "_"))}`, brand.officialDomain, opts, `admin override: Commons file ${name}`);
    return "logo" in v ? { ok: true, logo: { ...v.logo, source: "admin-url" } } : { ok: false, reason: v.reason };
  }
  const host = logoHostCheck(url, brand.officialDomain);
  if (!host.ok) return { ok: false, reason: `${host.reason}. Only files on the brand's official domain or Wikimedia Commons are accepted.` };
  const v = await verifyFile(url, "logo", "admin-url", brand.officialDomain, opts);
  if (!v.ok) return { ok: false, reason: v.reason };
  return { ok: true, logo: { url: v.finalUrl, source: "admin-url", sourceUrl: url, license: null, width: Math.round(v.format.width), height: Math.round(v.format.height), mime: v.format.mime, note: "admin override (official domain)" } };
}

// ── Persistence and the job ─────────────────────────────────────────────────

export const BRAND_LOGOS_TAG = "brand-logos";

function revalidateLogos(): void {
  try {
    revalidateTag(BRAND_LOGOS_TAG, { expire: 0 });
    revalidatePath("/brand/[slug]", "page");
  } catch (error) {
    log.debug("brand logo revalidation skipped (no request context)", { error: String(error).slice(0, 200) });
  }
}

type LogoFields = Pick<CommerceBrand, "logoUrl" | "logoSource" | "logoSourceUrl" | "logoLicense" | "logoWidth" | "logoHeight" | "logoMime" | "logoStatus" | "logoReason" | "logoCheckedAt" | "logoVerifiedAt">;
const CLEARED = { logoUrl: null, logoSource: null, logoSourceUrl: null, logoLicense: null, logoWidth: null, logoHeight: null, logoMime: null, logoVerifiedAt: null };

/**
 * Stores a resolution. VERIFIED → the logo and its provenance. NOT_FOUND / REJECTED → no logo (the
 * monogram shows). FAILED (a network/robots problem) keeps a previously verified logo, noting the
 * failed re-check; with no previous logo it stores FAILED (retried after a day).
 */
export async function applyLogoResolution(brand: CommerceBrand, r: LogoResolution, now = new Date()): Promise<{ changed: boolean; status: string }> {
  let data: Partial<LogoFields>;
  let shown: string;
  if (r.status === "VERIFIED" && r.logo) {
    data = { logoUrl: r.logo.url, logoSource: r.logo.source, logoSourceUrl: r.logo.sourceUrl, logoLicense: r.logo.license, logoWidth: r.logo.width, logoHeight: r.logo.height, logoMime: r.logo.mime, logoStatus: "VERIFIED", logoReason: r.reason.slice(0, 1000), logoCheckedAt: now, logoVerifiedAt: now };
    shown = "VERIFIED";
  } else if (r.status === "FAILED" && brand.logoStatus === "VERIFIED" && brand.logoUrl) {
    data = { logoCheckedAt: now, logoReason: `Re-check failed (${r.reason.slice(0, 600)}); keeping the logo verified ${brand.logoVerifiedAt?.toISOString().slice(0, 10) ?? "earlier"}` };
    shown = "VERIFIED";
  } else {
    data = { ...CLEARED, logoStatus: r.status, logoReason: r.reason.slice(0, 1000), logoCheckedAt: now };
    shown = r.status;
  }
  await db.commerceBrand.update({ where: { id: brand.id }, data });
  const changed = (data.logoUrl !== undefined && data.logoUrl !== brand.logoUrl) || shown !== (brand.logoStatus ?? null);
  await recordVerification([
    {
      entityType: "brand",
      entityId: brand.id,
      kind: "LOGO",
      result: r.status,
      reason: r.reason,
      sourceUrl: r.logo?.sourceUrl ?? officialOrigin(brand.officialDomain) + "/",
      details: { logoUrl: r.logo?.url ?? null, source: r.logo?.source ?? null, width: r.logo?.width ?? null, height: r.logo?.height ?? null, mime: r.logo?.mime ?? null, license: r.logo?.license ?? null, kept: shown === "VERIFIED" && r.status === "FAILED", attempts: r.attempts.slice(0, 10).map((a) => ({ source: a.source, result: a.result, url: a.url, reason: a.reason })) },
      checkedAt: now,
    },
  ]);
  if (changed) {
    await commerceAudit("BRAND_LOGO_UPDATED", "commerce_brand", brand.id, {
      before: { logoUrl: brand.logoUrl, logoStatus: brand.logoStatus, logoSource: brand.logoSource },
      after: { logoUrl: data.logoUrl === undefined ? brand.logoUrl : data.logoUrl, logoStatus: shown, logoSource: data.logoSource === undefined ? brand.logoSource : data.logoSource },
      metadata: { brand: brand.slug, reason: r.reason },
    });
  }
  return { changed, status: shown };
}

/** Brands due a logo check: never checked, checked over 30 days ago, or FAILED over a day ago. Locked brands never. */
export function logoDueWhere(now: Date) {
  const stale = new Date(now.getTime() - LOGO_RECHECK_DAYS * 86_400_000);
  const retry = new Date(now.getTime() - LOGO_FAILED_RETRY_HOURS * 3_600_000);
  return { enabled: true, logoLocked: false, OR: [{ logoCheckedAt: null }, { logoCheckedAt: { lt: stale } }, { logoStatus: "FAILED", logoCheckedAt: { lt: retry } }] };
}

export type BrandLogoRunResult = { status: string; reason?: string; checked: number; verified: number; notFound: number; rejected: number; failed: number; changed: number; remaining: number; results: Array<{ slug: string; status: string; source?: string | null; reason: string }> };

/** Job "brand-logos": bounded, idempotent, polite. */
export async function runBrandLogos(trigger: string, opts: { limit?: number; now?: Date; paceMs?: number; budgetMs?: number } = {}): Promise<BrandLogoRunResult> {
  const empty = { checked: 0, verified: 0, notFound: 0, rejected: 0, failed: 0, changed: 0, remaining: 0, results: [] };
  const gate = await allowed("commerce_engine");
  if (!gate.ok) return { status: "PAUSED", reason: gate.reason, ...empty };
  await ensureBrandsSeeded();
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? brandLogosPerRun();
  const deadline = Date.now() + (opts.budgetMs ?? 240_000);
  const where = logoDueWhere(now);
  const [brands, due] = await Promise.all([db.commerceBrand.findMany({ where, orderBy: [{ logoCheckedAt: { sort: "asc", nulls: "first" } }, { priority: "desc" }, { name: "asc" }], take: limit }), db.commerceBrand.count({ where })]);
  const out: BrandLogoRunResult = { status: "OK", ...empty, results: [] };
  const resolveOpts: ResolveOptions = { paceMs: opts.paceMs, robots: new Map() };
  for (const b of brands) {
    if (Date.now() > deadline) break;
    let r: LogoResolution;
    try {
      r = await resolveBrandLogo(b, resolveOpts);
    } catch (error) {
      r = { status: "FAILED", logo: null, reason: `check failed: ${String(error).slice(0, 200)}`, attempts: [] };
    }
    // Re-read: an admin may have locked the brand while it was being checked.
    const fresh = await db.commerceBrand.findUnique({ where: { id: b.id } });
    if (!fresh || fresh.logoLocked) continue;
    const applied = await applyLogoResolution(fresh, r, now);
    out.checked++;
    if (applied.changed) out.changed++;
    if (r.status === "VERIFIED") out.verified++;
    else if (r.status === "NOT_FOUND") out.notFound++;
    else if (r.status === "REJECTED") out.rejected++;
    else out.failed++;
    out.results.push({ slug: b.slug, status: r.status, source: r.logo?.source ?? null, reason: r.reason.slice(0, 200) });
  }
  out.remaining = Math.max(0, due - out.checked);
  if (out.changed) revalidateLogos();
  log.info("brand logos checked", { stage: "COMMERCE", trigger, checked: out.checked, verified: out.verified, changed: out.changed, remaining: out.remaining });
  return out;
}

/** Admin "Re-check logo": checks one brand now (a locked brand keeps its override). */
export async function recheckBrandLogo(id: string): Promise<{ ok: false; error: string } | { ok: true; status: string; reason: string; locked: boolean }> {
  const b = await db.commerceBrand.findUnique({ where: { id } });
  if (!b) return { ok: false, error: "Brand not found" };
  if (b.logoLocked) return { ok: true, status: b.logoStatus ?? "VERIFIED", reason: "Admin override is locked: unlock it to let the checker choose the logo", locked: true };
  const r = await resolveBrandLogo(b, { paceMs: 0 });
  const applied = await applyLogoResolution(b, r);
  if (applied.changed) revalidateLogos();
  return { ok: true, status: r.status, reason: r.reason, locked: false };
}

/** Admin override: validates the URL, stores it with provenance and locks it. */
export async function overrideBrandLogo(id: string, url: string): Promise<{ ok: false; error: string } | { ok: true; before: Partial<CommerceBrand>; after: Partial<CommerceBrand> }> {
  const b = await db.commerceBrand.findUnique({ where: { id } });
  if (!b) return { ok: false, error: "Brand not found" };
  const v = await validateOverrideUrl(b, url, { paceMs: 0 });
  const now = new Date();
  if (!v.ok) {
    await recordVerification([{ entityType: "brand", entityId: b.id, kind: "LOGO", result: "REJECTED", reason: `admin override rejected: ${v.reason}`, sourceUrl: url.slice(0, 2000), checkedAt: now }]);
    return { ok: false, error: `Logo not accepted: ${v.reason}` };
  }
  const data = { logoUrl: v.logo.url, logoSource: "admin-url", logoSourceUrl: v.logo.sourceUrl, logoLicense: v.logo.license, logoWidth: v.logo.width, logoHeight: v.logo.height, logoMime: v.logo.mime, logoStatus: "VERIFIED", logoReason: v.logo.note, logoCheckedAt: now, logoVerifiedAt: now, logoLocked: true };
  await db.commerceBrand.update({ where: { id }, data });
  await recordVerification([{ entityType: "brand", entityId: b.id, kind: "LOGO", result: "VERIFIED", reason: v.logo.note, sourceUrl: v.logo.sourceUrl, details: { logoUrl: v.logo.url, source: "admin-url", width: v.logo.width, height: v.logo.height, mime: v.logo.mime, license: v.logo.license }, checkedAt: now }]);
  revalidateLogos();
  return { ok: true, before: { logoUrl: b.logoUrl, logoStatus: b.logoStatus, logoSource: b.logoSource, logoLocked: b.logoLocked }, after: { logoUrl: data.logoUrl, logoStatus: data.logoStatus, logoSource: data.logoSource, logoLocked: true } };
}

/** Admin "Unlock": the job may choose the logo again (checked on its next run). The current logo stays until then. */
export async function unlockBrandLogo(id: string): Promise<{ ok: false; error: string } | { ok: true; name: string }> {
  const b = await db.commerceBrand.findUnique({ where: { id } });
  if (!b) return { ok: false, error: "Brand not found" };
  await db.commerceBrand.update({ where: { id }, data: { logoLocked: false, logoCheckedAt: null } });
  return { ok: true, name: b.name };
}
