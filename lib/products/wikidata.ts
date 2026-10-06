import { config } from "@/lib/config";
import { safeFetch } from "@/lib/net/safe-fetch";
import { brandKey, normalizeGtin, sameProduct } from "./page-extract";
import type { Fact, MatchResult, ProductIdentity } from "./types";

/**
 * Free public fallback: Wikidata (stable facts) and Wikimedia Commons (licensed product photos).
 * No key, no quota purchase. Used ONLY for stable facts — manufacturer, brand, product family,
 * release date, operating system, GTIN and a freely licensed image — never for prices, offers,
 * availability or coupons. An item is used only when it is clearly the same product: its label
 * must match the product exactly (no differing variant words) and its manufacturer/brand must
 * match a known brand; a GTIN on both sides must agree.
 */

const api = () => process.env.WIKIDATA_API_URL || "https://www.wikidata.org/w/api.php";
const commonsApi = () => process.env.COMMONS_API_URL || "https://commons.wikimedia.org/w/api.php";
/** On by default (free, no key). WIKIDATA_ENABLED=false turns the fallback off. */
export const wikidataEnabled = () => !["0", "false", "off", "no"].includes((process.env.WIKIDATA_ENABLED ?? "").trim().toLowerCase());
const HEADERS = () => ({ Accept: "application/json", "User-Agent": `Made4BuyersBot/1.0 (${config.siteUrl()}; product data enrichment)` });

/** Wikidata properties we read. */
const P = { instanceOf: "P31", manufacturer: "P176", brand: "P1716", series: "P179", os: "P306", released: "P577", gtin: "P3962", image: "P18" } as const;

/** Classes that are never a product (people, companies, places, works, software libraries…). */
const NOT_PRODUCT = new Set(["Q5", "Q4830453", "Q783794", "Q43229", "Q6881511", "Q891723", "Q515", "Q6256", "Q7725634", "Q11424", "Q482994", "Q13442814", "Q4167410"]);

type Claim = { mainsnak?: { datavalue?: { value?: unknown; type?: string } } };
type Entity = { id: string; labels?: Record<string, { value: string }>; aliases?: Record<string, Array<{ value: string }>>; claims?: Record<string, Claim[]> };

async function getJson<T>(url: string): Promise<T | null> {
  const res = await safeFetch(url, { timeoutMs: 12_000, maxRedirects: 2, readBody: true, maxBytes: 3_000_000, standardPortsOnly: true, headers: HEADERS() });
  if (!res.ok || !res.body) return null;
  try {
    return JSON.parse(res.body) as T;
  } catch {
    return null;
  }
}

const values = (e: Entity, p: string) => (e.claims?.[p] ?? []).map((c) => c.mainsnak?.datavalue?.value).filter((v) => v !== undefined && v !== null);
const ids = (e: Entity, p: string) => values(e, p).map((v) => (v as { id?: string }).id).filter((v): v is string => Boolean(v));
const label = (e: Entity | undefined) => e?.labels?.en?.value ?? null;

async function entities(qids: string[]): Promise<Map<string, Entity>> {
  const out = new Map<string, Entity>();
  for (let i = 0; i < qids.length; i += 40) {
    const batch = qids.slice(i, i + 40);
    const q = new URLSearchParams({ action: "wbgetentities", ids: batch.join("|"), props: "labels|aliases|claims", languages: "en", format: "json" });
    const r = await getJson<{ entities?: Record<string, Entity> }>(`${api()}?${q}`);
    for (const [id, e] of Object.entries(r?.entities ?? {})) out.set(id, { ...e, id });
  }
  return out;
}

/** Exact-product check for a Wikidata item, using the same strict rules as product pages. */
export function wikidataMatch(identity: ProductIdentity, item: { label: string; aliases: string[]; brands: string[]; gtin: string | null }): MatchResult {
  if (!identity.brand) return { match: false, basis: "none", reason: "no known brand to confirm the Wikidata item" };
  if (!item.brands.some((b) => brandKey(b) === brandKey(identity.brand))) return { match: false, basis: "none", reason: `Wikidata manufacturer/brand (${item.brands.join(", ") || "none"}) does not match ${identity.brand}` };
  const idGtin = normalizeGtin(identity.gtin ?? null);
  const itemGtin = normalizeGtin(item.gtin);
  if (idGtin && itemGtin) return idGtin === itemGtin ? { match: true, basis: "gtin", reason: "GTIN matches" } : { match: false, basis: "gtin", reason: "GTIN differs" };
  for (const name of [item.label, ...item.aliases]) {
    const r = sameProduct({ ...identity, gtin: null, mpn: null, sku: null, model: null }, { url: "", name, brand: item.brands[0], extractedFrom: ["wikidata"] });
    // Both directions: the item must not be a broader or a different variant of the product.
    const back = sameProduct({ name, brand: item.brands[0] }, { url: "", name: identity.name, brand: identity.brand ?? undefined, extractedFrom: ["identity"] });
    if (r.match && back.match) return { match: true, basis: "brand+name", reason: `label "${name}" matches exactly` };
  }
  return { match: false, basis: "none", reason: `no label equals "${identity.name}"` };
}

export type CommonsImage = { url: string; license: string; artist: string | null; pageUrl: string };

