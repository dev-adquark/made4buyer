import type { CommerceBrand, Prisma } from "@prisma/client";
import seedFile from "@/data/commerce/brands.seed.json";
import { db } from "@/lib/db";
import { validateOutboundUrl } from "@/lib/net/safe-fetch";
import { CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";

/**
 * Commerce brands: the official brand sites the commerce engine reads products, prices and
 * first-party promotions from. Brands are data. The seed (data/commerce/brands.seed.json) is
 * only a starting point that admins edit in Admin → Commerce → Brands. Importing it again never
 * overwrites an admin's edits: an existing brand only has its *empty* list fields filled.
 */

export const BRAND_LIMITS = {
  maxProductsPerRun: { min: 1, max: 100 },
  crawlFrequencyHours: { min: 6, max: 720 },
  priority: { min: 0, max: 1000 },
  listItems: 20,
  notes: 1000,
} as const;

export const ARRAY_FIELDS = ["categories", "discoveryUrls", "productUrlPatterns", "promoUrls"] as const;
type ArrayField = (typeof ARRAY_FIELDS)[number];

export type BrandInput = {
  name: string;
  slug: string;
  officialDomain: string;
  market: string;
  categories: string[];
  discoveryUrls: string[];
  productUrlPatterns: string[];
  promoUrls: string[];
  enabled: boolean;
  priority: number;
  crawlFrequencyHours: number;
  maxProductsPerRun: number;
  notes: string | null;
};

/** Loose input: lists may be arrays or one-per-line text (admin textareas); numbers may be strings. */
export type BrandInputRaw = {
  [K in keyof BrandInput]?: K extends ArrayField ? string[] | string : BrandInput[K] | string | null;
};

export type BrandSeed = Pick<BrandInput, "name" | "slug" | "officialDomain" | "market" | "categories" | "discoveryUrls" | "productUrlPatterns" | "promoUrls"> & { notes?: string | null };

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

// ── Validation ───────────────────────────────────────────────────────────────

const toList = (v: string[] | string | undefined | null): string[] => {
  const items = Array.isArray(v) ? v : typeof v === "string" ? v.split(/\r?\n/) : [];
  return [...new Set(items.map((x) => String(x).trim()).filter(Boolean))];
};

const toInt = (v: unknown, fallback: number): number => {
  if (v === undefined || v === null || v === "") return fallback;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isInteger(n) ? n : NaN;
};

const toBool = (v: unknown, fallback: boolean): boolean => {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v === "boolean") return v;
  return /^(1|true|on|yes)$/i.test(String(v).trim());
};

/** "https://www.apple.com/" or "www.apple.com" → "www.apple.com". `http://` is refused (https only). */
export function normalizeDomain(raw: string): Validation<string> {
  const v = raw.trim().toLowerCase();
  if (!v) return { ok: false, error: "Official domain is required, e.g. www.example.com" };
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(v) && !v.startsWith("https://")) return { ok: false, error: "Official domain must be served over https" };
  const host = v.replace(/^https:\/\//, "").replace(/[/?#].*$/, "");
  const checked = validateOutboundUrl(`https://${host}/`, { standardPortsOnly: true });
  if (!checked.url || checked.url.host !== host) return { ok: false, error: `Official domain is not a public host name: ${raw.trim()}` };
  // A real domain name (or, only when the loopback test switch is on, a loopback test host).
  const hostname = checked.url.hostname;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname) && !/^(127\.0\.0\.1|localhost)$/.test(hostname)) {
    return { ok: false, error: `Official domain is not a valid domain name: ${raw.trim()}` };
  }
  return { ok: true, value: host };
}

/** The domain without a leading "www." — used for the brand's own subdomains (e.g. sitemaps.example.com). */
export function baseDomain(domain: string): string {
  return domain.toLowerCase().replace(/:\d+$/, "").replace(/^www\./, "");
}

/** True when the URL is on the official domain itself or one of its subdomains. */
export function onBrandDomain(url: URL, officialDomain: string): boolean {
  const official = officialDomain.toLowerCase();
  if (url.host === official) return true;
  const base = baseDomain(official);
  return url.hostname === base || url.hostname.endsWith(`.${base}`);
}

