import type { AssignmentSource, Prisma, TagType } from "@prisma/client";
import { db } from "@/lib/db";
import { CATEGORIES, INTENTS, PLATFORMS, PRICE_TIERS } from "./definitions";
import type { Classification, TagDecision } from "./classify";

/** Seeds category_tags from definitions (idempotent) and persists classification results. */

type Client = Prisma.TransactionClient | typeof db;

let seeded: Promise<void> | undefined;

export function ensureTaxonomySeeded(): Promise<void> {
  seeded ??= seedTaxonomy().catch((error) => {
    seeded = undefined;
    throw error;
  });
  return seeded;
}

export async function seedTaxonomy(client: Client = db): Promise<void> {
  let order = 0;
  for (const cat of CATEGORIES) {
    const parent = await client.categoryTag.upsert({
      where: { type_slug: { type: "CATEGORY", slug: cat.slug } },
      create: { type: "CATEGORY", slug: cat.slug, name: cat.name, description: cat.description, sortOrder: order++ },
      update: { name: cat.name, description: cat.description, active: true },
    });
    let subOrder = 0;
    for (const sub of cat.subcategories) {
      await client.categoryTag.upsert({
        where: { type_slug: { type: "SUBCATEGORY", slug: sub.slug } },
        create: { type: "SUBCATEGORY", slug: sub.slug, name: sub.name, parentId: parent.id, sortOrder: subOrder++ },
        update: { name: sub.name, parentId: parent.id, active: true },
      });
    }
  }
  const flat: Array<[TagType, Array<{ slug: string; name: string }>]> = [
    ["INTENT", INTENTS],
    ["PLATFORM", PLATFORMS],
    ["PRICE_TIER", PRICE_TIERS],
  ];
  for (const [type, defs] of flat) {
    let i = 0;
    for (const def of defs) {
      await client.categoryTag.upsert({
        where: { type_slug: { type, slug: def.slug } },
        create: { type, slug: def.slug, name: def.name, sortOrder: i++ },
        update: { name: def.name, active: true },
      });
    }
  }
}

async function tagId(client: Client, type: TagType, slug: string): Promise<string> {
  const tag = await client.categoryTag.findUnique({ where: { type_slug: { type, slug } }, select: { id: true } });
  if (!tag) throw new Error(`Unknown ${type} tag "${slug}"`);
  return tag.id;
}

/**
 * Replaces rules-based assignments for one tag type with new decisions, idempotently:
 * identical slugs are updated in place (preserving admin accept/reject state); overrides
 * for the type are never touched by automated re-classification.
 */
async function syncType(client: Client, reviewId: string, type: TagType, decisions: TagDecision[]) {
  const active = await client.reviewCategoryAssignment.findMany({
    where: { normalizedReviewId: reviewId, tagType: type, active: true },
    include: { categoryTag: { select: { slug: true } } },
  });
  if (active.some((a) => a.isOverride)) return;
  const wanted = new Map(decisions.map((d, i) => [d.slug, { d, primary: i === 0 }]));
  for (const a of active) {
    const keep = wanted.get(a.categoryTag.slug);
    if (keep) {
      await client.reviewCategoryAssignment.update({
        where: { id: a.id },
        data: { confidence: keep.d.confidence, reason: keep.d.reason, source: keep.d.source as AssignmentSource, isPrimary: keep.primary },
      });
      wanted.delete(a.categoryTag.slug);
    } else {
      await client.reviewCategoryAssignment.update({ where: { id: a.id }, data: { active: false, isPrimary: false } });
    }
  }
  for (const [slug, { d, primary }] of wanted) {
    await client.reviewCategoryAssignment.create({
      data: {
        normalizedReviewId: reviewId,
        categoryTagId: await tagId(client, type, slug),
        tagType: type,
        confidence: d.confidence,
        reason: d.reason,
        source: d.source as AssignmentSource,
        isPrimary: primary,
      },
    });
  }
}

export async function persistClassification(reviewId: string, c: Classification, client: Client = db) {
  await syncType(client, reviewId, "CATEGORY", c.category ? [c.category] : []);
  await syncType(client, reviewId, "SUBCATEGORY", c.subcategory ? [c.subcategory] : []);
  await syncType(client, reviewId, "INTENT", c.intents);
  await syncType(client, reviewId, "PLATFORM", c.platforms);
  await syncType(client, reviewId, "PRICE_TIER", c.priceTier ? [c.priceTier] : []);
  return refreshReviewTaxonomy(reviewId, client);
}

