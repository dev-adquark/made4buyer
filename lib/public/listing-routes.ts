/**
 * Cacheable listing pages (category, /reviews, /guides, /coupons, /match, /compare, /search).
 *
 * The public URLs keep their query strings (`/category/laptops?brand=dell&page=2`). The default,
 * unfiltered view of each page is a static (ISR) page that never reads the query string. A request
 * that carries a filter is rewritten by `proxy.ts` (the URL in the browser does not change) to an
 * internal route:
 *   - a filter state with a small, bounded value space (facet slugs, content type, page number) to
 *     an ISR route keyed by the normalized state, `…/v/<state>`, cached like the default view;
 *   - free text (`q`) or product ids (compare, which shows live prices) to a per-request route,
 *     `…/q?<original query>`, exactly as before.
 * Normalization here mirrors what each page did with `searchParams`, including the noindex rule
 * (decided on the raw query: `?type=bogus` is noindexed although it lists everything).
 *
 * Pure functions: shared by proxy.ts, the pages and the unit tests.
 */

/** Raw query access: Next.js `searchParams` objects and URLSearchParams both work. */
export type RawQuery = URLSearchParams | Record<string, string | string[] | undefined>;

/** A repeated key reads as its values joined by commas (what the previous `String(array)` coercion produced). */
export function rawParam(q: RawQuery, key: string): string | undefined {
  if (q instanceof URLSearchParams) {
    const all = q.getAll(key);
    return all.length === 0 ? undefined : all.length === 1 ? all[0] : all.join(",");
  }
  const v = q[key];
  return Array.isArray(v) ? v.join(",") : v;
}

export const SLUG_RE = /^[a-z0-9-]{1,60}$/;
export const cleanSlug = (v?: string) => (v && SLUG_RE.test(v) ? v : undefined);
export const clampPage = (raw?: string) => Math.max(1, Math.min(500, Number(raw) || 1));
const rawNoindexPage = (raw?: string) => Boolean(raw && raw !== "1");

// ---------------------------------------------------------------------------------------------
// State codec: `key.value~key.value~flag`, in a fixed key order. Values are slugs or numbers, so the
// segment needs no URL encoding and every state has exactly one spelling (one cache entry).

type Entries = Array<[string, string | number | boolean | undefined | null]>;

function encodeEntries(entries: Entries): string {
  return entries
    .filter(([, v]) => v !== undefined && v !== null && v !== false && v !== "")
    .map(([k, v]) => (v === true ? k : `${k}.${v}`))
    .join("~");
}

/** Route params may arrive percent-encoded (`%7E`); states compare in decoded form. */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function decodeEntries(raw: string): Map<string, string> | null {
  const segment = decodeSegment(raw);
  if (segment === null) return null;
  const map = new Map<string, string>();
  if (!segment) return map;
  for (const part of segment.split("~")) {
    const dot = part.indexOf(".");
    const [k, v] = dot === -1 ? [part, "1"] : [part.slice(0, dot), part.slice(dot + 1)];
    if (!/^[a-z]{1,12}$/.test(k) || map.has(k)) return null;
    map.set(k, v);
  }
  return map;
}

// ---------------------------------------------------------------------------------------------
// Category

export const CATEGORY_FILTER_KEYS = ["sub", "brand", "intent", "platform", "tier"] as const;
export type CategoryFilterKey = (typeof CATEGORY_FILTER_KEYS)[number];
export const CATEGORY_TYPES = [
  { param: "review", label: "Reviews", kinds: ["REVIEW"] },
  { param: "comparison", label: "Comparisons", kinds: ["COMPARISON"] },
  { param: "guide", label: "Guides", kinds: ["BUYING_GUIDE", "AI_GUIDE"] },
] as const;
export type CategoryType = (typeof CATEGORY_TYPES)[number];

export type CategoryState = {
  active: Record<CategoryFilterKey, string | undefined>;
  /** Free-text search within the category (trimmed, at most 80 characters). Only the per-request route has one. */
  q: string;
  page: number;
  type: CategoryType | undefined;
  /** Filtered or paged listing (decided on the raw query): not indexed. */
  noindex: boolean;
};

export function parseCategoryQuery(query: RawQuery): CategoryState {
  const get = (k: string) => rawParam(query, k);
  const active = Object.fromEntries(CATEGORY_FILTER_KEYS.map((k) => [k, cleanSlug(get(k))])) as CategoryState["active"];
  const noindex = CATEGORY_FILTER_KEYS.some((k) => get(k)) || Boolean(get("q")) || Boolean(get("type")) || rawNoindexPage(get("page"));
  return { active, q: (get("q") ?? "").trim().slice(0, 80), page: clampPage(get("page")), type: CATEGORY_TYPES.find((t) => t.param === get("type")), noindex };
}

