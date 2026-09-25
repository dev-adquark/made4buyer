import type { AffiliateLink, NormalizedReview, Prisma } from "@prisma/client";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { fetchSovrnOffers } from "@/lib/sovrn/client";
import { generateAffiliateUrl } from "@/lib/sovrn/affiliate";
import { rankOffers, selectionReason, type RankedOffer } from "@/lib/sovrn/offers";
import { classify } from "@/lib/taxonomy/classify";
import { ensureTaxonomySeeded, persistClassification } from "@/lib/taxonomy/persist";
import { slugify } from "@/lib/util/text";
import { extractEntities, lowConfidenceFields, type EntityField } from "./entities";
import { recordFailure, resolveFailures } from "./failures";
import { enrichImage } from "./images";
import { normalizeContent } from "./normalize";
import { validateContentItem, type ValidatedContent } from "./validate";
import { nextVerificationDelayMs, verifyAffiliateLink } from "./verify-link";

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
  };
}

// ─── ENTITY_EXTRACTION ──────────────────────────────────────────────────────

export async function runEntityStage(review: NormalizedReview, content: ValidatedContent) {
  const candidate = normalizeContent(content, { source: review.source, fetchedAt: review.createdAt });
  const extracted = extractEntities(content, candidate);
  const existing = await db.extractedEntities.findUnique({ where: { normalizedReviewId: review.id }, select: { overrides: true } });
  const overrides = (existing?.overrides ?? {}) as EntityOverrides;

  const values: Record<string, unknown> = { ...extracted };
  const confidences = { ...extracted.confidences };
  for (const [field, o] of Object.entries(overrides) as Array<[EntityField, EntityOverride]>) {
    if (!o) continue;
    // An empty override is an editor's explicit "not applicable" confirmation.
    values[field] = o.value === "" ? undefined : field === "price" ? Number(o.value) : o.value;
    confidences[field] = 1;
  }
  const low = lowConfidenceFields({ confidences }, config.entities.lowConfidenceThreshold());
  const core = { productName: 0.45, brand: 0.3, deviceType: 0.25 } as const;
  const overall = Math.round((confidences.productName * core.productName + confidences.brand * core.brand + confidences.deviceType * core.deviceType) * 100) / 100;

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
    data: { productName: entities.productName, brand: entities.brand, brandSlug: entities.brand ? slugify(entities.brand, 60) : null, entityConfidence: overall },
  });

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
  log.info("taxonomy classified", { stage: "TAXONOMY", reviewId: review.id, ...taxonomy, scores: result.scores });
  return { ...taxonomy, classification: result };
}

// ─── IMAGE_ENRICHMENT ───────────────────────────────────────────────────────

export async function runImageStage(review: NormalizedReview, content: ValidatedContent) {
  const current = await db.normalizedReview.findUniqueOrThrow({ where: { id: review.id }, select: { categorySlug: true, productName: true, brand: true } });
  let decision;
  try {
    decision = await enrichImage({
      imageUrl: content.imageUrl,
      imageLicense: content.imageLicense,
      imageAttribution: content.imageAttribution,
      imageLicenseVerified: content.imageLicenseVerified,
      productName: current.productName,
      brand: current.brand,
      categorySlug: current.categorySlug,
    });
  } catch (error) {
    // Image enrichment must never block the pipeline.
    await recordFailure({ stage: "IMAGE_ENRICHMENT", code: "IMAGE_ENRICHMENT_FAILED", message: String(error), entityType: REVIEW, entityId: review.id, normalizedReviewId: review.id });
    return null;
  }
  const { issues, ...data } = decision;
  await db.imageAsset.updateMany({ where: { normalizedReviewId: review.id, isPrimary: true }, data: { isPrimary: false } });
  const asset = await db.imageAsset.create({ data: { normalizedReviewId: review.id, ...data, isPrimary: true } });
  // Keep history bounded: remove superseded non-primary assets beyond the latest 5.
  const old = await db.imageAsset.findMany({ where: { normalizedReviewId: review.id, isPrimary: false }, orderBy: { createdAt: "desc" }, skip: 5, select: { id: true } });
  if (old.length) await db.imageAsset.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });

  const codes = new Set(issues.map((i) => i.code));
  for (const code of ["IMAGE_ENRICHMENT_FAILED", "LICENSE_UNVERIFIED"] as const) {
    if (codes.has(code)) {
      await recordFailure({ stage: "IMAGE_ENRICHMENT", code, message: issues.filter((i) => i.code === code).map((i) => i.message).join("; "), entityType: REVIEW, entityId: review.id, normalizedReviewId: review.id });
    } else {
      await resolveFailures({ stage: "IMAGE_ENRICHMENT", entityType: REVIEW, entityId: review.id, codes: [code] });
    }
  }
  log.info("image enriched", { stage: "IMAGE_ENRICHMENT", reviewId: review.id, sourceType: asset.sourceType, licenseState: asset.licenseState, isFallback: asset.isFallback });
  return asset;
}

