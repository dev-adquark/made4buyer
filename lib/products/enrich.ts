import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { safeFetch } from "@/lib/net/safe-fetch";
import { checkRobots } from "@/lib/pipeline/apify";
import { isTechCategory } from "@/lib/content/calendar";
import { CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";
import { canonicalProductUrl } from "@/lib/sovrn/coupons";
import { completeness, maxAgeMs, priceTier, refreshDue, resolveFacts, volatility } from "./facts";
import { qualityScore, type QualityBand } from "./quality";
import { wikidataFacts } from "./wikidata";
import { classifySource, extractProductFromHtml, sameProduct } from "./page-extract";
import type { ExtractedProduct, Fact, FactField, ProductIdentity, ResolvedFact } from "./types";

/**
 * Autonomous product-data enrichment: discover → identify → cross-check → enrich → verify →
 * store provenance → refresh. Each field is enriched independently from every legitimate source
 * we can reach for that exact product:
 *   - the review source's own structured data (pros, cons, rating, identifiers, stated price),
 *   - product pages we already know for it: the product/offer URL the source linked and the
 *     retailer page behind a verified Sovrn offer (classified manufacturer / retailer / other),
 *   - Sovrn matched offers (structured feed: price, merchant),
 *   - Wikidata / Wikimedia Commons (free; stable facts and licensed photos only, never prices).
 * A page is used only after an exact-product check (GTIN / MPN / model, else brand + name with no
 * differing variant tokens). Nothing is guessed: a field no source states stays unknown.
 */

const ENRICH_FIELDS: FactField[] = ["brand", "productName", "model", "mpn", "sku", "gtin", "manufacturer", "description", "category", "color", "material", "weight", "dimensions", "capacity", "warranty", "compatibility", "features", "price", "listPrice", "currency", "availability", "retailer", "retailerUrl", "officialUrl", "rating", "reviewCount", "pros", "cons", "releaseDate", "operatingSystem", "productFamily", "image"];

/** Fields a reader expects for a product; platform only for tech categories. */
export function applicableFields(categorySlug: string | null): FactField[] {
  const cat = categorySlug ? CATEGORY_BY_SLUG.get(categorySlug) : undefined;
  const base: FactField[] = ["brand", "productName", "model", "price", "availability"];
  return cat && isTechCategory(cat) ? [...base, "platform"] : base;
}

type Ctx = { now: Date };

function fact(field: FactField, value: Fact["value"] | undefined | null, src: Omit<Fact, "field" | "value">, unit?: string | null): Fact | null {
  if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return { field, value, unit: unit ?? null, ...src };
}

/** Facts a page's structured data states about the product. */
export function factsFromPage(p: ExtractedProduct, src: Omit<Fact, "field" | "value">): Fact[] {
  const isOfficial = src.source === "MANUFACTURER";
  const weight = typeof p.weight === "string" ? p.weight : p.weight ? `${p.weight.value} ${p.weight.unit}` : undefined;
  return [
    fact("productName", p.name, src),
    fact("brand", p.brand, src),
    fact("manufacturer", p.manufacturer, src),
    fact("model", p.model, src),
    fact("mpn", p.mpn, src),
    fact("sku", p.sku, src),
    fact("gtin", p.gtin, src),
    fact("description", p.description, src),
    fact("category", p.category, src),
    fact("color", p.color, src),
    fact("material", p.material, src),
    fact("weight", weight, src),
    fact("dimensions", p.dimensions, src),
    fact("capacity", p.capacity, src),
    fact("warranty", p.warranty, src),
    fact("compatibility", p.compatibility, src),
    fact("features", p.features, src),
    fact("price", p.price, src, p.currency),
    fact("listPrice", p.listPrice, src, p.currency),
    fact("currency", p.currency, src),
    fact("availability", p.availability, src),
    fact("retailer", isOfficial ? undefined : p.seller ?? src.sourceName, src),
    fact(isOfficial ? "officialUrl" : "retailerUrl", src.sourceUrl, src),
    fact("rating", p.rating, src, p.ratingScale ? `/${p.ratingScale}` : null),
    fact("reviewCount", p.reviewCount, src),
  ].filter((f): f is Fact => Boolean(f));
}

async function loadEntity(id: string) {
  return db.productEntity.findUniqueOrThrow({
    where: { id },
    include: {
      facts: true,
      content: {
        where: { role: { in: ["PRIMARY", "COMPARED"] }, review: { status: "PUBLISHED", source: { not: "keyword-to-blog" } } },
        include: {
          review: {
            select: {
              id: true,
              source: true,
              brand: true,
              productName: true,
              createdAt: true,
              canonicalUrl: true,
              sourceUrl: true,
              sourceData: true,
              sourceProductUrl: true,
              sourcePrice: true,
              sourceCurrency: true,
              sourceAvailability: true,
              sourcePriceObservedAt: true,
              entities: { select: { source: true, rating: true, ratingScale: true } },
              affiliateLinks: { where: { isActive: true, verificationStatus: "VERIFIED_OK" }, select: { finalUrl: true, offerMatch: { select: { merchantName: true, price: true, currency: true, availability: true, matchStatus: true, updatedAt: true } } } },
            },
          },
        },
      },
    },
  });
}

/** What the review source itself stated (its structured data), with the crawl time as observedAt. */
function reviewFacts(e: Awaited<ReturnType<typeof loadEntity>>): Fact[] {
  const out: Fact[] = [];
  for (const link of e.content) {
    const r = link.review;
    const d = (r.sourceData ?? {}) as { pros?: string[]; cons?: string[]; identifiers?: Record<string, string>; aggregateRating?: { value?: number; count?: number; best?: number } };
    const src = { source: "REVIEW_SOURCE" as const, sourceName: r.entities?.source ?? r.source, sourceUrl: r.canonicalUrl ?? r.sourceUrl, observedAt: r.createdAt, matchBasis: "review-source" };
    // Pros, cons and the rating belong to the single product a review covers, not to compared items.
    if (link.role === "PRIMARY") {
      // The review states which product it covers: its brand and product name are source facts.
      out.push(...[fact("brand", r.brand, src), fact("productName", r.productName, src), fact("pros", d.pros, src), fact("cons", d.cons, src)].filter((f): f is Fact => Boolean(f)));
      if (r.entities?.rating != null && r.entities.ratingScale) out.push({ field: "rating", value: r.entities.rating, unit: `/${r.entities.ratingScale}`, ...src });
      const ids = d.identifiers ?? {};
      for (const [k, field] of [["gtin", "gtin"], ["mpn", "mpn"], ["sku", "sku"], ["model", "model"]] as const) {
        const f = fact(field, ids[k], src);
        if (f) out.push(f);
      }
      if (r.sourcePrice != null && r.sourcePriceObservedAt) {
        const priceSrc = { ...src, observedAt: r.sourcePriceObservedAt };
        out.push(...[fact("price", r.sourcePrice, priceSrc, r.sourceCurrency), fact("currency", r.sourceCurrency, priceSrc), fact("availability", r.sourceAvailability, priceSrc)].filter((f): f is Fact => Boolean(f)));
      }
    }
    // Sovrn matched offers whose link was verified: structured feed price and merchant.
    for (const l of r.affiliateLinks) {
      const m = l.offerMatch;
      if (!m || m.matchStatus !== "MATCHED") continue;
      const s = { source: "STRUCTURED_FEED" as const, sourceName: `Sovrn: ${m.merchantName ?? "merchant"}`, sourceUrl: l.finalUrl, observedAt: m.updatedAt, matchBasis: "sovrn-match" };
      out.push(...[fact("price", m.price, s, m.currency), fact("currency", m.currency, s), fact("availability", m.availability, s), fact("retailer", m.merchantName, s)].filter((f): f is Fact => Boolean(f)));
    }
  }
  return out;
}

/** Bump to re-enrich every product on the next run (e.g. after adding a source). */
export const ENRICHMENT_VERSION = 2;

function identityOf(e: { name: string; brand: string | null }, facts: Fact[]): ProductIdentity {
  const id = (field: FactField) => {
    const f = facts.find((x) => x.field === field && typeof x.value === "string");
    return f ? String(f.value) : null;
  };
  return { name: e.name, brand: e.brand ?? id("brand"), model: id("model"), mpn: id("mpn"), sku: id("sku"), gtin: id("gtin") };
}

/** Fetches one product page (robots.txt respected) and returns its facts if it is the same product. */
async function pageFacts(url: string, identity: ProductIdentity, brand: string | null, ctx: Ctx): Promise<{ facts: Fact[]; outcome: string }> {
  const robots = await checkRobots(url).catch(() => ({ allowed: false, reason: "robots.txt check failed" }));
  if (!robots.allowed) return { facts: [], outcome: "ROBOTS_DISALLOWED" };
  const res = await safeFetch(url, { timeoutMs: 12_000, maxRedirects: 4, readBody: true, maxBytes: 3_000_000, standardPortsOnly: true, headers: { Accept: "text/html" } });
  if (!res.ok || !res.body) return { facts: [], outcome: `FETCH_${res.status || res.error?.kind || "FAILED"}` };
  const product = extractProductFromHtml(res.body, res.finalUrl);
  if (!product) return { facts: [], outcome: "NO_STRUCTURED_PRODUCT" };
  const match = sameProduct(identity, product);
  if (!match.match) return { facts: [], outcome: `NOT_SAME_PRODUCT: ${match.reason}` };
  const source = classifySource(res.finalUrl, brand);
  const host = new URL(res.finalUrl).hostname.replace(/^www\./, "");
  return { facts: factsFromPage(product, { source, sourceName: host, sourceUrl: canonicalProductUrl(res.finalUrl) ?? res.finalUrl, observedAt: ctx.now, matchBasis: match.basis }), outcome: `MATCHED_${source}` };
}

async function saveFacts(entityId: string, facts: Fact[]) {
  for (const f of facts) {
    const sourceKey = (f.sourceUrl ?? f.sourceName).slice(0, 500);
    const data = { value: f.value as Prisma.InputJsonValue, unit: f.unit ?? null, sourceName: f.sourceName, sourceUrl: f.sourceUrl, observedAt: f.observedAt, matchBasis: f.matchBasis };
    await db.productFact.upsert({ where: { productEntityId_field_source_sourceKey: { productEntityId: entityId, field: f.field, source: f.source, sourceKey } }, create: { productEntityId: entityId, field: f.field, source: f.source, sourceKey, ...data }, update: data });
  }
}

export function toFact(row: { field: string; value: unknown; unit: string | null; source: string; sourceName: string; sourceUrl: string | null; observedAt: Date; matchBasis: string }): Fact {
  return { field: row.field as FactField, value: row.value as Fact["value"], unit: row.unit, source: row.source as Fact["source"], sourceName: row.sourceName, sourceUrl: row.sourceUrl, observedAt: row.observedAt, matchBasis: row.matchBasis };
}

export type FactSummary = {
  resolvedAt: string;
  status: "COMPLETE" | "PARTIAL" | "MISSING";
  missing: FactField[];
  conflicting: FactField[];
  stale: FactField[];
  fields: Partial<Record<FactField, { status: ResolvedFact["status"]; value: ResolvedFact["value"]; unit?: string | null; source: string | null; sourceName: string | null; sourceUrl: string | null; observedAt: string | null; note: string }>>;
  priceTier: { tier: string; methodology: string } | null;
  platform: "NOT_APPLICABLE" | null;
  /** Deterministic health score (lib/products/quality.ts). Admin only. */
  quality?: { score: number; band: QualityBand; parts: Record<string, number> };
  /** Last run's per-source outcomes (matched, failed, not the same product, fallback used …). */
  attempts?: string[];
  nextRefreshAt?: string | null;
  identityBasis?: string | null;
  wikidataCheckedAt?: string | null;
  version?: number;
};

/** Resolves stored facts into the snapshot pages and Admin read. */
export function summarize(facts: Fact[], categorySlug: string | null, now: Date): FactSummary {
  const resolved = resolveFacts(facts, now);
  const fields: FactSummary["fields"] = {};
  for (const [k, r] of Object.entries(resolved) as Array<[FactField, ResolvedFact]>) {
    fields[k] = { status: r.status, value: r.value, unit: r.unit ?? r.chosen?.unit ?? null, source: r.chosen?.source ?? null, sourceName: r.chosen?.sourceName ?? null, sourceUrl: r.chosen?.sourceUrl ?? null, observedAt: r.chosen?.observedAt.toISOString() ?? null, note: r.note };
  }
  const cat = categorySlug ? CATEGORY_BY_SLUG.get(categorySlug) : undefined;
  const platformNA = !cat || !isTechCategory(cat);
  const price = resolved.price;
  const tier = price && price.status !== "STALE" && price.status !== "CONFLICTING" && typeof price.value === "number" ? priceTier({ price: price.value, currency: (price.unit ?? price.chosen?.unit ?? (resolved.currency?.value as string | undefined)) ?? null, categorySlug, observedAt: price.chosen?.observedAt ?? null }, now) : null;
  const applicable = applicableFields(categorySlug).filter((f) => !(platformNA && f === "platform"));
  const c = completeness(resolved, applicable);
  const licensedImage = facts.some((f) => f.field === "image" && f.unit);
  const quality = qualityScore(resolved, { applicable, productNameKnown: true, image: licensedImage ? "LICENSED_PRODUCT" : "NEUTRAL_CATEGORY" });
  // Earliest moment any stored fact reaches half its life (refreshDue).
  const next = facts.map((f) => f.observedAt.getTime() + maxAgeMs(volatility(f.field)) / 2).sort((a, b) => a - b)[0];
  const ranks = ["gtin", "mpn", "model", "wikidata:gtin", "brand+name", "wikidata:brand+name", "sovrn-match", "review-source"];
  const identityBasis = facts.map((f) => f.matchBasis).sort((a, b) => (ranks.indexOf(a) + 99) % 99 - ((ranks.indexOf(b) + 99) % 99))[0] ?? null;
  return { resolvedAt: now.toISOString(), ...c, fields, priceTier: tier, platform: platformNA ? "NOT_APPLICABLE" : null, quality, nextRefreshAt: next ? new Date(next).toISOString() : null, identityBasis };
}

/** Enriches one product. Never throws for a single failing source; returns per-source outcomes. */
export async function enrichProduct(entityId: string, now = new Date()): Promise<{ status: FactSummary["status"]; outcomes: string[] }> {
  const ctx: Ctx = { now };
  const e = await loadEntity(entityId);
  const outcomes: string[] = [];
  const fromReviews = reviewFacts(e);
  await saveFacts(e.id, fromReviews);
  const stored = e.facts.map(toFact);
  const identity = identityOf(e, [...stored, ...fromReviews]);
  // Known product pages for this exact product; skipped while their facts are still fresh.
  const urls = new Set<string>();
  for (const link of e.content) {
    for (const u of [link.review.sourceProductUrl, ...link.review.affiliateLinks.map((l) => l.finalUrl)]) {
      const c = canonicalProductUrl(u);
      if (c) urls.add(c);
    }
  }
  for (const f of stored) if ((f.field === "officialUrl" || f.field === "retailerUrl") && typeof f.value === "string") urls.add(f.value);
  for (const url of [...urls].slice(0, 4)) {
    const previous = stored.filter((f) => f.sourceUrl === url);
    if (previous.length && !previous.some((f) => refreshDue(f, now))) {
      outcomes.push(`FRESH_CACHE ${url}`);
      continue;
    }
    try {
      const r = await pageFacts(url, identity, e.brand, ctx);
      outcomes.push(`${r.outcome} ${url}`);
      await saveFacts(e.id, r.facts);
    } catch (error) {
      outcomes.push(`ERROR ${url}`);
      log.warn("product page enrichment failed", { stage: "ENTITY_EXTRACTION", entityId: e.id, error: String(error).slice(0, 200) });
    }
  }
  // Free fallback for stable facts: Wikidata / Commons, re-checked weekly when nothing matched.
  const prev = (e.factSummary ?? null) as FactSummary | null;
  const wd = stored.filter((f) => f.source === "WIKIDATA");
  const wdDue = wd.length ? wd.some((f) => refreshDue(f, now)) : !prev?.wikidataCheckedAt || now.getTime() - Date.parse(prev.wikidataCheckedAt) > 7 * 86_400_000;
  let wikidataCheckedAt = prev?.wikidataCheckedAt ?? null;
  if (wdDue) {
    try {
      const r = await wikidataFacts(identity, now);
      outcomes.push(r.outcome);
      await saveFacts(e.id, r.facts);
      wikidataCheckedAt = now.toISOString();
    } catch (error) {
      outcomes.push("WIKIDATA_ERROR");
      log.warn("wikidata enrichment failed", { stage: "ENTITY_EXTRACTION", entityId: e.id, error: String(error).slice(0, 200) });
    }
  }
  const all = (await db.productFact.findMany({ where: { productEntityId: e.id } })).map(toFact).filter((f) => ENRICH_FIELDS.includes(f.field));
  const summary = { ...summarize(all, e.categorySlug, now), attempts: outcomes, wikidataCheckedAt, version: ENRICHMENT_VERSION };
  await db.productEntity.update({ where: { id: e.id }, data: { factSummary: summary as unknown as Prisma.InputJsonValue, enrichmentStatus: summary.status, enrichedAt: now } });
  return { status: summary.status, outcomes };
}