function checkUrlList(name: string, urls: string[], officialDomain: string): string | null {
  if (urls.length > BRAND_LIMITS.listItems) return `${name}: at most ${BRAND_LIMITS.listItems} entries`;
  for (const u of urls) {
    const r = validateOutboundUrl(u, { standardPortsOnly: true });
    if (!r.url || r.url.protocol !== "https:") return `${name} must be public https:// URLs: ${u}`;
    if (!onBrandDomain(r.url, officialDomain)) return `${name} must be on ${officialDomain} (or its subdomains): ${u}`;
  }
  return null;
}

/**
 * Product URL globs (`*` within a segment, `**` across segments) must be https and stay on the
 * official domain: the host part may not contain a wildcard, so a glob can never match another site.
 */
function checkPatterns(patterns: string[], officialDomain: string): string | null {
  if (patterns.length > BRAND_LIMITS.listItems) return `Product URL patterns: at most ${BRAND_LIMITS.listItems} entries`;
  const prefix = `https://${officialDomain.toLowerCase()}/`;
  for (const p of patterns) {
    if (!p.toLowerCase().startsWith(prefix)) return `Product URL pattern must start with ${prefix}: ${p}`;
    if (/\s/.test(p) || p.length > 300) return `Product URL pattern is not valid: ${p}`;
  }
  return null;
}

/** Validates admin create/update input and seed entries alike. */
export function validateBrandInput(raw: BrandInputRaw, defaults: Partial<BrandInput> = {}): Validation<BrandInput> {
  const name = String(raw.name ?? defaults.name ?? "").trim();
  const slug = String(raw.slug ?? defaults.slug ?? "").trim().toLowerCase();
  if (!name || name.length > 80) return { ok: false, error: "Name is required (max 80 characters)" };
  if (!/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(slug) || slug.length < 2) return { ok: false, error: "Slug: 2–60 lowercase letters, digits or dashes" };

  const domain = normalizeDomain(String(raw.officialDomain ?? defaults.officialDomain ?? ""));
  if (!domain.ok) return domain;
  const officialDomain = domain.value;

  const market = String(raw.market ?? defaults.market ?? "US").trim().toUpperCase() || "US";
  if (!/^[A-Z]{2}$/.test(market)) return { ok: false, error: "Market: a two-letter country code, e.g. US" };

  const list = (k: ArrayField) => (raw[k] !== undefined ? toList(raw[k]) : [...(defaults[k] ?? [])]);
  const categories = list("categories");
  if (!categories.length) return { ok: false, error: "Add at least one category" };
  if (categories.length > BRAND_LIMITS.listItems) return { ok: false, error: `Categories: at most ${BRAND_LIMITS.listItems}` };
  const unknown = categories.find((c) => !CATEGORY_BY_SLUG.has(c));
  if (unknown) return { ok: false, error: `Unknown category: ${unknown}` };

  const discoveryUrls = list("discoveryUrls");
  const productUrlPatterns = list("productUrlPatterns");
  const promoUrls = list("promoUrls");
  const urlError = checkUrlList("Discovery URLs", discoveryUrls, officialDomain) ?? checkPatterns(productUrlPatterns, officialDomain) ?? checkUrlList("Promo URLs", promoUrls, officialDomain);
  if (urlError) return { ok: false, error: urlError };

  const priority = toInt(raw.priority, defaults.priority ?? 100);
  const crawlFrequencyHours = toInt(raw.crawlFrequencyHours, defaults.crawlFrequencyHours ?? 24);
  const maxProductsPerRun = toInt(raw.maxProductsPerRun, defaults.maxProductsPerRun ?? 20);
  const L = BRAND_LIMITS;
  if (!(priority >= L.priority.min && priority <= L.priority.max)) return { ok: false, error: `Priority: a whole number ${L.priority.min}–${L.priority.max}` };
  if (!(crawlFrequencyHours >= L.crawlFrequencyHours.min && crawlFrequencyHours <= L.crawlFrequencyHours.max)) return { ok: false, error: `Crawl frequency: ${L.crawlFrequencyHours.min}–${L.crawlFrequencyHours.max} hours` };
  if (!(maxProductsPerRun >= L.maxProductsPerRun.min && maxProductsPerRun <= L.maxProductsPerRun.max)) return { ok: false, error: `Products per run: ${L.maxProductsPerRun.min}–${L.maxProductsPerRun.max}` };

  const notesRaw = raw.notes !== undefined ? raw.notes : defaults.notes;
  const notes = typeof notesRaw === "string" && notesRaw.trim() ? notesRaw.trim().slice(0, L.notes) : null;
  const enabled = toBool(raw.enabled, defaults.enabled ?? true);
  return { ok: true, value: { name, slug, officialDomain, market, categories, discoveryUrls, productUrlPatterns, promoUrls, enabled, priority, crawlFrequencyHours, maxProductsPerRun, notes } };
}