// ─── OFFER_MATCHING ─────────────────────────────────────────────────────────

export type OfferStageResult = { status: NormalizedReview["dealStatus"]; reason: string; selected: Array<{ matchId: string; ranked: RankedOffer; isBest: boolean }> };

export async function runOfferStage(reviewId: string, opts: { bypassCache?: boolean } = {}): Promise<OfferStageResult> {
  const review = await db.normalizedReview.findUniqueOrThrow({ where: { id: reviewId }, include: { entities: true } });
  const query = {
    productName: review.entities?.productName ?? review.productName,
    brand: review.entities?.brand ?? review.brand,
    deviceType: review.entities?.deviceType,
    categorySlug: review.categorySlug,
    modelNumber: review.entities?.modelNumber,
  };
  const now = new Date();
  const setDeal = (status: NormalizedReview["dealStatus"], reason: string) =>
    db.normalizedReview.update({ where: { id: reviewId }, data: { dealStatus: status, dealStatusReason: reason.slice(0, 500), dealCheckedAt: now } });

  const outcome = await fetchSovrnOffers(query, opts);
  if (outcome.status === "UNAVAILABLE") {
    await setDeal("UNAVAILABLE", outcome.reason);
    await recordFailure({ stage: "OFFER_MATCHING", code: "SOVRN_NOT_CONFIGURED", entityType: REVIEW, entityId: reviewId, normalizedReviewId: reviewId });
    return { status: "UNAVAILABLE", reason: outcome.reason, selected: [] };
  }
  if (outcome.status !== "OK" && outcome.status !== "EMPTY") {
    const hadMatches = await db.sovrnOfferMatch.count({ where: { normalizedReviewId: reviewId, isBestOffer: true } });
    if (hadMatches) await db.sovrnOfferMatch.updateMany({ where: { normalizedReviewId: reviewId, matchStatus: "MATCHED" }, data: { matchStatus: "STALE" } });
    const status = hadMatches ? "STALE" : "FAILED";
    await setDeal(status, outcome.message);
    const code = outcome.status === "TIMEOUT" ? "SOVRN_TIMEOUT" : outcome.status === "INVALID_RESPONSE" ? "SOVRN_RESPONSE_INVALID" : "SOVRN_PROVIDER_ERROR";
    await recordFailure({ stage: "OFFER_MATCHING", code, message: outcome.message, entityType: REVIEW, entityId: reviewId, normalizedReviewId: reviewId });
    return { status, reason: outcome.message, selected: [] };
  }
  await resolveFailures({ stage: "OFFER_MATCHING", entityType: REVIEW, entityId: reviewId, codes: ["SOVRN_NOT_CONFIGURED", "SOVRN_TIMEOUT", "SOVRN_PROVIDER_ERROR", "SOVRN_RESPONSE_INVALID"] });

  const ranked = rankOffers(query, outcome.offers, { minScore: config.sovrn.minScore(), trustedMerchants: config.sovrn.trustedMerchants() });
  let viable = ranked.filter((r) => r.viable);
  let reasonPrefix = "";

  if (review.sovrnDealIdOverride) {
    const forced = ranked.find((r) => r.offer.offerId === review.sovrnDealIdOverride);
    if (!forced) {
      await recordFailure({
        stage: "OFFER_MATCHING",
        code: "SOVRN_DEAL_ID_NOT_FOUND",
        message: `Deal ID override "${review.sovrnDealIdOverride}" not found among ${ranked.length} provider offers for "${outcome.queryKey}"`,
        entityType: REVIEW,
        entityId: reviewId,
        normalizedReviewId: reviewId,
      });
      viable = [];
      reasonPrefix = "deal ID override not found; ";
    } else {
      await resolveFailures({ stage: "OFFER_MATCHING", entityType: REVIEW, entityId: reviewId, codes: ["SOVRN_DEAL_ID_NOT_FOUND"] });
      viable = [forced, ...viable.filter((r) => r !== forced)];
      reasonPrefix = "admin deal ID override; ";
    }
  }

  const keepIds = new Set<string>();
  const selected: OfferStageResult["selected"] = [];
  const toPersist = [...viable.slice(0, 10), ...ranked.filter((r) => !r.viable && !viable.includes(r)).slice(0, 3)];
  for (const [index, r] of toPersist.entries()) {
    const isViable = viable.includes(r);
    const isBest = isViable && index === 0;
    const data = {
      cacheId: outcome.cacheId,
      title: r.offer.title,
      merchantName: r.offer.merchantName ?? null,
      merchantId: r.offer.merchantId ?? null,
      offerUrl: r.offer.offerUrl,
      providerAffiliateUrl: r.offer.providerAffiliateUrl ?? null,
      price: r.offer.price ?? null,
      currency: r.offer.currency ?? null,
      availability: r.offer.availability ?? null,
      imageUrl: r.offer.imageUrl ?? null,
      score: r.breakdown.total,
      scoreBreakdown: r.breakdown as unknown as Prisma.InputJsonValue,
      isBestOffer: isBest,
      rank: index + 1,
      matchStatus: isViable ? ("MATCHED" as const) : ("BELOW_THRESHOLD" as const),
      selectionReason: isBest ? reasonPrefix + selectionReason(r, viable[1]) : null,
    };
    const row = await db.sovrnOfferMatch.upsert({
      where: { normalizedReviewId_offerId: { normalizedReviewId: reviewId, offerId: r.offer.offerId } },
      create: { normalizedReviewId: reviewId, offerId: r.offer.offerId, ...data },
      update: data,
    });
    keepIds.add(row.id);
    if (isViable && selected.length < 1 + config.sovrn.alternates()) selected.push({ matchId: row.id, ranked: r, isBest });
  }
  await db.sovrnOfferMatch.updateMany({ where: { normalizedReviewId: reviewId, id: { notIn: [...keepIds] } }, data: { matchStatus: "SUPERSEDED", isBestOffer: false } });

  if (!viable.length) {
    const reason = `${reasonPrefix}${outcome.offers.length} offer(s) returned for "${outcome.queryKey}", none above match threshold ${config.sovrn.minScore()}`;
    await setDeal("NO_MATCH", reason);
    if (!review.sovrnDealIdOverride) {
      await recordFailure({ stage: "OFFER_MATCHING", code: "SOVRN_NO_MATCH", message: reason, entityType: REVIEW, entityId: reviewId, normalizedReviewId: reviewId });
    }
    await db.affiliateLink.updateMany({ where: { normalizedReviewId: reviewId, isActive: true }, data: { isActive: false, isBest: false } });
    return { status: "NO_MATCH", reason, selected: [] };
  }
  await resolveFailures({ stage: "OFFER_MATCHING", entityType: REVIEW, entityId: reviewId, codes: ["SOVRN_NO_MATCH"] });
  const reason = `${reasonPrefix}best offer ${viable[0].offer.offerId} score ${viable[0].breakdown.total}${outcome.fromCache ? " (cached response)" : ""}`;
  await setDeal("MATCHED", reason);
  log.info("offers matched", { stage: "OFFER_MATCHING", reviewId, offers: outcome.offers.length, viable: viable.length, best: viable[0].offer.offerId, score: viable[0].breakdown.total });
  return { status: "MATCHED", reason, selected };
}

