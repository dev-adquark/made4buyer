import { config } from "@/lib/config";
import { safeFetch } from "@/lib/net/safe-fetch";
import { tokenize } from "@/lib/util/text";
import { KNOWN_BRANDS, stripLeadingBrand } from "./brands";
import { imageTopic, photoMatchesTopic, type ImageTopic } from "./image-topics";

/**
 * Pexels image provider (https://www.pexels.com/api/). Photos are licensed under the
 * Pexels License (free commercial/editorial use); the API terms require crediting the
 * photographer and Pexels with a link, which we store as attribution + attributionUrl.
 *
 * Relevance rule: a photo is used only if its description names the product itself — at
 * least one distinctive product token (e.g. "macbook", "pixel", "wh-1000xm6") must appear,
 * and it must not name a different known brand. Generic "a laptop on a desk" photos are
 * rejected, so the page never implies a stock photo shows the reviewed product.
 */

export type PexelsPhoto = { id: number; url: string; alt: string; photographer: string; photographer_url?: string; width: number; height: number; src: { large: string; large2x: string; landscape: string } };

const GENERIC = new Set(["the", "and", "with", "for", "new", "review", "gen", "generation", "inch", "wireless", "laptop", "notebook", "phone", "smartphone", "tablet", "headphones", "earbuds", "mouse", "keyboard", "charger", "monitor", "watch", "plus", "pro", "max", "mini", "ultra", "lite", "edition", "model", "series",
  // Product-type words: a photo of "a laptop showing a VPN" is not a photo of Surfshark VPN.
  "vpn", "vpns", "app", "apps", "software", "service", "services", "cloud", "storage", "drive", "password", "manager", "browser", "editor", "platform", "tool", "tools", "api", "database", "hosting", "antivirus", "router", "speaker", "camera", "tv", "printer", "vacuum", "mattress", "chair", "desk"]);
const BRANDS_LOWER = KNOWN_BRANDS.map((b) => b.toLowerCase());

export function distinctiveTokens(productName: string, brand?: string | null): string[] {
  return [...new Set(tokenize(stripLeadingBrand(productName, brand)).filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !GENERIC.has(t) && t !== brand?.toLowerCase()))];
}

/**
 * True when the photo names a different version of the product, e.g. the product is
 * "MX Master 4" but the description says "MX Master 3": a matched token is followed by a
 * number that differs from the product's own number at that position.
 */
export function conflictingVersion(alt: string, productName: string, brand: string | null | undefined, matched: string[]): boolean {
  const product = tokenize(stripLeadingBrand(productName, brand));
  const words = alt.trim().split(" ");
  for (const t of matched) {
    const pi = product.indexOf(t);
    const ai = words.indexOf(t);
    if (pi < 0 || ai < 0) continue;
    const next = words[ai + 1];
    const want = product[pi + 1];
    if (next && /^\d/.test(next) && next !== want) return true;
  }
  return false;
}

export function pickRelevantPhoto(photos: PexelsPhoto[], productName: string, brand?: string | null): { photo: PexelsPhoto; matched: string[] } | null {
  const tokens = distinctiveTokens(productName, brand);
  if (!tokens.length) return null;
  const ownBrand = brand?.toLowerCase();
  let best: { photo: PexelsPhoto; matched: string[] } | null = null;
  for (const photo of photos) {
    const alt = ` ${tokenize(photo.alt ?? "").join(" ")} `;
    const otherBrand = BRANDS_LOWER.some((b) => b !== ownBrand && b.length >= 3 && alt.includes(` ${b} `));
    if (otherBrand) continue;
    const matched = tokens.filter((t) => alt.includes(` ${t} `));
    if (conflictingVersion(alt, productName, brand, matched)) continue;
    // Multi-word products must match at least two distinctive tokens ("visual studio code"
    // must not match a generic "screen with code" photo).
    if (matched.length >= Math.min(2, tokens.length) && (!best || matched.length > best.matched.length)) best = { photo, matched };
  }
  return best;
}

/** Whether a stored PRODUCT photo still qualifies under the current relevance rule. */
export function stillShowsProduct(alt: string, productName: string, brand?: string | null): boolean {
  return pickRelevantPhoto([{ id: 0, url: "", alt, photographer: "", width: MIN_PHOTO_WIDTH, height: 1, src: { large: "", large2x: "", landscape: "" } }], productName, brand) !== null;
}

export function pexelsConfigured(): boolean {
  return Boolean(config.images.pexelsKey());
}

export type PexelsSearchStatus = "OK" | "EMPTY" | "NOT_CONFIGURED" | "AUTH_FAILED" | "RATE_LIMITED" | "PROVIDER_ERROR" | "INVALID_RESPONSE";
export type PexelsRateLimit = { limit: number | null; remaining: number | null; resetAt: string | null };
export type PexelsSearchResult = { status: PexelsSearchStatus; httpStatus: number; query: string; photos: PexelsPhoto[]; rateLimit: PexelsRateLimit; reason?: string; fromCache?: boolean };

