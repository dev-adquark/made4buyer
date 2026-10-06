import type { NormalizedReview } from "@prisma/client";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { freshOffersForProduct, primaryProductId } from "@/lib/public/offers";
import { classify } from "@/lib/taxonomy/classify";
import { CATEGORIES } from "@/lib/taxonomy/definitions";
import { ensureTaxonomySeeded, persistClassification } from "@/lib/taxonomy/persist";
import { slugify } from "@/lib/util/text";
import { detectContentKind, setAutoEntities } from "@/lib/entities/resolve";
import { getSwitches } from "@/lib/automation/settings";
import { extractEntities, lowConfidenceFields, type EntityField } from "./entities";
import { recordFailure, resolveFailures } from "./failures";
import { enrichImage, neutralCategoryDecision, probeImage, stockPhotoStillRelevant } from "./images";
import { inferImageType } from "@/lib/images/provenance";
import { commonsImagesFor, primaryProductOf } from "@/lib/products/commons-image";
import type { PexelsSearchResult } from "./pexels";
import { normalizeContent } from "./normalize";
import { validateContentItem, type ValidatedContent } from "./validate";

/**
 * Per-review stage runners. Each stage persists its output, resolves its previous failures
 * on success and records a coded failure otherwise. All are safe to re-run.
 */

export type EntityOverride = { value: string; source: "ADMIN" | "CSV"; actor: string; at: string };
export type EntityOverrides = Partial<Record<EntityField, EntityOverride>>;

const REVIEW = "normalized_review" as const;

/** Rebuilds the validated source content for a review from its persisted raw payload. */
export async function loadSourceContent(review: NormalizedReview): Promise<ValidatedContent> {
  const item = await db.contentItem.findFirst({
    where: { normalizedReviewId: review.id, source: review.source, sourceId: review.sourceId },
    select: { rawPayload: true },
  });
  if (item) {
    const v = validateContentItem(item.rawPayload);
    if (v.ok) return v.value;
  }
  return {
    sourceId: review.sourceId,
    title: review.canonicalTitle,
    body: review.body,
    summary: review.summary,
    url: review.sourceUrl ?? undefined,
    canonicalUrl: review.canonicalUrl ?? undefined,
    publishedAt: review.sourcePublishedAt ?? undefined,
    productName: review.productName,
    brand: review.brand ?? undefined,
    tags: [],
    imageLicenseVerified: false,
    author: review.author ?? undefined,
    contentKind: review.kind === "AI_GUIDE" ? "AI_GUIDE" : "REVIEW",
  };
}

// ─── ENTITY_EXTRACTION ──────────────────────────────────────────────────────

const TAXONOMY_NAMES = new Set(CATEGORIES.flatMap((c) => [c.name, ...c.subcategories.map((s) => s.name)]).map((n) => n.toLowerCase()));
function isTaxonomyName(name: string): boolean {
  return TAXONOMY_NAMES.has(name.trim().toLowerCase());
}