// ─── AFFILIATE_LINK ─────────────────────────────────────────────────────────

export async function runAffiliateStage(reviewId: string, selected: OfferStageResult["selected"]): Promise<AffiliateLink[]> {
  const links: AffiliateLink[] = [];
  const keep: string[] = [];
  for (const s of selected) {
    const generated = generateAffiliateUrl(s.ranked.offer, { wrapperUrl: config.sovrn.linkWrapperUrl(), siteKey: config.sovrn.siteKey() });
    if (!generated.ok) {
      await recordFailure({
        stage: "AFFILIATE_LINK",
        code: "AFFILIATE_URL_INVALID",
        message: `Offer ${s.ranked.offer.offerId}: ${generated.reason}`,
        entityType: REVIEW,
        entityId: `${reviewId}:${s.ranked.offer.offerId}`,
        normalizedReviewId: reviewId,
      });
      continue;
    }
    await resolveFailures({ stage: "AFFILIATE_LINK", entityType: REVIEW, entityId: `${reviewId}:${s.ranked.offer.offerId}` });
    const existing = await db.affiliateLink.findUnique({ where: { normalizedReviewId_sovrnOfferId: { normalizedReviewId: reviewId, sovrnOfferId: s.ranked.offer.offerId } } });
    const changed = !existing || existing.affiliateUrl !== generated.affiliateUrl;
    const link = await db.affiliateLink.upsert({
      where: { normalizedReviewId_sovrnOfferId: { normalizedReviewId: reviewId, sovrnOfferId: s.ranked.offer.offerId } },
      create: {
        normalizedReviewId: reviewId,
        offerMatchId: s.matchId,
        sovrnOfferId: s.ranked.offer.offerId,
        affiliateUrl: generated.affiliateUrl,
        destinationUrl: generated.destinationUrl,
        generationMethod: generated.method,
        isBest: s.isBest,
        isActive: true,
        nextVerificationAt: new Date(),
      },
      update: {
        offerMatchId: s.matchId,
        affiliateUrl: generated.affiliateUrl,
        destinationUrl: generated.destinationUrl,
        generationMethod: generated.method,
        isBest: s.isBest,
        isActive: true,
        ...(changed ? { verificationStatus: "PENDING" as const, verificationReason: "affiliate URL changed; awaiting verification", nextVerificationAt: new Date() } : {}),
      },
    });
    keep.push(link.id);
    links.push(link);
  }
  await db.affiliateLink.updateMany({ where: { normalizedReviewId: reviewId, id: { notIn: keep }, isActive: true }, data: { isActive: false, isBest: false } });
  log.info("affiliate links generated", { stage: "AFFILIATE_LINK", reviewId, links: links.length });
  return links;
}