/** Denormalises the active primary category/subcategory onto the review row for fast public queries. */
export async function refreshReviewTaxonomy(reviewId: string, client: Client = db) {
  const primary = await client.reviewCategoryAssignment.findMany({
    where: { normalizedReviewId: reviewId, active: true, isPrimary: true, tagType: { in: ["CATEGORY", "SUBCATEGORY"] } },
    include: { categoryTag: { select: { slug: true } } },
  });
  const category = primary.find((a) => a.tagType === "CATEGORY");
  const sub = primary.find((a) => a.tagType === "SUBCATEGORY");
  const confidence = category ? (category.isOverride || category.reviewState === "ACCEPTED" ? 1 : category.confidence) : 0;
  await client.normalizedReview.update({
    where: { id: reviewId },
    data: { categorySlug: category?.categoryTag.slug ?? null, subcategorySlug: sub?.categoryTag.slug ?? null, classificationConfidence: confidence },
  });
  return { categorySlug: category?.categoryTag.slug ?? null, subcategorySlug: sub?.categoryTag.slug ?? null, confidence };
}

/** Admin / CSV override of a tag type. The superseded assignment is recorded as REJECTED (or ACCEPTED if unchanged). */
export async function overrideAssignment(
  reviewId: string,
  type: TagType,
  slug: string,
  actor: string,
  source: "ADMIN" | "CSV",
  client: Client = db,
) {
  const id = await tagId(client, type, slug);
  if (type === "SUBCATEGORY") {
    const review = await client.normalizedReview.findUnique({ where: { id: reviewId }, select: { categorySlug: true } });
    const sub = await client.categoryTag.findUnique({ where: { id }, include: { parent: { select: { slug: true } } } });
    if (sub?.parent?.slug && review?.categorySlug && sub.parent.slug !== review.categorySlug) {
      throw new Error(`Subcategory "${slug}" belongs to ${sub.parent.slug}, not ${review.categorySlug}`);
    }
  }
  const now = new Date();
  const current = await client.reviewCategoryAssignment.findMany({ where: { normalizedReviewId: reviewId, tagType: type, active: true } });
  for (const a of current) {
    await client.reviewCategoryAssignment.update({
      where: { id: a.id },
      data: {
        active: false,
        isPrimary: false,
        reviewState: a.categoryTagId === id ? "ACCEPTED" : a.reviewState === "UNREVIEWED" ? "REJECTED" : a.reviewState,
        reviewedAt: a.reviewState === "UNREVIEWED" ? now : a.reviewedAt,
        reviewedBy: a.reviewState === "UNREVIEWED" ? actor : a.reviewedBy,
      },
    });
  }
  await client.reviewCategoryAssignment.create({
    data: {
      normalizedReviewId: reviewId,
      categoryTagId: id,
      tagType: type,
      confidence: 1,
      reason: `${source === "CSV" ? "CSV import" : "admin"} override by ${actor}`,
      source,
      isPrimary: true,
      isOverride: true,
      overrideSource: `${source}:${actor}`,
      reviewState: "ACCEPTED",
      reviewedAt: now,
      reviewedBy: actor,
    },
  });
  if (type === "CATEGORY") {
    // A category change invalidates a subcategory that belonged to the old category.
    const subs = await client.reviewCategoryAssignment.findMany({
      where: { normalizedReviewId: reviewId, tagType: "SUBCATEGORY", active: true },
      include: { categoryTag: { include: { parent: { select: { slug: true } } } } },
    });
    for (const s of subs) {
      if (s.categoryTag.parent?.slug !== slug) await client.reviewCategoryAssignment.update({ where: { id: s.id }, data: { active: false, isPrimary: false } });
    }
  }
  return refreshReviewTaxonomy(reviewId, client);
}

export async function reviewAssignment(assignmentId: string, decision: "ACCEPTED" | "REJECTED", actor: string, client: Client = db) {
  const a = await client.reviewCategoryAssignment.update({
    where: { id: assignmentId },
    data: { reviewState: decision, reviewedAt: new Date(), reviewedBy: actor, ...(decision === "REJECTED" ? { active: false, isPrimary: false } : {}) },
  });
  await refreshReviewTaxonomy(a.normalizedReviewId, client);
  return a;
}
