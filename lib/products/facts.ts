/**
 * Field-level fact resolution. Given every value seen for a product field (each with its source and
 * observation time), decide what Made4Buyers may show and how sure it is. Accuracy over
 * completeness: stale values are never presented as current, and equal-authority disagreement
 * resolves to "conflicting" with no value rather than a guess. Pure; no I/O.
 */

import { CATEGORIES, CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";
import type { Fact, FactField, FactStatus, ResolvedFact, Volatility } from "./types";
import { SOURCE_AUTHORITY } from "./types";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Match bases that identify the exact product (not just a similar name). */
const IDENTIFIER_BASES = new Set(["gtin", "mpn", "model"]);

const HIGH_FIELDS = new Set<FactField>(["price", "listPrice", "availability", "retailer", "retailerUrl"]);
const MEDIUM_FIELDS = new Set<FactField>([
  "rating",
  "reviewCount",
  "description",
  "features",
  "compatibility",
  "pros",
  "cons",
  "officialUrl",
]);

/** How quickly a field's value goes out of date. */
export function volatility(field: FactField): Volatility {
  if (HIGH_FIELDS.has(field)) return "HIGH";
  if (MEDIUM_FIELDS.has(field)) return "MEDIUM";
  return "LOW";
}

function envNum(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Oldest a fact of this volatility may be and still be shown. Env is read at call time. */
export function maxAgeMs(v: Volatility): number {
  if (v === "HIGH") return envNum("PRODUCT_PRICE_MAX_AGE_HOURS", 48, 1, 720) * HOUR_MS;
  if (v === "MEDIUM") return 30 * DAY_MS;
  return 365 * DAY_MS;
}

function ageMs(fact: Pick<Fact, "observedAt">, now: Date): number {
  return now.getTime() - fact.observedAt.getTime();
}

function isStale(fact: Pick<Fact, "field" | "observedAt">, now: Date): boolean {
  return ageMs(fact, now) > maxAgeMs(volatility(fact.field));
}

/** True once a fact is past half its max age, so it is re-fetched before it goes stale. */
export function refreshDue(fact: Pick<Fact, "field" | "observedAt">, now: Date): boolean {
  return ageMs(fact, now) > maxAgeMs(volatility(fact.field)) / 2;
}

// ---------------------------------------------------------------------------
// Normalisation

function normText(value: string): string {
  return value
    .replace(/[™®©℠]/g, "") // before NFKC, which would expand ™ to "TM"
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Trailing legal-entity suffixes removed from brand/manufacturer names. */
const LEGAL_SUFFIX = /[\s,]+(inc|incorporated|ltd|limited|llc|gmbh|co|corp|corporation|plc|ag|s\.?a|pty|company)\.?$/;

function stripLegalSuffixes(value: string): string {
  let out = value;
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(LEGAL_SUFFIX, "").replace(/[\s,.]+$/, "");
  }
  return out;
}

const AVAILABILITY_TOKENS: Array<[RegExp, string]> = [
  [/^(pre-?order|pre-?ordered)$/, "PreOrder"],
  [/^(back-?order|backordered)$/, "BackOrder"],
  [/^(pre-?sale)$/, "PreSale"],
  [/^(sold ?out)$/, "SoldOut"],
  [/^(out ?of ?stock|unavailable|not available|currently unavailable)$/, "OutOfStock"],
  [/^(discontinued)$/, "Discontinued"],
  [/^(limited ?availability|limited stock|low stock)$/, "LimitedAvailability"],
  [/^(in ?store ?only)$/, "InStoreOnly"],
  [/^(online ?only)$/, "OnlineOnly"],
  [/^(in ?stock|available|available now)$/, "InStock"],
];

/** Map free-text or schema.org URLs to a schema.org ItemAvailability token. */
function normAvailability(value: string): string {
  const text = normText(value)
    .replace(/^https?:\/\/(www\.)?schema\.org\//, "")
    .replace(/[_]/g, " ");
  for (const [pattern, token] of AVAILABILITY_TOKENS) if (pattern.test(text)) return token;
  return text;
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function toNumber(value: string | number | string[]): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[,\s]/g, "").replace(/^[^\d.-]+/, "");
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

type Quantity = { amount: number; dimension: "mass" | "volume"; base: number };

/** Factors to grams (mass) or millilitres (volume). Longest aliases first for the regex. */
const UNIT_FACTORS: Record<string, { dimension: Quantity["dimension"]; factor: number }> = {
  kg: { dimension: "mass", factor: 1000 },
  kilogram: { dimension: "mass", factor: 1000 },
  kilograms: { dimension: "mass", factor: 1000 },
  g: { dimension: "mass", factor: 1 },
  gram: { dimension: "mass", factor: 1 },
  grams: { dimension: "mass", factor: 1 },
  mg: { dimension: "mass", factor: 0.001 },
  lb: { dimension: "mass", factor: 453.59237 },
  lbs: { dimension: "mass", factor: 453.59237 },
  pound: { dimension: "mass", factor: 453.59237 },
  pounds: { dimension: "mass", factor: 453.59237 },
  oz: { dimension: "mass", factor: 28.349523125 },
  ounce: { dimension: "mass", factor: 28.349523125 },
  ounces: { dimension: "mass", factor: 28.349523125 },
  "fl oz": { dimension: "volume", factor: 29.5735295625 },
  l: { dimension: "volume", factor: 1000 },
  liter: { dimension: "volume", factor: 1000 },
  liters: { dimension: "volume", factor: 1000 },
  litre: { dimension: "volume", factor: 1000 },
  litres: { dimension: "volume", factor: 1000 },
  cl: { dimension: "volume", factor: 10 },
  ml: { dimension: "volume", factor: 1 },
};

/** Parse a mass/volume from a number + unit, or from text like "1.5 L" / "2.6 lbs". */
function parseQuantity(value: string | number | string[], unit: string | null | undefined): Quantity | null {
  if (Array.isArray(value)) return null;
  let amount: number | null = null;
  let unitText = unit ? normText(unit).replace(/\.$/, "") : "";
  if (typeof value === "number") {
    amount = Number.isFinite(value) ? value : null;
  } else {
    const match = normText(value).match(/^(-?\d+(?:[.,]\d+)?)\s*([a-z][a-z .]*)?$/);
    if (!match) return null;
    amount = Number.parseFloat(match[1].replace(",", "."));
    if (match[2]) unitText = match[2].replace(/\.$/, "").trim();
  }
  const def = UNIT_FACTORS[unitText];
  if (amount === null || !def) return null;
  return { amount, dimension: def.dimension, base: amount * def.factor };
}

const PRICE_FIELDS = new Set<FactField>(["price", "listPrice"]);
const QUANTITY_FIELDS = new Set<FactField>(["weight", "capacity"]);
const COMPANY_FIELDS = new Set<FactField>(["brand", "manufacturer"]);

/**
 * Canonical comparable form of a value: trimmed lowercase text without ™/®, company names without
 * legal suffixes, arrays as sorted lowercase sets, GTINs as 14 digits, availability as a schema.org
 * token, prices to 2 dp, masses/volumes in grams/millilitres when the unit is known.
 */
export function normalizeValue(
  field: FactField,
  value: string | number | string[],
  unit?: string | null,
): string | number | string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map((v) => normText(String(v))).filter(Boolean))].sort();
  }
  if (field === "gtin") {
    const digits = String(value).replace(/\D/g, "");
    return digits.length > 0 && digits.length <= 14 ? digits.padStart(14, "0") : digits;
  }
  if (field === "availability") return normAvailability(String(value));
  if (PRICE_FIELDS.has(field)) {
    const n = toNumber(value);
    return n === null ? normText(String(value)) : round(n, 2);
  }
  if (QUANTITY_FIELDS.has(field)) {
    const q = parseQuantity(value, unit);
    if (q) return round(q.base, 3);
  }
  if (field === "rating") {
    const n = toNumber(value);
    return n === null ? normText(String(value)) : round(n, 2);
  }
  if (field === "reviewCount") {
    const n = toNumber(value);
    return n === null ? normText(String(value)) : Math.round(n);
  }
  if (typeof value === "number") return round(value, 3);
  const text = normText(value);
  return COMPANY_FIELDS.has(field) ? stripLegalSuffixes(text) : text;
}

