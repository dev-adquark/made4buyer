import type { Prisma } from "@prisma/client";
import { onOfficialDomain } from "@/lib/commerce/deal-status";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { probeImage } from "@/lib/pipeline/images";
import { findPexelsImage, pexelsConfigured, type PexelsSearchResult } from "@/lib/pipeline/pexels";
import { freshOfferWhere } from "@/lib/public/offers";
import { audit, SYSTEM_ACTOR } from "@/lib/security/audit";
import { cardImageTopic, dealCardImage, storedCardImage, type DealCardImage, type InternalImage, type StoredCardImage } from "./deal-card-image";

/**
 * Server side of deal-card images (lib/images/deal-card-image.ts holds the pure priority chain).
 *
 *  loadDealCardImages  request path: reads what is stored (no network) and resolves each product's card image.
 *  runDealCardImages   job (enrich-images, image-integrity): for live commerce products whose card would
 *                      otherwise show the category image, finds a labelled Pexels photo of the product's
 *                      TYPE (never a keyword photo of "the product") and stores it with provenance in
 *                      CommerceProduct.data.cardImage. Sequential, one shared search cache per run, stops
 *                      on a Pexels rate limit / auth failure; never runs at request time.
 */

const PRODUCT_SELECT = {
  id: true,
  name: true,
  canonicalUrl: true,
  data: true,
  identityStatus: true,
  productEntityId: true,
  brand: { select: { officialDomain: true, officialStoreUrl: true, categories: true } },
} as const satisfies Prisma.CommerceProductSelect;
type ProductRow = Prisma.CommerceProductGetPayload<{ select: typeof PRODUCT_SELECT }>;

type Context = { official: Map<string, { canonicalUrl: string; data: unknown; brand: { officialDomain: string } | null }>; internal: Map<string, InternalImage> };

/** Official-domain counterparts and published-review images for the given product entities. */
async function contextFor(entityIds: string[]): Promise<Context> {
  const official: Context["official"] = new Map();
  const internal: Context["internal"] = new Map();
  if (!entityIds.length) return { official, internal };
  const [officialRows, links] = await Promise.all([
    db.commerceProduct.findMany({
      where: { productEntityId: { in: entityIds }, identityStatus: "MATCHED" },
      select: { productEntityId: true, canonicalUrl: true, data: true, brand: { select: { name: true, officialDomain: true, officialStoreUrl: true } } },
      orderBy: { observedAt: "desc" },
    }),
    db.contentEntity.findMany({
      where: { role: "PRIMARY", productEntityId: { in: entityIds }, review: { status: "PUBLISHED" } },
      orderBy: { createdAt: "asc" },
      select: { productEntityId: true, review: { select: { images: { where: { isPrimary: true }, take: 1, select: { sourceType: true, sourceUrl: true, cdnUrl: true, imageType: true, matchConfidence: true, licenseState: true, enrichmentStatus: true, attribution: true, attributionUrl: true, sourcePageUrl: true } } } } },
    }),
  ]);
  for (const p of officialRows) {
    if (!p.productEntityId || official.has(p.productEntityId) || !p.brand || !onOfficialDomain(p.canonicalUrl, p.brand)) continue;
    official.set(p.productEntityId, { canonicalUrl: p.canonicalUrl, data: p.data, brand: { officialDomain: p.brand.officialDomain } });
  }
  for (const l of links) {
    const a = l.review.images[0];
    const url = a ? (a.cdnUrl ?? a.sourceUrl) : null;
    if (!a || !url || internal.has(l.productEntityId)) continue;
    internal.set(l.productEntityId, { url, imageType: a.imageType, matchConfidence: a.matchConfidence, licenseState: a.licenseState, enrichmentStatus: a.enrichmentStatus, sourceType: a.sourceType, attribution: a.attribution, attributionUrl: a.attributionUrl, sourcePageUrl: a.sourcePageUrl });
  }
  return { official, internal };
}

