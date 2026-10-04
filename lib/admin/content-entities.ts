import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  entityKey,
  resolveEntity,
  type ContentEntityRole,
} from "@/lib/entities/resolve";
import { audit, type AuditContext } from "@/lib/security/audit";
import { CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";
import { slugify } from "@/lib/util/text";

/**
 * Editor control over which products an article covers. The source article is never changed:
 * these are links. Editor links are kept on reprocessing, and a product an editor removed is
 * never re-added automatically.
 */

type Extra = {
  removedEntities?: string[];
  contentKind?: "REVIEW" | "COMPARISON" | "BUYING_GUIDE";
};

async function editorState(reviewId: string) {
  const review = await db.normalizedReview.findUniqueOrThrow({
    where: { id: reviewId },
    select: { productName: true, brand: true, source: true },
  });
  const row = await db.extractedEntities.upsert({
    where: { normalizedReviewId: reviewId },
    create: {
      normalizedReviewId: reviewId,
      productName: review.productName,
      brand: review.brand,
      source: review.source,
      confidences: {},
      overallConfidence: 0,
    },
    update: {},
  });
  return {
    overrides: {
      ...((row.overrides ?? {}) as Record<string, unknown>),
    } as Record<string, unknown> & Extra,
  };
}

async function saveState(reviewId: string, overrides: Record<string, unknown>) {
  await db.extractedEntities.update({
    where: { normalizedReviewId: reviewId },
    data: { overrides: overrides as Prisma.InputJsonValue },
  });
}

export const ROLES: ContentEntityRole[] = ["PRIMARY", "COMPARED", "MENTIONED"];

export async function addContentEntity(
  reviewId: string,
  input: { name: string; role: ContentEntityRole; brand?: string | null },
  ctx: AuditContext,
) {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 120)
    throw new Error("Product name must be 2–120 characters");
  const review = await db.normalizedReview.findUniqueOrThrow({
    where: { id: reviewId },
    select: { categorySlug: true, subcategorySlug: true },
  });
  const entity = await resolveEntity(name, {
    brand: input.brand || null,
    categorySlug: review.categorySlug,
    subcategorySlug: review.subcategorySlug,
  });
  const count = await db.contentEntity.count({
    where: { normalizedReviewId: reviewId },
  });
  await db.contentEntity.upsert({
    where: {
      normalizedReviewId_productEntityId: {
        normalizedReviewId: reviewId,
        productEntityId: entity.id,
      },
    },
    create: {
      normalizedReviewId: reviewId,
      productEntityId: entity.id,
      role: input.role,
      position: count,
      confidence: 1,
      source: "ADMIN",
    },
    update: { role: input.role, confidence: 1, source: "ADMIN" },
  });
  const { overrides } = await editorState(reviewId);
  if (overrides.removedEntities?.includes(entity.id)) {
    overrides.removedEntities = overrides.removedEntities.filter(
      (e) => e !== entity.id,
    );
    await saveState(reviewId, overrides);
  }
  await audit(ctx, {
    action: "content.entity.add",
    entityType: "normalized_review",
    entityId: reviewId,
    after: { entity: entity.name, entityId: entity.id, role: input.role },
  });
  return entity;
}

export async function removeContentEntity(
  reviewId: string,
  productEntityId: string,
  ctx: AuditContext,
) {
  const link = await db.contentEntity.findUnique({
    where: {
      normalizedReviewId_productEntityId: {
        normalizedReviewId: reviewId,
        productEntityId,
      },
    },
    include: { entity: { select: { name: true } } },
  });
  if (!link) throw new Error("That product is not linked to this article");
  await db.contentEntity.delete({ where: { id: link.id } });
  const { overrides } = await editorState(reviewId);
  overrides.removedEntities = [
    ...new Set([...(overrides.removedEntities ?? []), productEntityId]),
  ];
  await saveState(reviewId, overrides);
  await audit(ctx, {
    action: "content.entity.remove",
    entityType: "normalized_review",
    entityId: reviewId,
    before: {
      entity: link.entity.name,
      entityId: productEntityId,
      role: link.role,
    },
  });
}

/** Edits the shared product record (affects every article that links it). Renames keep the old name as an alias. */
export async function updateProductEntity(
  productEntityId: string,
  input: {
    name?: string;
    brand?: string | null;
    categorySlug?: string | null;
    subcategorySlug?: string | null;
  },
  ctx: AuditContext,
) {
  const before = await db.productEntity.findUniqueOrThrow({
    where: { id: productEntityId },
  });
  const data: Prisma.ProductEntityUpdateInput = {};
  if (
    input.name !== undefined &&
    input.name.trim() &&
    input.name.trim() !== before.name
  ) {
    const name = input.name.trim();
    const key = entityKey(name);
    const clash = await db.productEntity.findFirst({
      where: {
        id: { not: productEntityId },
        OR: [{ matchKey: key }, { aliasKeys: { has: key } }],
      },
      select: { name: true },
    });
    if (clash)
      throw new Error(
        `"${name}" is already the product "${clash.name}". Link that product instead.`,
      );
    Object.assign(data, {
      name,
      matchKey: key,
      aliases: [...new Set([...before.aliases, before.name])],
      aliasKeys: [...new Set([...before.aliasKeys, before.matchKey])],
    });
  }
  if (input.brand !== undefined)
    Object.assign(data, {
      brand: input.brand?.trim() || null,
      brandSlug: input.brand?.trim() ? slugify(input.brand.trim(), 60) : null,
    });
  if (input.categorySlug !== undefined) {
    const cat = input.categorySlug || null;
    if (cat && !CATEGORY_BY_SLUG.has(cat))
      throw new Error(`Unknown category ${cat}`);
    const sub = cat && input.subcategorySlug ? input.subcategorySlug : null;
    if (
      sub &&
      !CATEGORY_BY_SLUG.get(cat!)?.subcategories.some((s) => s.slug === sub)
    )
      throw new Error(`Unknown subcategory ${sub} for ${cat}`);
    Object.assign(data, { categorySlug: cat, subcategorySlug: sub });
  }
  const after = await db.productEntity.update({
    where: { id: productEntityId },
    data,
  });
  await audit(ctx, {
    action: "product.entity.update",
    entityType: "product_entity",
    entityId: productEntityId,
    before,
    after,
  });
  return after;
}

/** Sets (or clears, with null) the editor's content kind for an article. */
export async function setContentKind(
  reviewId: string,
  kind: Extra["contentKind"] | null,
  ctx: AuditContext,
) {
  const { overrides } = await editorState(reviewId);
  const before = overrides.contentKind ?? null;
  if (kind) overrides.contentKind = kind;
  else delete overrides.contentKind;
  await saveState(reviewId, overrides);
  await audit(ctx, {
    action: "content.kind.set",
    entityType: "normalized_review",
    entityId: reviewId,
    before: { kind: before },
    after: { kind },
  });
}
