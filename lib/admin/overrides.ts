import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { audit, type AuditContext } from "@/lib/security/audit";
import { overrideAssignment } from "@/lib/taxonomy/persist";
import { CATEGORIES, CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";
import { ensureTaxonomySeeded } from "@/lib/taxonomy/persist";
import { slugify } from "@/lib/util/text";
import type { EntityField } from "@/lib/pipeline/entities";
import type { EntityOverrides } from "@/lib/pipeline/stages";

/**
 * Override service shared by the admin UI and the CSV importer. Every change is audited
 * with before/after state. Callers re-run the affected pipeline stages afterwards.
 */

export type OverrideSource = "ADMIN" | "CSV";

export function resolveCategorySlug(value: string): string | undefined {
  const v = value.trim().toLowerCase();
  return CATEGORIES.find((c) => c.slug === v || c.name.toLowerCase() === v || slugify(c.name) === slugify(v))?.slug;
}

export function resolveSubcategorySlug(categorySlug: string, value: string): string | undefined {
  const v = value.trim().toLowerCase();
  return CATEGORY_BY_SLUG.get(categorySlug)?.subcategories.find((s) => s.slug === v || s.name.toLowerCase() === v)?.slug;
}

export async function findReviewByKey(key: string) {
  const k = key.trim();
  if (!k) return null;
  return db.normalizedReview.findFirst({ where: { OR: [{ id: k }, { slug: k }, { dedupeKey: k }] }, select: { id: true, slug: true } });
}

async function ensureEntitiesRow(reviewId: string) {
  const review = await db.normalizedReview.findUniqueOrThrow({ where: { id: reviewId }, select: { productName: true, brand: true, source: true } });
  return db.extractedEntities.upsert({
    where: { normalizedReviewId: reviewId },
    create: { normalizedReviewId: reviewId, productName: review.productName, brand: review.brand, source: review.source, confidences: {}, overallConfidence: 0 },
    update: {},
  });
}

export async function setEntityOverrides(reviewId: string, values: Partial<Record<EntityField, string | null>>, ctx: AuditContext, source: OverrideSource) {
  const entities = await ensureEntitiesRow(reviewId);
  const overrides = { ...((entities.overrides ?? {}) as EntityOverrides) };
  const before = { ...overrides };
  const now = new Date().toISOString();
  const direct: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(values) as Array<[EntityField, string | null | undefined]>) {
    if (value === undefined) continue;
    if (value === null || value.trim() === "") {
      delete overrides[field];
      continue;
    }
    overrides[field] = { value: value.trim(), source, actor: ctx.actor, at: now };
    if (field === "brand") Object.assign(direct, { brand: value.trim(), brandSlug: slugify(value.trim(), 60) });
    if (field === "productName") direct.productName = value.trim();
  }
  await db.extractedEntities.update({ where: { normalizedReviewId: reviewId }, data: { overrides: overrides as unknown as Prisma.InputJsonValue } });
  if (Object.keys(direct).length) await db.normalizedReview.update({ where: { id: reviewId }, data: direct });
  await audit(ctx, { action: `entities.override.${source.toLowerCase()}`, entityType: "normalized_review", entityId: reviewId, before, after: overrides });
}

/**
 * Confirms the current values of low-confidence entities as correct. A field with no value
 * is confirmed as "not applicable" (e.g. a round-up has no single brand).
 */
export async function confirmEntities(reviewId: string, ctx: AuditContext) {
  const entities = await db.extractedEntities.findUniqueOrThrow({ where: { normalizedReviewId: reviewId } });
  const fields = entities.lowConfidenceFields as EntityField[];
  if (!fields.length) return false;
  const overrides = { ...((entities.overrides ?? {}) as EntityOverrides) };
  const before = { ...overrides };
  const at = new Date().toISOString();
  for (const field of fields) {
    const v = (entities as unknown as Record<string, unknown>)[field];
    overrides[field] = { value: typeof v === "string" ? v : "", source: "ADMIN", actor: ctx.actor, at };
  }
  await db.extractedEntities.update({ where: { normalizedReviewId: reviewId }, data: { overrides: overrides as unknown as Prisma.InputJsonValue } });
  await audit(ctx, { action: "entities.confirm", entityType: "normalized_review", entityId: reviewId, before, after: overrides });
  return true;
}

export async function setCategoryOverride(reviewId: string, categorySlug: string, subcategorySlug: string | null | undefined, ctx: AuditContext, source: OverrideSource) {
  await ensureTaxonomySeeded();
  const before = await db.normalizedReview.findUniqueOrThrow({ where: { id: reviewId }, select: { categorySlug: true, subcategorySlug: true } });
  await overrideAssignment(reviewId, "CATEGORY", categorySlug, ctx.actor, source);
  if (subcategorySlug) await overrideAssignment(reviewId, "SUBCATEGORY", subcategorySlug, ctx.actor, source);
  const after = await db.normalizedReview.findUniqueOrThrow({ where: { id: reviewId }, select: { categorySlug: true, subcategorySlug: true } });
  await audit(ctx, { action: `category.override.${source.toLowerCase()}`, entityType: "normalized_review", entityId: reviewId, before, after });
}

export async function setDealOverride(reviewId: string, dealId: string | null, ctx: AuditContext, source: OverrideSource) {
  const before = await db.normalizedReview.findUniqueOrThrow({ where: { id: reviewId }, select: { sovrnDealIdOverride: true } });
  await db.normalizedReview.update({ where: { id: reviewId }, data: { sovrnDealIdOverride: dealId } });
  await audit(ctx, { action: `deal.override.${source.toLowerCase()}`, entityType: "normalized_review", entityId: reviewId, before, after: { sovrnDealIdOverride: dealId } });
  return before.sovrnDealIdOverride;
}