/** The smallest original we accept: anything below would be upscaled in a 1200px hero. */
export const MIN_PHOTO_WIDTH = 1200;

function rateLimitOf(headers: Record<string, string>): PexelsRateLimit {
  const n = (k: string) => (headers[k] !== undefined && Number.isFinite(Number(headers[k])) ? Number(headers[k]) : null);
  const reset = n("x-ratelimit-reset");
  return { limit: n("x-ratelimit-limit"), remaining: n("x-ratelimit-remaining"), resetAt: reset ? new Date(reset * 1000).toISOString() : null };
}

/** A photo record is usable only if every field we store is present and its image URL is a Pexels https URL. */
export function validPexelsPhoto(p: unknown): p is PexelsPhoto {
  const x = p as PexelsPhoto;
  if (!x || typeof x !== "object" || typeof x.id !== "number" || typeof x.url !== "string" || typeof x.photographer !== "string") return false;
  if (!x.src || typeof x.src.landscape !== "string" || typeof x.width !== "number" || typeof x.height !== "number") return false;
  return isPexelsImageUrl(x.src.landscape) && /^https:\/\/www\.pexels\.com\//.test(x.url);
}

export function isPexelsImageUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol === "https:" && u.hostname === "images.pexels.com") return true;
    // Test stubs serve images from loopback; never allowed in production.
    return config.allowLoopbackForTests() && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  } catch {
    return false;
  }
}

/**
 * One Pexels search. Results are cached per process for the run (`cache`), so one product or
 * topic costs one request however many reviews share it. A 429 is reported, never retried
 * here: the caller stops its batch until the window resets.
 */
export async function pexelsSearch(query: string, opts: { perPage?: number; orientation?: "landscape" | "portrait"; cache?: Map<string, PexelsSearchResult> } = {}): Promise<PexelsSearchResult> {
  const q = query.trim().slice(0, 80);
  const empty: PexelsRateLimit = { limit: null, remaining: null, resetAt: null };
  const key = config.images.pexelsKey();
  if (!key) return { status: "NOT_CONFIGURED", httpStatus: 0, query: q, photos: [], rateLimit: empty, reason: "PEXELS_API_KEY not configured" };
  const cacheKey = `${opts.orientation ?? "landscape"}|${opts.perPage ?? 15}|${q.toLowerCase()}`;
  const hit = opts.cache?.get(cacheKey);
  if (hit) return { ...hit, fromCache: true };
  const url = `${config.images.pexelsBaseUrl()}/search?${new URLSearchParams({ query: q, per_page: String(opts.perPage ?? 15), orientation: opts.orientation ?? "landscape" })}`;
  const res = await safeFetch(url, { headers: { Authorization: key, Accept: "application/json" }, timeoutMs: config.images.timeoutMs(), maxRedirects: 2, readBody: true, maxBytes: 2_000_000 });
  const rateLimit = rateLimitOf(res.headers ?? {});
  let out: PexelsSearchResult;
  if (res.error) out = { status: "PROVIDER_ERROR", httpStatus: 0, query: q, photos: [], rateLimit, reason: `Pexels ${res.error.kind}` };
  else if (res.status === 401 || res.status === 403) out = { status: "AUTH_FAILED", httpStatus: res.status, query: q, photos: [], rateLimit, reason: `Pexels HTTP ${res.status}` };
  else if (res.status === 429) out = { status: "RATE_LIMITED", httpStatus: 429, query: q, photos: [], rateLimit, reason: `Pexels rate limit reached${rateLimit.resetAt ? ` until ${rateLimit.resetAt}` : ""}` };
  else if (!res.ok) out = { status: "PROVIDER_ERROR", httpStatus: res.status, query: q, photos: [], rateLimit, reason: `Pexels HTTP ${res.status}` };
  else {
    let body: { photos?: unknown } | null = null;
    try {
      body = JSON.parse(res.body ?? "") as { photos?: unknown };
    } catch {
      body = null;
    }
    if (!body || !Array.isArray(body.photos)) out = { status: "INVALID_RESPONSE", httpStatus: res.status, query: q, photos: [], rateLimit, reason: "Pexels response has no photos array" };
    else {
      const photos = body.photos.filter(validPexelsPhoto);
      out = { status: photos.length ? "OK" : "EMPTY", httpStatus: res.status, query: q, photos, rateLimit, reason: photos.length ? undefined : `no usable Pexels photos for "${q}"` };
    }
  }
  // Only cache answers, not transient failures.
  if (opts.cache && (out.status === "OK" || out.status === "EMPTY")) opts.cache.set(cacheKey, out);
  return out;
}

export type PexelsImage = {
  url: string;
  width: number;
  height: number;
  subject: "PRODUCT" | "ILLUSTRATIVE";
  topic?: string;
  providerPhotoId: string;
  searchQuery: string;
  alt: string;
  attribution: string;
  attributionUrl: string;
  photographerUrl?: string;
  license: string;
};