function resolve(p: ProductRow, ctx: Context): DealCardImage {
  return dealCardImage({
    product: { id: p.id, name: p.name, canonicalUrl: p.canonicalUrl, data: p.data, identityStatus: p.identityStatus, brand: p.brand ? { officialDomain: p.brand.officialDomain } : null },
    official: p.productEntityId ? (ctx.official.get(p.productEntityId) ?? null) : null,
    internal: p.productEntityId ? (ctx.internal.get(p.productEntityId) ?? null) : null,
    categories: p.brand?.categories ?? [],
  });
}

/** Card image per CommerceProduct id (request path: stored data only, no network). */
export async function loadDealCardImages(productIds: string[]): Promise<Map<string, DealCardImage>> {
  const ids = [...new Set(productIds)];
  const out = new Map<string, DealCardImage>();
  if (!ids.length) return out;
  const rows = await db.commerceProduct.findMany({ where: { id: { in: ids } }, select: PRODUCT_SELECT });
  const ctx = await contextFor([...new Set(rows.map((r) => r.productEntityId).filter((x): x is string => Boolean(x)))]);
  for (const r of rows) out.set(r.id, resolve(r, ctx));
  return out;
}

// ── Job ────────────────────────────────────────────────────────────────────

export type DealCardImagesResult = {
  status: "OK" | "NOT_CONFIGURED" | "RATE_LIMITED" | "AUTH_FAILED";
  reason?: string;
  /** Live commerce products (a fresh USD offer) considered. */
  live: number;
  exact: number;
  alreadyIllustrative: number;
  /** Products whose card would show the category image before this run. */
  needed: number;
  attached: number;
  noTopic: number;
  noPhoto: number;
  requests: number;
  items: Array<{ productId: string; name: string; outcome: string; query?: string; topic?: string }>;
};

/** Live products: those with a fresh offer (the ones /deals and the home rails can show). */
async function liveProducts(now: number, take = 600): Promise<ProductRow[]> {
  const offers = await db.commerceOffer.findMany({ where: freshOfferWhere(now), select: { productId: true }, distinct: ["productId"], orderBy: { observedAt: "desc" }, take });
  if (!offers.length) return [];
  return db.commerceProduct.findMany({ where: { id: { in: offers.map((o) => o.productId) } }, select: PRODUCT_SELECT });
}

function withCardImage(data: unknown, card: StoredCardImage | null): Prisma.InputJsonValue {
  const d = (data && typeof data === "object" && !Array.isArray(data) ? { ...(data as Record<string, unknown>) } : {}) as Record<string, unknown>;
  if (card) d.cardImage = card;
  else delete d.cardImage;
  return d as Prisma.InputJsonValue;
}

/**
 * Attaches a labelled product-type photo to every live product whose card has no exact image.
 * Idempotent: a product with an exact image or a still-valid stored photo is skipped.
 */