/** Admin form → validated input. Lists are textareas, one entry per line. */
export function parseBrandForm(get: (name: string) => string, defaults: Partial<BrandInput> = {}): Validation<BrandInput> {
  const raw: BrandInputRaw = {};
  for (const k of ["name", "slug", "officialDomain", "market", "priority", "crawlFrequencyHours", "maxProductsPerRun", "notes", ...ARRAY_FIELDS] as const) raw[k] = get(k);
  // Unchecked checkboxes are absent from a form post: "enabledPresent" says the field was on the form.
  raw.enabled = get("enabledPresent") ? (get("enabled") ? "true" : "false") : undefined;
  return validateBrandInput(raw, defaults);
}

// ── Seed ─────────────────────────────────────────────────────────────────────

export function readBrandSeed(data: unknown = seedFile): BrandSeed[] {
  if (!Array.isArray(data)) throw new Error("brands.seed.json: expected an array of brands");
  return data.map((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const strs = (k: string) => (Array.isArray(o[k]) ? (o[k] as unknown[]).filter((v): v is string => typeof v === "string") : []);
    const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
    if (!s("slug") || !s("name") || !s("officialDomain")) throw new Error(`brands.seed.json: brand ${i} needs name, slug and officialDomain`);
    return { name: s("name"), slug: s("slug"), officialDomain: s("officialDomain"), market: s("market") || "US", categories: strs("categories"), discoveryUrls: strs("discoveryUrls"), productUrlPatterns: strs("productUrlPatterns"), promoUrls: strs("promoUrls"), notes: s("notes") || null };
  });
}

export type SeedImportResult = { created: number; filled: number; unchanged: number; invalid: Array<{ slug: string; error: string }>; total: number };

/**
 * Idempotent: creates brands that do not exist (by slug); for an existing brand only fills list
 * fields that are empty, so admin edits (name, domain, enabled, priority, limits, notes and any
 * non-empty list) always win. Invalid seed entries are reported, never imported.
 */
export async function importSeedBrands(seed: BrandSeed[] = readBrandSeed()): Promise<SeedImportResult> {
  const result: SeedImportResult = { created: 0, filled: 0, unchanged: 0, invalid: [], total: seed.length };
  for (const entry of seed) {
    const v = validateBrandInput(entry);
    if (!v.ok) {
      result.invalid.push({ slug: entry.slug, error: v.error });
      continue;
    }
    const b = v.value;
    const existing = await db.commerceBrand.findUnique({ where: { slug: b.slug } });
    if (!existing) {
      await db.commerceBrand.create({ data: { name: b.name, slug: b.slug, officialDomain: b.officialDomain, market: b.market, categories: b.categories, discoveryUrls: b.discoveryUrls, productUrlPatterns: b.productUrlPatterns, promoUrls: b.promoUrls, notes: b.notes } });
      result.created++;
      continue;
    }
    const fill: Partial<Record<ArrayField, string[]>> = {};
    for (const k of ARRAY_FIELDS) {
      if (!existing[k].length && b[k].length) {
        // Seed URLs are checked against the domain the admin may have changed since; never mix sites.
        const ok = k === "categories" || (k === "productUrlPatterns" ? checkPatterns(b[k], existing.officialDomain) : checkUrlList(k, b[k], existing.officialDomain)) === null;
        if (ok) fill[k] = b[k];
      }
    }
    if (Object.keys(fill).length) {
      await db.commerceBrand.update({ where: { id: existing.id }, data: fill });
      result.filled++;
    } else result.unchanged++;
  }
  return result;
}