export async function runEntityStage(review: NormalizedReview, content: ValidatedContent) {
  const candidate = normalizeContent(content, { source: review.source, fetchedAt: review.createdAt });
  const extracted = extractEntities(content, candidate);
  const existing = await db.extractedEntities.findUnique({ where: { normalizedReviewId: review.id }, select: { overrides: true } });
  const overrides = (existing?.overrides ?? {}) as EntityOverrides;

  const values: Record<string, unknown> = { ...extracted };
  const confidences = { ...extracted.confidences };
  for (const [field, o] of Object.entries(overrides) as Array<[EntityField, EntityOverride]>) {
    // The same JSON also holds editor choices that are not entity fields (contentKind, removedEntities).
    if (!o || typeof o !== "object" || !("value" in o)) continue;
    // An empty override is an editor's explicit "not applicable" confirmation.
    values[field] = o.value === "" ? undefined : field === "price" ? Number(o.value) : o.value;
    confidences[field] = 1;
  }
  // What kind of article this is: a comparison of several products has no single product
  // name or brand, so those fields are not "low confidence", they don't apply.
  const kindOverride = (existing?.overrides as { contentKind?: "REVIEW" | "COMPARISON" | "BUYING_GUIDE" } | null)?.contentKind;
  const detected = review.kind === "AI_GUIDE" ? null : detectContentKind(review.canonicalTitle);
  const kind = review.kind === "AI_GUIDE" ? "AI_GUIDE" : (kindOverride ?? detected!.kind);
  const compared = kind === "COMPARISON" ? (detected?.compared ?? null) : null;
  if (compared) {
    values.productName = compared.join(" vs ");
    values.brand = undefined;
    confidences.productName = 0.9;
    confidences.brand = 1;
    confidences.deviceType = Math.max(confidences.deviceType, 0.9);
  }
  // Not applicable: comparisons and guides cover several products, as does an AI guide about a
  // whole category ("How to choose vacuum cleaners"), so a single brand or device isn't missing.
  const categoryTopic = kind === "AI_GUIDE" && isTaxonomyName(String(values.productName ?? ""));
  const notApplicable: EntityField[] = kind === "COMPARISON" || kind === "BUYING_GUIDE" || categoryTopic ? ["productName", "brand", "deviceType"] : [];
  const low = lowConfidenceFields({ confidences }, config.entities.lowConfidenceThreshold()).filter((f) => !notApplicable.includes(f));
  const core = { productName: 0.45, brand: 0.3, deviceType: 0.25 } as const;
  const overall = compared ? 0.9 : Math.round((confidences.productName * core.productName + confidences.brand * core.brand + confidences.deviceType * core.deviceType) * 100) / 100;

  const data = {
    productName: String(values.productName),
    brand: (values.brand as string | undefined) ?? null,
    deviceType: (values.deviceType as string | undefined) ?? null,
    useCase: (values.useCase as string | undefined) ?? null,
    platform: (values.platform as string | undefined) ?? null,
    price: typeof values.price === "number" && Number.isFinite(values.price) ? values.price : null,
    currency: extracted.currency ?? null,
    modelNumber: (values.modelNumber as string | undefined) ?? null,
    source: extracted.source,
    publishDate: extracted.publishDate ?? null,
    rating: extracted.rating ?? null,
    ratingScale: extracted.ratingScale ?? null,
    confidences,
    lowConfidenceFields: low,
    overallConfidence: overall,
  };
  const entities = await db.extractedEntities.upsert({
    where: { normalizedReviewId: review.id },
    create: { normalizedReviewId: review.id, ...data },
    update: data,
  });
  await db.normalizedReview.update({
    where: { id: review.id },
    data: { productName: entities.productName, brand: entities.brand, brandSlug: entities.brand ? slugify(entities.brand, 60) : null, entityConfidence: overall, kind },
  });

  // Product entities: every compared product for a comparison; the reviewed product for a
  // review (only when its name is confident; otherwise QA decides). Guides list nothing
  // automatically: their products are added by an editor.
  const threshold = config.entities.lowConfidenceThreshold();
  if (compared) await setAutoEntities(review.id, compared.map((name) => ({ name, role: "COMPARED" as const, confidence: 0.9 })));
  // A category-topic guide ("How to choose robot vacuums") covers no single product.
  else if ((kind === "REVIEW" || kind === "AI_GUIDE") && confidences.productName >= threshold && !(kind === "AI_GUIDE" && isTaxonomyName(entities.productName)))
    await setAutoEntities(review.id, [{ name: entities.productName, role: kind === "REVIEW" ? "PRIMARY" : "MENTIONED", confidence: confidences.productName, brand: entities.brand }]);
  else await setAutoEntities(review.id, []);

  if (low.length) {
    await recordFailure({
      stage: "ENTITY_EXTRACTION",
      code: "ENTITY_EXTRACTION_LOW_CONFIDENCE",
      message: `Low-confidence entities: ${low.map((f) => `${f}=${confidences[f]}`).join(", ")}`,
      entityType: REVIEW,
      entityId: review.id,
      normalizedReviewId: review.id,
    });
  } else {
    await resolveFailures({ stage: "ENTITY_EXTRACTION", entityType: REVIEW, entityId: review.id });
  }
  log.info("entities extracted", { stage: "ENTITY_EXTRACTION", reviewId: review.id, overall, lowConfidence: low });
  return entities;
}

// ─── TAXONOMY ───────────────────────────────────────────────────────────────