/** Licence and attribution of a Commons file; only freely licensed files are returned. */
export async function commonsImage(fileName: string): Promise<CommonsImage | null> {
  const q = new URLSearchParams({ action: "query", titles: `File:${fileName}`, prop: "imageinfo", iiprop: "url|extmetadata", format: "json" });
  const r = await getJson<{ query?: { pages?: Record<string, { imageinfo?: Array<{ url?: string; descriptionurl?: string; extmetadata?: Record<string, { value?: string }> }> }> } }>(`${commonsApi()}?${q}`);
  const info = Object.values(r?.query?.pages ?? {})[0]?.imageinfo?.[0];
  const license = info?.extmetadata?.LicenseShortName?.value?.trim();
  if (!info?.url || !info.descriptionurl || !license) return null;
  if (!/^https:\/\/upload\.wikimedia\.org\//.test(info.url) && !process.env.UNSAFE_ALLOW_LOOPBACK_FOR_TESTS) return null;
  // Free licences only: public domain, CC0, CC BY, CC BY-SA.
  if (!/^(public domain|pd|cc0|cc[ -]by(-sa)?)/i.test(license)) return null;
  const artist = info.extmetadata?.Artist?.value?.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || null;
  return { url: info.url, license, artist, pageUrl: info.descriptionurl };
}

/** Searches Wikidata for the exact product and returns stable facts with provenance. */
export async function wikidataFacts(identity: ProductIdentity, now = new Date()): Promise<{ facts: Fact[]; outcome: string }> {
  if (!wikidataEnabled()) return { facts: [], outcome: "WIKIDATA_DISABLED" };
  if (!identity.brand) return { facts: [], outcome: "WIKIDATA_SKIPPED: brand unknown" };
  const search = new URLSearchParams({ action: "wbsearchentities", search: `${identity.brand} ${identity.name.replace(new RegExp(`^${identity.brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+`, "i"), "")}`, language: "en", type: "item", limit: "7", format: "json" });
  const found = await getJson<{ search?: Array<{ id: string }> }>(`${api()}?${search}`);
  if (!found) return { facts: [], outcome: "WIKIDATA_UNAVAILABLE" };
  const qids = (found.search ?? []).map((s) => s.id).slice(0, 7);
  if (!qids.length) return { facts: [], outcome: "WIKIDATA_NO_ITEM" };
  const items = await entities(qids);
  const refs = new Set<string>();
  for (const e of items.values()) for (const p of [P.manufacturer, P.brand, P.series, P.os, P.instanceOf]) for (const id of ids(e, p)) refs.add(id);
  const refLabels = await entities([...refs]);
  const name = (id: string) => label(refLabels.get(id));

  let chosen: { e: Entity; m: MatchResult } | null = null;
  for (const e of items.values()) {
    if (ids(e, P.instanceOf).some((c) => NOT_PRODUCT.has(c))) continue;
    const brands = [...ids(e, P.manufacturer), ...ids(e, P.brand)].map(name).filter((v): v is string => Boolean(v));
    const gtin = values(e, P.gtin).find((v) => typeof v === "string") as string | undefined;
    const m = wikidataMatch(identity, { label: label(e) ?? "", aliases: (e.aliases?.en ?? []).map((a) => a.value), brands, gtin: gtin ?? null });
    if (m.match) {
      // Two different items both matching means we can't tell which: use neither.
      if (chosen) return { facts: [], outcome: "WIKIDATA_AMBIGUOUS" };
      chosen = { e, m };
    }
  }
  if (!chosen) return { facts: [], outcome: "WIKIDATA_NO_EXACT_MATCH" };
  const { e, m } = chosen;
  const src = { source: "WIKIDATA" as const, sourceName: "Wikidata", sourceUrl: `https://www.wikidata.org/wiki/${e.id}`, observedAt: now, matchBasis: `wikidata:${m.basis}` };
  const facts: Fact[] = [];
  const add = (field: Fact["field"], value: Fact["value"] | null | undefined, unit?: string | null) => {
    if (value === null || value === undefined || (Array.isArray(value) && !value.length) || value === "") return;
    facts.push({ field, value, unit: unit ?? null, ...src });
  };
  add("manufacturer", ids(e, P.manufacturer).map(name).find(Boolean) ?? null);
  add("brand", ids(e, P.brand).map(name).find(Boolean) ?? null);
  add("productFamily", ids(e, P.series).map(name).find(Boolean) ?? null);
  add("operatingSystem", ids(e, P.os).map(name).filter((v): v is string => Boolean(v)));
  const released = values(e, P.released)[0] as { time?: string; precision?: number } | undefined;
  // Day precision is 11, month 10, year 9: never claim more precision than Wikidata states.
  if (released?.time) {
    const t = released.time.replace(/^\+/, "");
    add("releaseDate", (released.precision ?? 9) >= 11 ? t.slice(0, 10) : (released.precision ?? 9) === 10 ? t.slice(0, 7) : t.slice(0, 4));
  }
  const gtin = values(e, P.gtin).find((v) => typeof v === "string") as string | undefined;
  add("gtin", gtin ? normalizeGtin(gtin) : null);
  const file = values(e, P.image).find((v) => typeof v === "string") as string | undefined;
  if (file) {
    const img = await commonsImage(file).catch(() => null);
    if (img) facts.push({ field: "image", value: img.url, unit: img.license, source: "WIKIDATA", sourceName: img.artist ? `${img.artist} / Wikimedia Commons` : "Wikimedia Commons", sourceUrl: img.pageUrl, observedAt: now, matchBasis: `wikidata:${m.basis}` });
  }
  return { facts, outcome: `WIKIDATA_MATCHED ${e.id} (${m.reason})` };
}
