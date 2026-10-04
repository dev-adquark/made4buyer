import type { ContentKind, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { slugify } from "@/lib/util/text";

/**
 * Content kinds and product-entity resolution.
 *
 * - "tmux vs Zellij vs WezTerm" is a COMPARISON of three products, never one product named
 *   "tmux vs Zellij vs WezTerm".
 * - "Best VPNs for streaming", "X buying guide", "X alternatives" are source BUYING_GUIDEs.
 * - "NordVPN", "Nord VPN" and "nordvpn" resolve to one ProductEntity via a normalised key.
 *
 * Resolution is deterministic. Anything it cannot parse confidently is left for QA.
 */

export type ContentEntityRole = "PRIMARY" | "COMPARED" | "MENTIONED";

/** Identity key: case, spacing, punctuation and a trailing year are ignored. */
export function entityKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(19|20)\d{2}\b/g, "")
    .replace(/[^a-z0-9+#]+/g, "");
}

/** Removes the year, a trailing colon clause and bracketed asides from a title fragment. */
function cleanFragment(s: string): string {
  return s
    .replace(/\s*[:|–—-]\s+.*$/, "")
    .replace(/[([][^)\]]*[)\]]/g, "")
    .replace(/\b(19|20)\d{2}\b/g, "")
    .replace(/\b(review|compared|comparison|head-to-head)\b/gi, "")
    .replace(/[?!.,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const VS = /\s+(?:vs\.?|versus)\s+/i;

/**
 * Parses "A vs B vs C (2026): subtitle" into ["A", "B", "C"]. Returns null unless every side is a
 * plausible product name (1–5 words), so headlines that merely mention "vs" are not misread.
 */
export function parseComparisonTitle(title: string): string[] | null {
  const head = title.replace(/\s*[:|–—]\s+.*$/, "");
  if (!VS.test(head)) return null;
  const parts = head.split(VS).map(cleanFragment).filter(Boolean);
  if (parts.length < 2 || parts.length > 6) return null;
  if (
    parts.some((p) => p.split(" ").length > 5 || p.length < 2 || p.length > 60)
  )
    return null;
  const keys = parts.map(entityKey);
  if (keys.some((k) => !k) || new Set(keys).size !== keys.length) return null;
  return parts;
}

const GUIDE_PATTERNS = [
  /^(?:the\s+)?(?:\d+\s+)?best\s+\S/i,
  /^top\s+\d+\s/i,
  /\bbuying guide\b/i,
  /\balternatives\b/i,
  /\bhow to choose\b/i,
];

/** The content kind a source article actually is. AI_GUIDE is never inferred: it is set when we generate one. */
export function detectContentKind(title: string): {
  kind: Exclude<ContentKind, "AI_GUIDE">;
  compared?: string[];
} {
  const compared = parseComparisonTitle(title);
  if (compared) return { kind: "COMPARISON", compared };
  if (GUIDE_PATTERNS.some((re) => re.test(title)))
    return { kind: "BUYING_GUIDE" };
  return { kind: "REVIEW" };
}

type Client = Prisma.TransactionClient | typeof db;

/** Finds the entity for a name (by key or alias key), or creates it. */
export async function resolveEntity(
  name: string,
  hints: {
    brand?: string | null;
    categorySlug?: string | null;
    subcategorySlug?: string | null;
  } = {},
  client: Client = db,
) {
  const clean = name.replace(/\s+/g, " ").trim();
  const key = entityKey(clean);
  if (!key) throw new Error(`cannot resolve an empty product name: "${name}"`);
  const existing =
    (await client.productEntity.findUnique({ where: { matchKey: key } })) ??
    (await client.productEntity.findFirst({
      where: { aliasKeys: { has: key } },
    }));
  if (existing) {
    // Fill gaps only; never overwrite an editor's choice.
    const patch: Prisma.ProductEntityUpdateInput = {};
    if (!existing.brand && hints.brand)
      Object.assign(patch, {
        brand: hints.brand,
        brandSlug: slugify(hints.brand, 60),
      });
    if (!existing.categorySlug && hints.categorySlug)
      Object.assign(patch, {
        categorySlug: hints.categorySlug,
        subcategorySlug: hints.subcategorySlug ?? null,
      });
    if (clean !== existing.name && !existing.aliases.includes(clean))
      Object.assign(patch, { aliases: [...existing.aliases, clean] });
    return Object.keys(patch).length
      ? client.productEntity.update({ where: { id: existing.id }, data: patch })
      : existing;
  }
  let slug = slugify(clean, 80) || key;
  if (await client.productEntity.findUnique({ where: { slug } }))
    slug = `${slug}-${key.slice(0, 6)}`;
  return client.productEntity.create({
    data: {
      slug,
      name: clean,
      matchKey: key,
      brand: hints.brand ?? null,
      brandSlug: hints.brand ? slugify(hints.brand, 60) : null,
      categorySlug: hints.categorySlug ?? null,
      subcategorySlug: hints.subcategorySlug ?? null,
    },
  });
}

/**
 * Replaces the pipeline's (AUTO) entity links for a content item. Links an editor added (ADMIN)
 * are kept, and an editor-removed entity is never re-added automatically (see `blocked`).
 */
export async function setAutoEntities(
  reviewId: string,
  items: Array<{
    name: string;
    role: ContentEntityRole;
    confidence: number;
    brand?: string | null;
  }>,
  hints: { categorySlug?: string | null; subcategorySlug?: string | null } = {},
) {
  const admin = await db.contentEntity.findMany({
    where: { normalizedReviewId: reviewId, source: "ADMIN" },
    select: { productEntityId: true },
  });
  const keep = new Set(admin.map((a) => a.productEntityId));
  const blocked = new Set(
    (
      (
        await db.extractedEntities.findUnique({
          where: { normalizedReviewId: reviewId },
          select: { overrides: true },
        })
      )?.overrides as { removedEntities?: string[] } | null
    )?.removedEntities ?? [],
  );
  await db.contentEntity.deleteMany({
    where: { normalizedReviewId: reviewId, source: "AUTO" },
  });
  let position = 0;
  for (const item of items) {
    const entity = await resolveEntity(item.name, {
      brand: item.brand,
      ...hints,
    });
    if (keep.has(entity.id) || blocked.has(entity.id)) continue;
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
        role: item.role,
        position: position++,
        confidence: item.confidence,
        source: "AUTO",
      },
      update: {
        role: item.role,
        position: position++,
        confidence: item.confidence,
        source: "AUTO",
      },
    });
  }
}