export async function runTaxonomyStage(review: NormalizedReview, content: ValidatedContent) {
  await ensureTaxonomySeeded();
  const entities = await db.extractedEntities.findUnique({ where: { normalizedReviewId: review.id } });
  const result = classify({
    title: review.canonicalTitle,
    productName: entities?.productName ?? review.productName,
    summary: review.summary,
    body: review.body,
    sourceCategory: content.category,
    sourceTags: [content.subcategory ?? "", ...content.tags].filter(Boolean),
    deviceType: entities?.deviceType,
    price: entities?.price,
  });
  const taxonomy = await persistClassification(review.id, result);
  if (!taxonomy.categorySlug) {
    await recordFailure({ stage: "TAXONOMY", code: "NO_CATEGORY_MATCH", entityType: REVIEW, entityId: review.id, normalizedReviewId: review.id });
  } else if (taxonomy.confidence < config.taxonomy.autoAcceptThreshold()) {
    await resolveFailures({ stage: "TAXONOMY", entityType: REVIEW, entityId: review.id, codes: ["NO_CATEGORY_MATCH"] });
    await recordFailure({
      stage: "TAXONOMY",
      code: "CATEGORY_LOW_CONFIDENCE",
      message: `Category ${taxonomy.categorySlug} confidence ${taxonomy.confidence} < ${config.taxonomy.autoAcceptThreshold()}`,
      entityType: REVIEW,
      entityId: review.id,
      normalizedReviewId: review.id,
    });
  } else {
    await resolveFailures({ stage: "TAXONOMY", entityType: REVIEW, entityId: review.id });
  }
  // Products first seen in this article inherit its category (an editor's choice is never overwritten).
  if (taxonomy.categorySlug)
    await db.productEntity.updateMany({ where: { categorySlug: null, content: { some: { normalizedReviewId: review.id } } }, data: { categorySlug: taxonomy.categorySlug, subcategorySlug: taxonomy.subcategorySlug ?? null } });
  log.info("taxonomy classified", { stage: "TAXONOMY", reviewId: review.id, ...taxonomy, scores: result.scores });
  return { ...taxonomy, classification: result };
}

// ─── IMAGE_ENRICHMENT ───────────────────────────────────────────────────────

type RankedImage = { isFallback: boolean; subject?: string | null; licenseState?: string | null; sourceType?: string | null; imageType?: string | null };

/**
 * How good an image is for its page: a licensed photo of the exact product (3) beats the
 * source's own product image (2), which beats a labelled topic photo (1), which beats the
 * neutral placeholder (0). `singleProduct` is the page's context when known:
 *  - on a single-product page a keyword stock photo is worth nothing (it is replaced);
 *  - a stock photo stored as a "product" photo is worth nothing anywhere;
 *  - without context, a stock photo stored before provenance existed (imageType null) is worth
 *    nothing, so the enrich-images job re-checks it once under the current rules.
 */
export function imageRank(a: RankedImage | null | undefined, ctx?: { singleProduct?: boolean }): number {
  if (!a || a.isFallback) return 0;
  // An image we are not allowed to show is worth no more than the placeholder.
  if (a.licenseState === "UNVERIFIED" && config.images.requireLicense()) return 0;
  if (a.sourceType === "ENRICHMENT_SERVICE") {
    if (a.subject !== "ILLUSTRATIVE") return 0;
    // On a single-product page only a photo of the product's type counts (better than the placeholder).
    if (ctx?.singleProduct) return a.imageType === "illustrative-product-type" ? 1 : 0;
    if (!ctx && !a.imageType) return 0;
    return 1;
  }
  if (a.sourceType === "WIKIMEDIA_COMMONS" || a.imageType === "commons-product" || a.imageType === "official-product" || a.imageType === "retailer-product") return 3;
  return a.subject === "ILLUSTRATIVE" ? 1 : 2;
}

function sameImage(a: { sourceType: string; sourceUrl: string | null; providerPhotoId: string | null }, b: { sourceType: string; sourceUrl?: string; providerPhotoId?: string }): boolean {
  return a.sourceType === b.sourceType && a.sourceUrl === (b.sourceUrl ?? null) && a.providerPhotoId === (b.providerPhotoId ?? null);
}

export type ImageStageOptions = { excludePhotoIds?: Set<string>; searchCache?: Map<string, PexelsSearchResult>; replaceExisting?: boolean; retried?: boolean };

