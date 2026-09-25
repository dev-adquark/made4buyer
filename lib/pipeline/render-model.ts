import type { ImageSourceType, LicenseState, Prisma } from "@prisma/client";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { categoryName, subcategoryName } from "@/lib/taxonomy/definitions";
import { paragraphs, sha256, stableStringify, truncateWords } from "@/lib/util/text";
import { PLACEHOLDER_SIZE, publicImageUrl } from "./images";

/**
 * Stage PAGE_RENDER. The PageRenderModel is the complete, public-safe description of a
 * review page. It contains no internal verification/debug data. Deal data inside the model
 * is a publish-time snapshot; the page overlays live verified offers at request time.
 */

export const RENDER_MODEL_VERSION = 1;

export type PublicDeal = {
  linkId: string;
  merchant: string | null;
  price: number | null;
  currency: string | null;
  availability: string | null;
  verifiedAt: string;
  isBest: boolean;
};

export type PageRenderModel = {
  version: number;
  reviewId: string;
  slug: string;
  canonicalPath: string;
  title: string;
  metaDescription: string;
  productName: string;
  brand: string | null;
  brandSlug: string | null;
  category: { slug: string; name: string } | null;
  subcategory: { slug: string; name: string } | null;
  intents: Array<{ slug: string; name: string }>;
  platforms: Array<{ slug: string; name: string }>;
  priceTier: { slug: string; name: string } | null;
  summary: string;
  bodyParagraphs: string[];
  image: { url: string; alt: string; width: number; height: number; attribution: string | null; isFallback: boolean };
  keyEntities: Array<{ label: string; value: string }>;
  rating: { value: number; scale: number } | null;
  deals: PublicDeal[];
  source: { name: string; url: string | null; author: string | null; publishedAt: string | null };
  publishedAt: string | null;
  updatedAt: string;
};

export async function verifiedDeals(reviewId: string): Promise<PublicDeal[]> {
  const links = await db.affiliateLink.findMany({
    where: { normalizedReviewId: reviewId, isActive: true, verificationStatus: "VERIFIED_OK" },
    include: { offerMatch: { select: { merchantName: true, price: true, currency: true, availability: true, matchStatus: true, rank: true } } },
    orderBy: [{ isBest: "desc" }, { createdAt: "asc" }],
    take: 4,
  });
  return links
    .filter((l) => l.offerMatch && l.offerMatch.matchStatus === "MATCHED")
    .map((l) => ({
      linkId: l.id,
      merchant: l.offerMatch?.merchantName ?? null,
      price: l.offerMatch?.price ?? null,
      currency: l.offerMatch?.currency ?? null,
      availability: l.offerMatch?.availability ?? null,
      verifiedAt: (l.lastVerifiedAt ?? l.updatedAt).toISOString(),
      isBest: l.isBest,
    }));
}

export type RenderInputs = {
  review: {
    id: string;
    slug: string;
    canonicalTitle: string;
    summary: string;
    body: string;
    productName: string;
    brand: string | null;
    brandSlug: string | null;
    categorySlug: string | null;
    subcategorySlug: string | null;
    source: string;
    sourceUrl: string | null;
    author: string | null;
    sourcePublishedAt: Date | null;
    publishedAt: Date | null;
    updatedAt: Date;
  };
  entities: { brand: string | null; productName: string; modelNumber: string | null; deviceType: string | null; platform: string | null; useCase: string | null; rating: number | null; ratingScale: number | null; source: string } | null;
  assignments: Array<{ tagType: string; isPrimary: boolean; confidence: number; categoryTag: { slug: string; name: string } }>;
  image: { sourceType: ImageSourceType; sourceUrl: string | null; cdnUrl: string | null; licenseState: LicenseState; width: number | null; height: number | null; attribution: string | null } | null | undefined;
  deals: PublicDeal[];
};