// ---------------------------------------------------------------------------
// Agreement

/** Tokens that distinguish one variant of a product from another ("Pro", "128GB", "2nd gen", "5"). */
const VARIANT_WORDS = new Set([
  "pro",
  "plus",
  "max",
  "mini",
  "ultra",
  "lite",
  "se",
  "air",
  "xl",
  "xs",
  "neo",
  "fe",
  "edge",
  "gen",
  "generation",
  "ii",
  "iii",
  "iv",
  "mk",
  "mkii",
  "mkiii",
  "+",
]);

export function isVariantToken(token: string): boolean {
  if (VARIANT_WORDS.has(token)) return true;
  if (/\d/.test(token)) return true; // generation/version numbers, years, capacities (128gb), model codes (s24+)
  if (/\+$/.test(token)) return true;
  return false;
}

function tokens(text: string): string[] {
  return text.split(/[^a-z0-9+]+/).filter(Boolean);
}

/** Index of `needle` as a contiguous token run inside `hay`, or -1. */
function indexOfRun(hay: string[], needle: string[]): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** "Breville Barista Express" contains "Barista Express"; "Barista Express" never matches "Barista Pro". */
function namesAgree(a: string, b: string): boolean {
  if (a === b) return true;
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return false;
  if (ta.join(" ") === tb.join(" ")) return true;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const at = indexOfRun(long, short);
  if (at < 0) return false;
  const extra = [...long.slice(0, at), ...long.slice(at + short.length)];
  return extra.length > 0 && !extra.some(isVariantToken);
}