export type PexelsLookup = { image?: PexelsImage; status: PexelsSearchStatus; reason?: string; requests: number };

/** Pexels "landscape" rendition: 1200×627 crop, the shape of our cards and hero. */
function toImage(p: PexelsPhoto, subject: PexelsImage["subject"], query: string, topic?: ImageTopic): PexelsImage {
  return {
    url: p.src.landscape,
    width: 1200,
    height: 627,
    subject,
    topic: topic?.label,
    providerPhotoId: `pexels:${p.id}`,
    searchQuery: query,
    alt: (p.alt ?? "").trim().slice(0, 200),
    attribution: `Photo by ${p.photographer} on Pexels`,
    attributionUrl: p.url,
    photographerUrl: p.photographer_url,
    license: "Pexels License (https://www.pexels.com/license/)",
  };
}

/**
 * Finds the best real Pexels photo for a review:
 *  1. a photo that shows the product itself (its description names the product), else
 *  2. an ILLUSTRATIVE photo of the review's subject (see image-topics.ts), labelled as such.
 * Photos already used by other reviews (`exclude`) are skipped where an alternative exists.
 */
export async function findPexelsImage(
  input: { productName: string; brand?: string | null; title?: string; categorySlug?: string | null; subcategorySlug?: string | null; kind?: string | null },
  opts: { exclude?: Set<string>; cache?: Map<string, PexelsSearchResult>; topic?: ImageTopic } = {},
): Promise<PexelsLookup> {
  const exclude = opts.exclude ?? new Set<string>();
  const fresh = (p: PexelsPhoto) => !exclude.has(`pexels:${p.id}`);
  const wide = (p: PexelsPhoto) => p.width >= MIN_PHOTO_WIDTH && p.width >= p.height;
  let requests = 0;
  let last: PexelsSearchResult | undefined;
  const search = async (q: string) => {
    // 30 results per query: a wider pool so every article can get its own photo.
    const r = await pexelsSearch(q, { cache: opts.cache, perPage: 30 });
    if (!r.fromCache && r.status !== "NOT_CONFIGURED") requests++;
    last = r;
    return r;
  };
  const stop = (r: PexelsSearchResult) => r.status === "NOT_CONFIGURED" || r.status === "AUTH_FAILED" || r.status === "RATE_LIMITED";

  // 1. The product itself: only a single-product review has one. A comparison or guide
  // covers several products, so its photo is always illustrative.
  if ((!input.kind || input.kind === "REVIEW") && distinctiveTokens(input.productName, input.brand).length) {
    const q = `${input.brand && !input.productName.toLowerCase().startsWith(input.brand.toLowerCase()) ? `${input.brand} ` : ""}${input.productName}`;
    const r = await search(q);
    if (stop(r)) return { status: r.status, reason: r.reason, requests };
    const usable = r.photos.filter(wide);
    // Never another article's photo (1 article = 1 image; enforced by a unique index too).
    const pick = pickRelevantPhoto(usable.filter(fresh), input.productName, input.brand);
    if (pick) return { image: toImage(pick.photo, "PRODUCT", r.query), status: "OK", requests };
  }

  // 2. An illustrative photo of the subject.
  // A caller-chosen topic (the product type of a single-product page) replaces the category topic.
  const topic = opts.topic ?? imageTopic({ title: input.title ?? input.productName, productName: input.productName, categorySlug: input.categorySlug, subcategorySlug: input.subcategorySlug });
  if (!topic) return { status: "EMPTY", reason: "no product photo, and no image topic for this category", requests };
  // The topic's queries, then the subject itself ("office chairs"), still filtered by the topic.
  const queries = [...topic.queries, ...(input.kind === "AI_GUIDE" || input.kind === "BUYING_GUIDE" ? [input.productName.toLowerCase()] : [])];
  for (const q of [...new Set(queries)]) {
    const r = await search(q);
    if (stop(r)) return { status: r.status, reason: r.reason, requests };
    const onTopic = r.photos.filter((p) => wide(p) && photoMatchesTopic(p.alt ?? "", topic));
    const unused = onTopic.find(fresh);
    if (unused) return { image: toImage(unused, "ILLUSTRATIVE", r.query, topic), status: "OK", requests };
  }
  // Every on-topic photo is already another article's image: no reuse, the caller falls back.
  return { status: last?.status === "OK" ? "EMPTY" : (last?.status ?? "EMPTY"), reason: `no on-topic Pexels photo for ${topic.label} (${topic.queries.join(" / ")})`, requests };
}

/** Backwards-compatible single lookup (go-live checks). */
export async function searchPexels(productName: string, brand?: string | null) {
  const r = await findPexelsImage({ productName, brand });
  return r.image ? { image: r.image } : { reason: r.reason };
}