// ─── LINK_VERIFICATION ──────────────────────────────────────────────────────

export async function verifyLinkRecord(link: Pick<AffiliateLink, "id" | "affiliateUrl" | "destinationUrl" | "normalizedReviewId" | "verificationAttempts">) {
  const outcome = await verifyAffiliateLink(link.affiliateUrl, link.destinationUrl);
  const attempts = outcome.status === "VERIFIED_OK" ? 0 : link.verificationAttempts + 1;
  const now = new Date();
  const updated = await db.affiliateLink.update({
    where: { id: link.id },
    data: {
      verificationStatus: outcome.status,
      verificationReason: outcome.reason.slice(0, 500),
      httpStatus: outcome.httpStatus ?? null,
      redirectChain: outcome.chain as unknown as Prisma.InputJsonValue,
      finalUrl: outcome.finalUrl ?? null,
      verificationAttempts: attempts,
      lastVerifiedAt: now,
      nextVerificationAt: new Date(now.getTime() + nextVerificationDelayMs(outcome.status, attempts)),
    },
  });
  if (outcome.status === "VERIFIED_OK") {
    await resolveFailures({ stage: "LINK_VERIFICATION", entityType: "affiliate_link", entityId: link.id });
  } else {
    await recordFailure({
      stage: "LINK_VERIFICATION",
      code: outcome.status === "TIMEOUT" ? "LINK_VERIFICATION_TIMEOUT" : "LINK_VERIFICATION_FAILED",
      message: `${outcome.status}: ${outcome.reason}`,
      entityType: "affiliate_link",
      entityId: link.id,
      normalizedReviewId: link.normalizedReviewId,
      retryable: outcome.retryable,
    });
  }
  log.info("link verified", { stage: "LINK_VERIFICATION", linkId: link.id, status: outcome.status, httpStatus: outcome.httpStatus, hops: outcome.chain.length });
  return { link: updated, outcome };
}

export async function runVerificationStage(links: AffiliateLink[]) {
  const results = [];
  for (const link of links) {
    if (link.verificationStatus !== "PENDING" && link.nextVerificationAt && link.nextVerificationAt > new Date()) continue;
    results.push(await verifyLinkRecord(link));
  }
  return results;
}