export async function runImageStage(review: NormalizedReview, content: ValidatedContent, opts: ImageStageOptions = {}) {
  const current = await db.normalizedReview.findUniqueOrThrow({ where: { id: review.id }, select: { categorySlug: true, subcategorySlug: true, productName: true, brand: true, canonicalTitle: true, kind: true } });
  // Single-product content: a REVIEW, or anything linked to one PRIMARY product.
  const primary = await primaryProductOf(review.id);
  const singleProduct = current.kind === "REVIEW" || Boolean(primary);
  const existing = await db.imageAsset.findFirst({ where: { normalizedReviewId: review.id, isPrimary: true } });
  // Photos other pages already use, so each page gets its own stock photo where one exists.
  const exclude =
    opts.excludePhotoIds ??
    new Set((await db.imageAsset.findMany({ where: { isPrimary: true, providerPhotoId: { not: null }, normalizedReviewId: { not: review.id } }, select: { providerPhotoId: true } })).map((a) => a.providerPhotoId!));
  let decision: Awaited<ReturnType<typeof enrichImage>>;
  if (!(await getSwitches()).image_enrichment && !content.imageUrl) {
    // Admin switch: image enrichment paused → no provider call; existing images are kept, except
    // that a stock photo is still taken off a single-product page (no network needed for that).
    if (!(singleProduct && existing?.sourceType === "ENRICHMENT_SERVICE")) return existing;
    decision = neutralCategoryDecision(current.categorySlug, [], "image enrichment paused; stock photo removed from a single-product page");
  } else {
    try {
      const product = singleProduct && primary ? await commonsImagesFor(primary) : { images: [], rejected: [] };
      if (product.rejected.length) log.info("product image facts rejected", { stage: "IMAGE_ENRICHMENT", reviewId: review.id, reasons: product.rejected.slice(0, 5) });
      decision = await enrichImage({
        imageUrl: content.imageUrl,
        imageLicense: content.imageLicense,
        imageAttribution: content.imageAttribution,
        imageLicenseVerified: content.imageLicenseVerified,
        productName: current.productName,
        brand: current.brand,
        categorySlug: current.categorySlug,
        subcategorySlug: current.subcategorySlug,
        title: current.canonicalTitle,
        kind: current.kind,
        singleProduct,
        productImages: product.images,
        excludePhotoIds: exclude,
        searchCache: opts.searchCache,
      });
    } catch (error) {
      // Image enrichment must never block the pipeline.
      await recordFailure({ stage: "IMAGE_ENRICHMENT", code: "IMAGE_ENRICHMENT_FAILED", message: String(error), entityType: REVIEW, entityId: review.id, normalizedReviewId: review.id });
      return null;
    }
  }
  const { issues, providerStatus, ...data } = decision;
  const ctx = { singleProduct };
  let asset;
  if (existing && sameImage(existing, data)) {
    // Same image as before: refresh its provenance in place (idempotent, no new row, no re-render).
    asset = await db.imageAsset.update({ where: { id: existing.id }, data: { ...data, failureReason: data.failureReason ?? null, matchConfidence: data.matchConfidence ?? null, sourcePageUrl: data.sourcePageUrl ?? null } });
  } else if (
    existing &&
    !opts.replaceExisting &&
    imageRank(existing, ctx) > imageRank(data, ctx) &&
    // A stock photo that no longer passes the relevance rule is not worth keeping over anything.
    (existing.sourceType !== "ENRICHMENT_SERVICE" || stockPhotoStillRelevant(existing.altText, { productName: current.productName, title: current.canonicalTitle, categorySlug: current.categorySlug, subcategorySlug: current.subcategorySlug, singleProduct })) &&
    existing.sourceUrl &&
    (await probeImage(existing.sourceUrl)).ok
  ) {
    // Never replace a working image with a worse one (e.g. a placeholder after a rate limit).
    log.info("image kept", { stage: "IMAGE_ENRICHMENT", reviewId: review.id, kept: existing.providerPhotoId ?? existing.sourceType, candidate: data.isFallback ? "placeholder" : data.subject, providerStatus });
    // Stamp provenance on a row stored before provenance existed.
    const inferred = existing.imageType ? null : inferImageType(existing);
    const kept = inferred ? await db.imageAsset.update({ where: { id: existing.id }, data: { imageType: inferred } }) : existing;
    return Object.assign(kept, { providerStatus });
  } else {
    await db.imageAsset.updateMany({ where: { normalizedReviewId: review.id, isPrimary: true }, data: { isPrimary: false } });
    try {
      asset = await db.imageAsset.create({ data: { normalizedReviewId: review.id, ...data, isPrimary: true } });
    } catch (error) {
      // Another article claimed this photo a moment ago (unique primary photo index): retry once
      // with it excluded, else use the placeholder. A stock photo is never shared between articles.
      if ((error as { code?: string }).code !== "P2002" || !data.providerPhotoId || opts.retried) throw error;
      exclude.add(data.providerPhotoId);
      return runImageStage(review, content, { ...opts, excludePhotoIds: exclude, replaceExisting: true, retried: true });
    }
    // Keep history bounded: remove superseded non-primary assets beyond the latest 5.
    const old = await db.imageAsset.findMany({ where: { normalizedReviewId: review.id, isPrimary: false }, orderBy: { createdAt: "desc" }, skip: 5, select: { id: true } });
    if (old.length) await db.imageAsset.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  }

  const codes = new Set(issues.map((i) => i.code));
  for (const code of ["IMAGE_ENRICHMENT_FAILED", "LICENSE_UNVERIFIED"] as const) {
    if (codes.has(code)) {
      await recordFailure({ stage: "IMAGE_ENRICHMENT", code, message: issues.filter((i) => i.code === code).map((i) => i.message).join("; "), entityType: REVIEW, entityId: review.id, normalizedReviewId: review.id });
    } else {
      await resolveFailures({ stage: "IMAGE_ENRICHMENT", entityType: REVIEW, entityId: review.id, codes: [code] });
    }
  }
  log.info("image enriched", { stage: "IMAGE_ENRICHMENT", reviewId: review.id, sourceType: asset.sourceType, imageType: asset.imageType, subject: asset.subject, photo: asset.providerPhotoId, licenseState: asset.licenseState, isFallback: asset.isFallback, providerStatus });
  return Object.assign(asset, { providerStatus });
}