function within(a: number, b: number, tolerance: number): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale > 0 && Math.abs(a - b) / scale <= tolerance;
}

function sameNormalized(x: string | number | string[], y: string | number | string[]): boolean {
  if (Array.isArray(x) || Array.isArray(y)) {
    return Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, i) => v === y[i]);
  }
  return x === y;
}

/** Currency for a price fact: its unit, uppercased; null when unstated. */
function currencyOf(fact: Fact): string | null {
  return fact.unit ? fact.unit.trim().toUpperCase() || null : null;
}

/**
 * Whether two facts state the same value. Prices: same currency (both unstated counts as same) and
 * within 1%. Weight/capacity: within 2% when both units are convertible mass or volume units.
 * Product names/models: equal, or one contains the other with only non-variant extra words.
 */
export function valuesAgree(field: FactField, a: Fact, b: Fact): boolean {
  if (PRICE_FIELDS.has(field)) {
    if (currencyOf(a) !== currencyOf(b)) return false;
    const x = toNumber(a.value);
    const y = toNumber(b.value);
    return x !== null && y !== null && within(x, y, 0.01);
  }
  if (QUANTITY_FIELDS.has(field)) {
    const qa = parseQuantity(a.value, a.unit);
    const qb = parseQuantity(b.value, b.unit);
    if (qa && qb) return qa.dimension === qb.dimension && within(qa.base, qb.base, 0.02);
  }
  const na = normalizeValue(field, a.value, a.unit);
  const nb = normalizeValue(field, b.value, b.unit);
  if (sameNormalized(na, nb)) return true;
  if ((field === "productName" || field === "model") && typeof na === "string" && typeof nb === "string") {
    return namesAgree(na, nb);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Resolution

type Group = { facts: Fact[]; authority: number; newest: number };

function authorityOf(fact: Fact): number {
  return SOURCE_AUTHORITY[fact.source] ?? 0;
}

function host(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function isIdentified(fact: Fact): boolean {
  return IDENTIFIER_BASES.has(fact.matchBasis.toLowerCase());
}

function describeAge(ms: number): string {
  return ms < 2 * DAY_MS ? `${Math.floor(ms / HOUR_MS)} h` : `${Math.floor(ms / DAY_MS)} days`;
}

function describeValue(fact: Fact): string {
  const v = Array.isArray(fact.value) ? fact.value.join(", ") : String(fact.value);
  return fact.unit ? `${v} ${fact.unit}` : v;
}

function describeGroup(group: Group): string {
  const sources = [...new Set(group.facts.map((f) => f.sourceName))].join(", ");
  return `${describeValue(group.facts[0])} (${sources})`;
}

/** Most authoritative, then most recent first. */
function byAuthorityThenRecency(a: Fact, b: Fact): number {
  return authorityOf(b) - authorityOf(a) || b.observedAt.getTime() - a.observedAt.getTime();
}

/** Cluster facts that agree with each group's first (strongest) member. */
function groupFacts(field: FactField, facts: Fact[]): Group[] {
  const groups: Fact[][] = [];
  for (const fact of [...facts].sort(byAuthorityThenRecency)) {
    const home = groups.find((g) => valuesAgree(field, g[0], fact));
    if (home) home.push(fact);
    else groups.push([fact]);
  }
  return groups.map((g) => ({
    facts: g,
    authority: Math.max(...g.map(authorityOf)),
    newest: Math.max(...g.map((f) => f.observedAt.getTime())),
  }));
}

function result(
  field: FactField,
  status: FactStatus,
  chosen: Fact | null,
  all: Fact[],
  note: string,
  showValue: boolean,
): ResolvedFact {
  return {
    field,
    status,
    value: showValue && chosen ? chosen.value : null,
    unit: showValue && chosen ? (chosen.unit ?? null) : null,
    chosen,
    alternatives: all.filter((f) => f !== chosen),
    note,
  };
}

/**
 * Resolve one field from every fact seen for it. Stale facts are dropped; agreeing facts are grouped;
 * the group with the strongest source wins unless an equal or near-equal authority disagrees.
 */
export function resolveField(field: FactField, facts: Fact[], now: Date): ResolvedFact {
  const all = facts.filter((f) => f.field === field);
  if (!all.length) return result(field, "UNKNOWN", null, all, "no source states this", false);

  const fresh = all.filter((f) => !isStale(f, now));
  if (!fresh.length) {
    const newest = all.reduce((a, b) => (b.observedAt > a.observedAt ? b : a));
    const limit = describeAge(maxAgeMs(volatility(field)));
    return result(
      field,
      "STALE",
      newest,
      all,
      `newest ${field} is ${describeAge(ageMs(newest, now))} old (limit ${limit}); not shown as current`,
      false,
    );
  }

  const groups = groupFacts(field, fresh).sort(
    (a, b) => b.authority - a.authority || b.newest - a.newest || b.facts.length - a.facts.length,
  );
  const winner = groups[0];
  const chosen = [...winner.facts].sort(byAuthorityThenRecency)[0];
  const others = groups.slice(1);

  // Anchored: the manufacturer itself states it for an identifier-matched product.
  const anchored = winner.facts.some((f) => f.source === "MANUFACTURER" && isIdentified(f));
  const conflicts = others.filter((g) => g.authority >= winner.authority || (!anchored && winner.authority - g.authority <= 20));
  if (conflicts.length) {
    return result(
      field,
      "CONFLICTING",
      chosen,
      all,
      `sources disagree: ${[winner, ...conflicts].map(describeGroup).join(" vs ")}`,
      false,
    );
  }

  const authoritative = winner.facts.some((f) => (f.source === "MANUFACTURER" || f.source === "STRUCTURED_FEED") && isIdentified(f));
  const hosts = new Set(winner.facts.map((f) => host(f.sourceUrl)).filter((h): h is string => h !== null));
  const verified = authoritative || hosts.size >= 2;

  const parts: string[] = [];
  if (authoritative) parts.push(`${chosen.sourceName} (${chosen.source.toLowerCase()}, ${chosen.matchBasis} match)`);
  else if (hosts.size >= 2) parts.push(`${hosts.size} independent sources agree`);
  else parts.push(`single source: ${chosen.sourceName}`);
  if (winner.facts.length > 1 && authoritative) parts.push(`${winner.facts.length - 1} other source(s) agree`);
  for (const g of others) parts.push(`${[...new Set(g.facts.map((f) => f.sourceName))].join(", ")} lists ${describeValue(g.facts[0])}`);

  return result(field, verified ? "VERIFIED" : "SUPPORTED", chosen, all, parts.join("; "), true);
}

/** Resolve every field present in `facts`. */
export function resolveFacts(facts: Fact[], now: Date): Partial<Record<FactField, ResolvedFact>> {
  const byField = new Map<FactField, Fact[]>();
  for (const fact of facts) {
    const list = byField.get(fact.field);
    if (list) list.push(fact);
    else byField.set(fact.field, [fact]);
  }
  const out: Partial<Record<FactField, ResolvedFact>> = {};
  for (const [field, list] of byField) out[field] = resolveField(field, list, now);
  return out;
}

// ---------------------------------------------------------------------------
// Price tier

/** Currency of the taxonomy price bands (lib/taxonomy/definitions.ts `priceBands`). */
const BAND_CURRENCY = "USD";

/** Bands for a category slug, or for a subcategory via its parent category. */
function bandsFor(slug: string): { label: string; bands: [number, number] } | null {
  const category = CATEGORY_BY_SLUG.get(slug);
  if (category) return category.priceBands ? { label: category.name, bands: category.priceBands } : null;
  for (const c of CATEGORIES) {
    const sub = c.subcategories.find((s) => s.slug === slug);
    if (sub) return c.priceBands ? { label: sub.name, bands: c.priceBands } : null;
  }
  return null;
}

function usd(n: number): string {
  return `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

/**
 * Price tier from the taxonomy's USD bands (same ≤ boundaries as lib/taxonomy/classify.ts), only for a
 * current (non-stale) USD price in a category that defines bands. Null otherwise; never estimated.
 */
export function priceTier(
  input: { price: number | null; currency: string | null; categorySlug: string | null; observedAt: Date | null },
  now: Date,
): { tier: string; methodology: string } | null {
  const { price, currency, categorySlug, observedAt } = input;
  if (price === null || !Number.isFinite(price) || price < 0) return null;
  if (!currency || currency.trim().toUpperCase() !== BAND_CURRENCY) return null;
  if (!categorySlug || !observedAt) return null;
  const age = now.getTime() - observedAt.getTime();
  if (age > maxAgeMs("HIGH")) return null;
  const def = bandsFor(categorySlug);
  if (!def) return null;

  const [budgetMax, midMax] = def.bands;
  const tier = price <= budgetMax ? "budget" : price <= midMax ? "mid-range" : "premium";
  const methodology =
    `${BAND_CURRENCY} ${price.toFixed(2)} observed ${observedAt.toISOString().slice(0, 10)} against ${def.label} bands: ` +
    `budget ≤ ${usd(budgetMax)}, mid-range ≤ ${usd(midMax)}, premium > ${usd(midMax)}`;
  return { tier, methodology };
}

// ---------------------------------------------------------------------------
// Completeness

const USABLE: ReadonlySet<FactStatus> = new Set(["VERIFIED", "SUPPORTED", "NOT_APPLICABLE"]);

/** Which applicable fields are missing, conflicting or stale. MISSING = nothing usable at all. */
export function completeness(
  resolved: Partial<Record<FactField, ResolvedFact>>,
  applicable: FactField[],
): { status: "COMPLETE" | "PARTIAL" | "MISSING"; missing: FactField[]; conflicting: FactField[]; stale: FactField[] } {
  const missing: FactField[] = [];
  const conflicting: FactField[] = [];
  const stale: FactField[] = [];
  let usable = 0;
  for (const field of applicable) {
    const r = resolved[field];
    if (!r || r.status === "UNKNOWN" || r.status === "UNAVAILABLE") missing.push(field);
    else if (r.status === "CONFLICTING") conflicting.push(field);
    else if (r.status === "STALE") stale.push(field);
    if (r && USABLE.has(r.status)) usable++;
  }
  const gaps = missing.length + conflicting.length + stale.length;
  const status = gaps === 0 ? "COMPLETE" : usable === 0 ? "MISSING" : "PARTIAL";
  return { status, missing, conflicting, stale };
}