/** Pure composition of the PageRenderModel (shared by the DB builder and the dry-run). */
export function composeRenderModel({ review, entities: e, assignments, image, deals }: RenderInputs): PageRenderModel {
  const byType = (type: string) => assignments.filter((a) => a.tagType === type).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || b.confidence - a.confidence);
  const tag = (a?: { categoryTag: { slug: string; name: string } }) => (a ? { slug: a.categoryTag.slug, name: a.categoryTag.name } : null);
  const pub = publicImageUrl(image, review.categorySlug);

  const keyEntities: Array<{ label: string; value: string }> = [];
  if (e?.brand) keyEntities.push({ label: "Brand", value: e.brand });
  if (e?.productName) keyEntities.push({ label: "Product", value: e.productName });
  if (e?.modelNumber) keyEntities.push({ label: "Model", value: e.modelNumber });
  if (e?.deviceType) keyEntities.push({ label: "Type", value: e.deviceType });
  if (e?.platform) keyEntities.push({ label: "Platform", value: e.platform });
  if (e?.useCase) keyEntities.push({ label: "Best for", value: e.useCase });

  const categorySlug = review.categorySlug;
  return {
    version: RENDER_MODEL_VERSION,
    reviewId: review.id,
    slug: review.slug,
    canonicalPath: `/review/${review.slug}`,
    title: review.canonicalTitle,
    metaDescription: truncateWords(review.summary, 158),
    productName: review.productName,
    brand: review.brand,
    brandSlug: review.brandSlug,
    category: categorySlug ? { slug: categorySlug, name: categoryName(categorySlug) ?? categorySlug } : null,
    subcategory: review.subcategorySlug ? { slug: review.subcategorySlug, name: subcategoryName(categorySlug, review.subcategorySlug) ?? review.subcategorySlug } : null,
    intents: byType("INTENT").map((a) => tag(a)!).slice(0, 4),
    platforms: byType("PLATFORM").map((a) => tag(a)!).slice(0, 4),
    priceTier: tag(byType("PRICE_TIER")[0]),
    summary: review.summary,
    bodyParagraphs: paragraphs(review.body),
    image: {
      url: pub.url,
      alt: pub.isFallback ? `${categoryName(categorySlug) ?? "Technology"} placeholder illustration` : `${review.productName}${review.brand && !review.productName.startsWith(review.brand) ? ` by ${review.brand}` : ""}`,
      width: (!pub.isFallback && image?.width) || PLACEHOLDER_SIZE.width,
      height: (!pub.isFallback && image?.height) || PLACEHOLDER_SIZE.height,
      attribution: !pub.isFallback ? image?.attribution ?? null : null,
      isFallback: pub.isFallback,
    },
    keyEntities,
    rating: e?.rating != null && e.ratingScale ? { value: e.rating, scale: e.ratingScale } : null,
    deals,
    source: { name: e?.source ?? review.source, url: review.sourceUrl, author: review.author, publishedAt: review.sourcePublishedAt?.toISOString() ?? null },
    publishedAt: review.publishedAt?.toISOString() ?? null,
    updatedAt: review.updatedAt.toISOString(),
  };
}

export async function buildPageRenderModel(reviewId: string): Promise<PageRenderModel> {
  const review = await db.normalizedReview.findUniqueOrThrow({
    where: { id: reviewId },
    include: {
      entities: true,
      assignments: { where: { active: true }, include: { categoryTag: { select: { slug: true, name: true } } } },
      images: { where: { isPrimary: true }, take: 1 },
    },
  });
  return composeRenderModel({ review, entities: review.entities, assignments: review.assignments, image: review.images[0], deals: await verifiedDeals(review.id) });
}

export async function persistPageRenderModel(reviewId: string): Promise<PageRenderModel> {
  const model = await buildPageRenderModel(reviewId);
  // updatedAt changes on every row write; exclude it so the hash reflects page content only.
  const modelHash = sha256(stableStringify({ ...model, updatedAt: undefined }));
  const json = model as unknown as Prisma.InputJsonValue;
  await db.pageRenderModel.upsert({
    where: { normalizedReviewId: reviewId },
    create: { normalizedReviewId: reviewId, model: json, modelHash, version: RENDER_MODEL_VERSION },
    update: { model: json, modelHash, version: RENDER_MODEL_VERSION, builtAt: new Date() },
  });
  return model;
}

export function reviewUrl(slug: string): string {
  return `${config.siteUrl()}/review/${slug}`;
}