// ─── OFFER_MATCHING (commerce engine) ───────────────────────────────────────

export type OfferStageResult = { status: NormalizedReview["dealStatus"]; reason: string; offers: number };

/**
 * Derives the review's deal status from commerce-engine offers of its PRIMARY product. No
 * provider is queried here: the commerce engine observes prices on its own schedule; this
 * stage only records what is currently stored (fresh offers within PRODUCT_PRICE_MAX_AGE_HOURS).
 */
export async function runOfferStage(reviewId: string): Promise<OfferStageResult> {
  const review = await db.normalizedReview.findUniqueOrThrow({ where: { id: reviewId }, select: { kind: true } });
  // Failures recorded by the retired offer provider no longer apply.
  await resolveFailures({ stage: "OFFER_MATCHING", entityType: REVIEW, entityId: reviewId });
  const setDeal = async (status: NormalizedReview["dealStatus"], reason: string, offers = 0): Promise<OfferStageResult> => {
    await db.normalizedReview.update({ where: { id: reviewId }, data: { dealStatus: status, dealStatusReason: reason.slice(0, 500), dealCheckedAt: new Date() } });
    return { status, reason, offers };
  };
  // Offers attach to one product. A comparison or guide covers several.
  if (review.kind !== "REVIEW") return setDeal("NO_MATCH", "Not matched: comparisons and guides cover several products; offers appear on each product's own review");
  const productEntityId = await primaryProductId(reviewId);
  if (!productEntityId) return setDeal("UNAVAILABLE", "commerce data comes from the commerce engine; this review has no primary product yet");
  const fresh = (await freshOffersForProduct(productEntityId)).filter((o) => o.price != null);
  if (fresh.length) return setDeal("MATCHED", `${fresh.length} fresh commerce offer(s) observed within ${config.commerce.priceMaxAgeHours()}h`, fresh.length);
  const any = await db.commerceOffer.count({ where: { product: { productEntityId } } });
  if (any) return setDeal("STALE", `commerce data comes from the commerce engine; no offer observed within ${config.commerce.priceMaxAgeHours()}h`);
  return setDeal("UNAVAILABLE", "commerce data comes from the commerce engine; no offer observed for this product yet");
}