export const DEFAULT_CATEGORY_STATE: CategoryState = parseCategoryQuery({});

export function encodeCategoryState(s: CategoryState): string {
  return encodeEntries([...CATEGORY_FILTER_KEYS.map((k) => [k, s.active[k]] as [string, string | undefined]), ["type", s.type?.param], ["page", s.page > 1 ? s.page : undefined], ["noindex", s.noindex]]);
}

export function decodeCategoryState(segment: string): CategoryState | null {
  const m = decodeEntries(segment);
  if (!m) return null;
  const known = new Set<string>([...CATEGORY_FILTER_KEYS, "type", "page", "noindex"]);
  if ([...m.keys()].some((k) => !known.has(k))) return null;
  const state: CategoryState = {
    active: Object.fromEntries(CATEGORY_FILTER_KEYS.map((k) => [k, cleanSlug(m.get(k))])) as CategoryState["active"],
    q: "",
    page: clampPage(m.get("page")),
    type: CATEGORY_TYPES.find((t) => t.param === m.get("type")),
    noindex: m.has("noindex"),
  };
  // One spelling per state: anything that does not round-trip is not a state this site links to.
  return encodeCategoryState(state) === decodeSegment(segment) ? state : null;
}

// ---------------------------------------------------------------------------------------------
// /reviews

export const REVIEW_TYPES = [
  { value: null, param: null, label: "Everything" },
  { value: "REVIEW", param: "review", label: "Reviews" },
  { value: "COMPARISON", param: "comparison", label: "Comparisons" },
  { value: "GUIDE", param: "guide", label: "Guides" },
] as const;
export type ReviewType = (typeof REVIEW_TYPES)[number];
export type ReviewsState = { page: number; type: ReviewType; noindex: boolean };

export function parseReviewsQuery(query: RawQuery): ReviewsState {
  const type = rawParam(query, "type");
  const page = rawParam(query, "page");
  return { page: clampPage(page), type: REVIEW_TYPES.find((t) => t.param && t.param === type) ?? REVIEW_TYPES[0], noindex: Boolean(type) || rawNoindexPage(page) };
}

export const DEFAULT_REVIEWS_STATE: ReviewsState = parseReviewsQuery({});

export function encodeReviewsState(s: ReviewsState): string {
  return encodeEntries([["type", s.type.param], ["page", s.page > 1 ? s.page : undefined], ["noindex", s.noindex]]);
}

export function decodeReviewsState(segment: string): ReviewsState | null {
  const m = decodeEntries(segment);
  if (!m || [...m.keys()].some((k) => !["type", "page", "noindex"].includes(k))) return null;
  const state: ReviewsState = { page: clampPage(m.get("page")), type: REVIEW_TYPES.find((t) => t.param && t.param === m.get("type")) ?? REVIEW_TYPES[0], noindex: m.has("noindex") };
  return encodeReviewsState(state) === decodeSegment(segment) ? state : null;
}

// ---------------------------------------------------------------------------------------------
// /guides

export type GuidesState = { page: number; noindex: boolean };

export function parseGuidesQuery(query: RawQuery): GuidesState {
  const page = rawParam(query, "page");
  return { page: clampPage(page), noindex: rawNoindexPage(page) };
}

export const DEFAULT_GUIDES_STATE: GuidesState = parseGuidesQuery({});

export function encodeGuidesState(s: GuidesState): string {
  return encodeEntries([["page", s.page > 1 ? s.page : undefined], ["noindex", s.noindex]]);
}

export function decodeGuidesState(segment: string): GuidesState | null {
  const m = decodeEntries(segment);
  if (!m || [...m.keys()].some((k) => !["page", "noindex"].includes(k))) return null;
  const state: GuidesState = { page: clampPage(m.get("page")), noindex: m.has("noindex") };
  return encodeGuidesState(state) === decodeSegment(segment) ? state : null;
}

// ---------------------------------------------------------------------------------------------
// /match (always noindex; the answers are the state)

export const MATCH_STEPS = ["category", "intent", "platform", "tier"] as const;
export type MatchStep = (typeof MATCH_STEPS)[number];
export type MatchPicks = Partial<Record<MatchStep, string>>;

/** `isCategory` validates the category answer against the taxonomy (an unknown one is dropped). */
export function parseMatchQuery(query: RawQuery, isCategory: (slug: string) => boolean): MatchPicks {
  const picks: MatchPicks = {};
  for (const s of MATCH_STEPS) {
    const v = cleanSlug(rawParam(query, s));
    if (v) picks[s] = v;
  }
  if (picks.category && !isCategory(picks.category)) delete picks.category;
  return picks;
}