export async function runDealCardImages(trigger: string, opts: { limit?: number; now?: number; cache?: Map<string, PexelsSearchResult> } = {}): Promise<DealCardImagesResult> {
  const now = opts.now ?? Date.now();
  const out: DealCardImagesResult = { status: "OK", live: 0, exact: 0, alreadyIllustrative: 0, needed: 0, attached: 0, noTopic: 0, noPhoto: 0, requests: 0, items: [] };
  const rows = await liveProducts(now);
  out.live = rows.length;
  const ctx = await contextFor([...new Set(rows.map((r) => r.productEntityId).filter((x): x is string => Boolean(x)))]);
  const todo: ProductRow[] = [];
  for (const r of rows) {
    const img = resolve(r, ctx);
    if (img.exact) out.exact++;
    else if (img.kind === "illustrative") out.alreadyIllustrative++;
    else todo.push(r);
  }
  out.needed = todo.length;
  if (!todo.length) return out;
  if (!pexelsConfigured()) return { ...out, status: "NOT_CONFIGURED", reason: "PEXELS_API_KEY not configured: cards keep the category image" };

  const cache = opts.cache ?? new Map<string, PexelsSearchResult>();
  // Different products of one type get different photos where the pool allows (never required).
  const used = new Set<string>();
  for (const r of rows) {
    const c = storedCardImage(r, r.brand?.categories ?? []);
    if (c) used.add(c.photoId);
  }
  for (const r of todo.slice(0, opts.limit ?? 80)) {
    const categories = r.brand?.categories ?? [];
    const topic = cardImageTopic(r, categories);
    if (!topic) {
      out.noTopic++;
      out.items.push({ productId: r.id, name: r.name, outcome: "no product type stated: category image" });
      continue;
    }
    const found = await findPexelsImage({ productName: r.name, categorySlug: categories[0] ?? null, kind: "PRODUCT_TYPE" }, { exclude: used, cache, topic: topic.topic });
    out.requests += found.requests;
    if (found.status === "RATE_LIMITED" || found.status === "AUTH_FAILED") {
      out.status = found.status;
      out.reason = found.reason;
      out.items.push({ productId: r.id, name: r.name, outcome: `stopped: ${found.status}` });
      break;
    }
    // Only a photo whose own description names the type (findPexelsImage's topic filter); never a "product" keyword match.
    const img = found.image && found.image.subject === "ILLUSTRATIVE" ? found.image : null;
    if (!img || !(await probeImage(img.url)).ok) {
      out.noPhoto++;
      out.items.push({ productId: r.id, name: r.name, outcome: found.reason ?? "photo did not load", topic: topic.topic.label });
      continue;
    }
    const card: StoredCardImage = {
      v: 1,
      kind: "illustrative",
      src: img.url,
      alt: img.alt,
      source: "pexels",
      sourceType: "ENRICHMENT_SERVICE",
      sourceUrl: img.attributionUrl,
      photoId: img.providerPhotoId,
      query: img.searchQuery,
      topicKey: topic.topic.key,
      topicLabel: topic.topic.label,
      imageType: topic.imageType,
      basis: topic.basis,
      productId: r.id,
      productName: r.name,
      confidence: topic.imageType === "illustrative-product-type" ? (topic.basis === "name" ? 0.6 : 0.5) : 0.3,
      observedAt: new Date(now).toISOString(),
      attribution: img.attribution,
      attributionUrl: img.attributionUrl,
      license: img.license,
    };
    const fresh = await db.commerceProduct.findUnique({ where: { id: r.id }, select: { data: true } });
    await db.commerceProduct.update({ where: { id: r.id }, data: { data: withCardImage(fresh?.data ?? r.data, card) } });
    used.add(card.photoId);
    out.attached++;
    out.items.push({ productId: r.id, name: r.name, outcome: "attached", query: card.query, topic: card.topicLabel });
  }
  if (out.attached) {
    await audit(SYSTEM_ACTOR, { action: "image.deal_card.attached", entityType: "commerce_product", entityId: "batch", metadata: { trigger, attached: out.attached, items: out.items.filter((i) => i.outcome === "attached").slice(0, 50) } }).catch(() => undefined);
    log.info("deal card images attached", { stage: "IMAGE_ENRICHMENT", trigger, attached: out.attached, needed: out.needed });
  }
  return out;
}

/** Removes a stored card photo (integrity: broken or no longer this product's type). */
export async function clearCardImage(productId: string): Promise<void> {
  const p = await db.commerceProduct.findUnique({ where: { id: productId }, select: { data: true } });
  if (p) await db.commerceProduct.update({ where: { id: productId }, data: { data: withCardImage(p.data, null) } });
}

export { liveProducts as liveCommerceProducts, resolve as resolveDealCardImage, contextFor as dealCardImageContext, PRODUCT_SELECT as DEAL_CARD_PRODUCT_SELECT };
export type { ProductRow as DealCardProductRow };