// ── Admin mutations ──────────────────────────────────────────────────────────

export async function createBrand(input: BrandInput): Promise<Validation<CommerceBrand>> {
  const clash = await db.commerceBrand.findUnique({ where: { slug: input.slug }, select: { id: true } });
  if (clash) return { ok: false, error: `Slug ${input.slug} is already used` };
  return { ok: true, value: await db.commerceBrand.create({ data: input }) };
}

export async function updateBrand(id: string, input: BrandInput): Promise<{ ok: true; before: CommerceBrand; after: CommerceBrand } | { ok: false; error: string }> {
  const before = await db.commerceBrand.findUnique({ where: { id } });
  if (!before) return { ok: false, error: "Brand not found" };
  const clash = await db.commerceBrand.findUnique({ where: { slug: input.slug }, select: { id: true } });
  if (clash && clash.id !== id) return { ok: false, error: `Slug ${input.slug} is already used` };
  const domainChanged = before.officialDomain !== input.officialDomain;
  const after = await db.commerceBrand.update({
    where: { id },
    // A new domain has its own robots.txt: the old check no longer applies.
    data: { ...input, ...(domainChanged ? { robotsStatus: null, robotsCheckedAt: null } : {}) },
  });
  return { ok: true, before, after };
}

export async function toggleBrand(id: string) {
  const before = await db.commerceBrand.findUnique({ where: { id } });
  if (!before) return null;
  const after = await db.commerceBrand.update({ where: { id }, data: { enabled: !before.enabled } });
  return { before, after };
}

/** "Crawl next": due immediately (also lifts a failure backoff); failures are kept for the record. */
export async function crawlBrandNow(id: string, now = new Date()) {
  const before = await db.commerceBrand.findUnique({ where: { id } });
  if (!before) return null;
  const after = await db.commerceBrand.update({ where: { id }, data: { nextCrawlAt: now } });
  return { before, after };
}

// ── Queries ──────────────────────────────────────────────────────────────────

export type BrandFilter = { enabled?: boolean; category?: string; q?: string };

export function brandWhere(f: BrandFilter = {}): Prisma.CommerceBrandWhereInput {
  const where: Prisma.CommerceBrandWhereInput = {};
  if (f.enabled !== undefined) where.enabled = f.enabled;
  if (f.category) where.categories = { has: f.category };
  const q = f.q?.trim().slice(0, 80);
  if (q) where.OR = [{ name: { contains: q, mode: "insensitive" } }, { slug: { contains: q.toLowerCase() } }, { officialDomain: { contains: q.toLowerCase() } }];
  return where;
}

export function listBrands(f: BrandFilter = {}, take = 500) {
  return db.commerceBrand.findMany({ where: brandWhere(f), orderBy: [{ priority: "desc" }, { name: "asc" }], take });
}

export async function brandCounts(now = new Date()) {
  const [total, enabled, due, failing] = await Promise.all([
    db.commerceBrand.count(),
    db.commerceBrand.count({ where: { enabled: true } }),
    db.commerceBrand.count({ where: dueWhere(now) }),
    db.commerceBrand.count({ where: { consecutiveFailures: { gt: 0 } } }),
  ]);
  return { total, enabled, due, failing };
}

/** Enabled brands whose next crawl time has come (never crawled, or nextCrawlAt ≤ now). A failure backoff sets nextCrawlAt in the future, so a backed-off brand is not due. */
function dueWhere(now: Date): Prisma.CommerceBrandWhereInput {
  return { enabled: true, OR: [{ nextCrawlAt: null }, { nextCrawlAt: { lte: now } }] };
}

/** Brands to crawl now: highest priority first, then the longest-waiting (never-scheduled first). */
export function dueBrands(now = new Date(), limit = 10): Promise<CommerceBrand[]> {
  return db.commerceBrand.findMany({
    where: dueWhere(now),
    orderBy: [{ priority: "desc" }, { nextCrawlAt: { sort: "asc", nulls: "first" } }, { name: "asc" }],
    take: Math.max(1, Math.min(500, Math.floor(limit) || 1)),
  });
}