export function encodeMatchState(p: MatchPicks): string {
  return encodeEntries(MATCH_STEPS.map((s) => [s, p[s]]));
}

export function decodeMatchState(segment: string, isCategory: (slug: string) => boolean): MatchPicks | null {
  const m = decodeEntries(segment);
  if (!m || [...m.keys()].some((k) => !(MATCH_STEPS as readonly string[]).includes(k))) return null;
  const picks = parseMatchQuery(Object.fromEntries(m), isCategory);
  return encodeMatchState(picks) === decodeSegment(segment) ? picks : null;
}

// ---------------------------------------------------------------------------------------------
// /compare and /search: per request when they carry ids / a query, static otherwise.

export function parseCompareIds(query: RawQuery): string[] {
  return [...new Set((rawParam(query, "ids") ?? "").split(",").map((x) => x.trim()).filter((x) => /^[a-z0-9]{10,40}$/i.test(x)))].slice(0, 3);
}

export function searchQueryText(query: RawQuery): string {
  return (rawParam(query, "q") ?? "").trim().slice(0, 100);
}

// ---------------------------------------------------------------------------------------------
// /coupons

export type CouponsState = { page: number; noindex: boolean };

export function parseCouponsQuery(query: RawQuery): CouponsState {
  const page = rawParam(query, "page");
  return { page: clampPage(page), noindex: rawNoindexPage(page) };
}

export const DEFAULT_COUPONS_STATE: CouponsState = parseCouponsQuery({});

export function encodeCouponsState(s: CouponsState): string {
  return encodeEntries([["page", s.page > 1 ? s.page : undefined], ["noindex", s.noindex]]);
}

export function decodeCouponsState(segment: string): CouponsState | null {
  const m = decodeEntries(segment);
  if (!m || [...m.keys()].some((k) => !["page", "noindex"].includes(k))) return null;
  const state: CouponsState = { page: clampPage(m.get("page")), noindex: m.has("noindex") };
  return encodeCouponsState(state) === decodeSegment(segment) ? state : null;
}

// ---------------------------------------------------------------------------------------------
// Routing decision (proxy.ts)

/** Internal route prefixes: reachable only through the proxy's rewrite. */
export const INTERNAL_ROUTE_PATTERNS = [/^\/category\/[^/]+\/(v|q)(\/|$)/, /^\/(reviews|guides|match|coupons)\/v(\/|$)/, /^\/(compare|search)\/q\/?$/];

export type ListingRoute = { kind: "static" } | { kind: "rewrite"; pathname: string } | { kind: "blocked" };

/**
 * Where a public listing request is served from. `static`: the cached default view (the query
 * string changes nothing on it). `rewrite`: an internal route. `blocked`: a direct request for an
 * internal route (404, so internal URLs never become a second copy of a page).
 */
export function resolveListingRoute(pathname: string, query: URLSearchParams, isCategory: (slug: string) => boolean): ListingRoute {
  if (INTERNAL_ROUTE_PATTERNS.some((re) => re.test(pathname))) return { kind: "blocked" };
  const cat = /^\/category\/([^/]+)\/?$/.exec(pathname);
  if (cat) {
    const slug = cat[1];
    const s = parseCategoryQuery(query);
    if (s.q) return { kind: "rewrite", pathname: `/category/${slug}/q` };
    const seg = encodeCategoryState(s);
    return seg ? { kind: "rewrite", pathname: `/category/${slug}/v/${seg}` } : { kind: "static" };
  }
  if (pathname === "/reviews") {
    const seg = encodeReviewsState(parseReviewsQuery(query));
    return seg ? { kind: "rewrite", pathname: `/reviews/v/${seg}` } : { kind: "static" };
  }
  if (pathname === "/guides") {
    const seg = encodeGuidesState(parseGuidesQuery(query));
    return seg ? { kind: "rewrite", pathname: `/guides/v/${seg}` } : { kind: "static" };
  }
  if (pathname === "/coupons") {
    const seg = encodeCouponsState(parseCouponsQuery(query));
    return seg ? { kind: "rewrite", pathname: `/coupons/v/${seg}` } : { kind: "static" };
  }
  if (pathname === "/match") {
    const seg = encodeMatchState(parseMatchQuery(query, isCategory));
    return seg ? { kind: "rewrite", pathname: `/match/v/${seg}` } : { kind: "static" };
  }
  if (pathname === "/compare") return parseCompareIds(query).length ? { kind: "rewrite", pathname: "/compare/q" } : { kind: "static" };
  if (pathname === "/search") return searchQueryText(query) ? { kind: "rewrite", pathname: "/search/q" } : { kind: "static" };
  return { kind: "static" };
}
