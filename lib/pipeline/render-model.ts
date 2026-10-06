import type { ImageSourceType, LicenseState, Prisma } from "@prisma/client";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { loadRetailerLinks, type RetailerLink } from "@/lib/public/retailer-links";
import { categoryName, subcategoryName } from "@/lib/taxonomy/definitions";
import { paragraphs, sha256, stableStringify, truncateWords } from "@/lib/util/text";
import { AI_GUIDE_SOURCE } from "./ai-guides";
import { contentSourceName } from "./content-source";
import { PLACEHOLDER_SIZE, publicImageUrl, relevantImage } from "./images";

/**
 * Stage PAGE_RENDER. The PageRenderModel is the complete, public-safe description of a
 * review page. It contains no internal verification/debug data. Deal data inside the model
 * is a publish-time snapshot; the page overlays live verified offers at request time.
 */

/** Bump whenever the model shape or a rights rule changes: older stored models are rebuilt on read. */
export const RENDER_MODEL_VERSION = 8;

export type PublicDeal = {
  linkId: string;
  merchant: string | null;
  price: number | null;
  currency: string | null;
  availability: string | null;
  verifiedAt: string;
  isBest: boolean;
};

/** A Sovrn-verified promo code. Shown only while verifiedAt is recent (see couponIsCurrent). */
export type PublicCoupon = {
  id: string;
  code: string;
  description: string | null;
  merchant: string | null;
  originalPrice: number | null;
  priceWithCode: number | null;
  currency: string;
  verifiedAt: string;
};

/** A code is shown only while Sovrn verified it within SOVRN_COUPON_MAX_AGE_DAYS; the API has no expiry date. */
export function couponIsCurrent(c: Pick<PublicCoupon, "verifiedAt">, now = Date.now(), maxAgeDays = config.sovrn.couponMaxAgeDays()): boolean {
  const t = Date.parse(c.verifiedAt);
  return Number.isFinite(t) && now - t <= maxAgeDays * 86_400_000 && t <= now + 86_400_000;
}

export async function activeCoupons(reviewId: string): Promise<PublicCoupon[]> {
  const rows = await db.sovrnCoupon.findMany({ where: { normalizedReviewId: reviewId, isActive: true, verified: true, verifiedAt: { not: null } }, orderBy: [{ rank: "asc" }], take: 3 });
  return rows
    .map((c) => ({ id: c.id, code: c.code, description: c.description, merchant: c.merchantName ?? c.merchantDomain, originalPrice: c.originalPrice, priceWithCode: c.priceWithCode, currency: c.currency, verifiedAt: c.verifiedAt!.toISOString() }))
    .filter((c) => couponIsCurrent(c));
}

/** The public subset of a product's resolved facts: values with their source, never internal scores. */
export type ProductData = {
  fields: Record<string, { value: string | number | string[] | null; unit?: string | null; status: string; sourceName: string | null; source: string | null; observedAt: string | null }>;
  priceTier: { tier: string; methodology: string } | null;
  platform: "NOT_APPLICABLE" | null;
};

function productDataOf(summary: unknown): ProductData | null {
  const s = summary as { fields?: Record<string, { value: unknown; unit?: string | null; status: string; sourceName: string | null; source: string | null; observedAt: string | null }>; priceTier?: ProductData["priceTier"]; platform?: ProductData["platform"] } | null;
  if (!s?.fields) return null;
  const fields: ProductData["fields"] = {};
  // Only values a source stated and that are current and undisputed reach the page.
  for (const [k, f] of Object.entries(s.fields)) if ((f.status === "VERIFIED" || f.status === "SUPPORTED") && f.value != null) fields[k] = { value: f.value as ProductData["fields"][string]["value"], unit: f.unit ?? null, status: f.status, sourceName: f.sourceName, source: f.source, observedAt: f.observedAt };
  return { fields, priceTier: s.priceTier ?? null, platform: s.platform ?? null };
}

export type PageRenderModel = {
  version: number;
  reviewId: string;
  kind: "REVIEW" | "AI_GUIDE" | "COMPARISON" | "BUYING_GUIDE";
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
  /** Older persisted models have no value: treat as FULL (licensed feed or our own guide). */
  textRights?: "FULL" | "EXCERPT";
  /** The source's own pros and cons (from its structured data), shown only with full-text rights. */
  highlights?: { pros: string[]; cons: string[] } | null;
  /** subject ILLUSTRATIVE: a topic photo, captioned as such; never presented as the product. */
  image: { url: string; alt: string; width: number; height: number; attribution: string | null; attributionUrl: string | null; isFallback: boolean; subject: "PRODUCT" | "ILLUSTRATIVE" | null };
  keyEntities: Array<{ label: string; value: string }>;
  /** For AI-assisted guides: who approved publication (an editor, or the automated QA gates). */
  approval?: "EDITOR" | "AUTOMATED" | null;
  /** Keyword-to-Blog post type: an informational ARTICLE or a buying GUIDE. */
  articleType?: "ARTICLE" | "GUIDE" | null;
  /** Products/services this content covers (one for a review, several for a comparison). */
  products: Array<{ name: string; slug: string; role: string; brand: string | null }>;
  /** Resolved, provenance-carrying facts for the single product a review covers (lib/products). */
  productData?: ProductData | null;
  rating: { value: number; scale: number } | null;
  deals: PublicDeal[];
  coupons?: PublicCoupon[];
  /** Direct "where to buy" links built only from stored URLs (lib/public/retailer-links.ts). Never a price or a deal. */
  retailerLinks?: Array<Pick<RetailerLink, "url" | "label" | "merchant" | "kind">>;
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
    editorApprovedBy?: string | null;
    generationMeta?: unknown;
    sourceData?: unknown;
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
    kind?: "REVIEW" | "AI_GUIDE" | "COMPARISON" | "BUYING_GUIDE";
    sourceUrl: string | null;
    author: string | null;
    sourcePublishedAt: Date | null;
    publishedAt: Date | null;
    updatedAt: Date;
  };
  entities: { brand: string | null; productName: string; modelNumber: string | null; deviceType: string | null; platform: string | null; useCase: string | null; rating: number | null; ratingScale: number | null; source: string } | null;
  assignments: Array<{ tagType: string; isPrimary: boolean; confidence: number; categoryTag: { slug: string; name: string } }>;
  image: { sourceType: ImageSourceType; sourceUrl: string | null; cdnUrl: string | null; licenseState: LicenseState; width: number | null; height: number | null; attribution: string | null; attributionUrl?: string | null; subject?: string | null; altText?: string | null } | null | undefined;
  deals: PublicDeal[];
  coupons?: PublicCoupon[];
  /** EXCERPT for scraped third-party sources we may not republish in full. */
  textRights?: "FULL" | "EXCERPT";
  products?: PageRenderModel["products"];
  productData?: ProductData | null;
  retailerLinks?: RetailerLink[];
};

/** Pure composition of the PageRenderModel (shared by the DB builder and the dry-run). */
function sourceHighlights(data: unknown): { pros: string[]; cons: string[] } | null {
  const d = (data ?? {}) as { pros?: unknown; cons?: unknown };
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, 8) : []);
  const pros = list(d.pros);
  const cons = list(d.cons);
  return pros.length || cons.length ? { pros, cons } : null;
}

export function composeRenderModel({ review, entities: e, assignments, image, deals, coupons = [], textRights = "FULL", products = [], productData = null, retailerLinks = [] }: RenderInputs): PageRenderModel {
  const byType = (type: string) => assignments.filter((a) => a.tagType === type).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || b.confidence - a.confidence);
  const tag = (a?: { categoryTag: { slug: string; name: string } }) => (a ? { slug: a.categoryTag.slug, name: a.categoryTag.name } : null);
  // Only a relevant image is shown; a failing stock photo falls back to the neutral category image.
  const shown = relevantImage(image, { productName: review.productName, title: review.canonicalTitle, categorySlug: review.categorySlug, subcategorySlug: review.subcategorySlug, singleProduct: (review.kind ?? "REVIEW") === "REVIEW" || products.some((p) => p.role === "PRIMARY") });
  const pub = publicImageUrl(shown, review.categorySlug);

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
    kind: review.kind ?? "REVIEW",
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
    // Excerpt-only sources: the full text stays private (used for extraction); the page links out.
    bodyParagraphs: textRights === "EXCERPT" ? [] : paragraphs(review.body),
    textRights,
    highlights: textRights === "EXCERPT" ? null : sourceHighlights(review.sourceData),
    image: {
      url: pub.url,
      alt: pub.isFallback
        ? `${categoryName(categorySlug) ?? "Category"} illustration`
        : image?.subject === "ILLUSTRATIVE"
          ? `Illustrative photo${image.altText ? `: ${image.altText}` : ""}`
          : (image?.altText ?? `${review.productName}${review.brand && !review.productName.startsWith(review.brand) ? ` by ${review.brand}` : ""}`),
      width: (!pub.isFallback && image?.width) || PLACEHOLDER_SIZE.width,
      height: (!pub.isFallback && image?.height) || PLACEHOLDER_SIZE.height,
      attribution: !pub.isFallback ? image?.attribution ?? null : null,
      attributionUrl: !pub.isFallback ? image?.attributionUrl ?? null : null,
      isFallback: pub.isFallback,
      subject: pub.isFallback ? null : image?.subject === "ILLUSTRATIVE" ? "ILLUSTRATIVE" : "PRODUCT",
    },
    keyEntities,
    articleType: review.kind === "AI_GUIDE" ? ((review.generationMeta as { articleType?: string } | null)?.articleType === "ARTICLE" ? "ARTICLE" : "GUIDE") : null,
    approval: review.kind === "AI_GUIDE" ? (review.editorApprovedBy?.startsWith("automation:") ? "AUTOMATED" : review.editorApprovedBy ? "EDITOR" : null) : null,
    products,
    productData,
    // A rating belongs to a single-product review; comparisons and guides never carry one.
    rating: (review.kind ?? "REVIEW") === "REVIEW" && e?.rating != null && e.ratingScale ? { value: e.rating, scale: e.ratingScale } : null,
    deals,
    coupons,
    retailerLinks: retailerLinks.map(({ url, label, merchant, kind }) => ({ url, label, merchant, kind })),
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
      contentEntities: { orderBy: { position: "asc" }, include: { entity: { select: { name: true, slug: true, brand: true } } } },
    },
  });
  const products = review.contentEntities.map((c) => ({ name: c.entity.name, slug: c.entity.slug, role: c.role, brand: c.entity.brand }));
  const primary = review.contentEntities.find((c) => c.role === "PRIMARY");
  const productData = primary ? productDataOf((await db.productEntity.findUnique({ where: { id: primary.productEntityId }, select: { factSummary: true } }))?.factSummary) : null;
  return composeRenderModel({ review, entities: review.entities, assignments: review.assignments, image: review.images[0], deals: await verifiedDeals(review.id), coupons: await activeCoupons(review.id), textRights: await textRightsFor(review.source), products, productData, retailerLinks: await loadRetailerLinks(review.id) });
}

/**
 * Fails closed: full text only for our own AI-assisted guides, the contracted Content API feed
 * and Apify sources marked LICENSED. Every other source is excerpt-only.
 */
export async function textRightsFor(source: string): Promise<"FULL" | "EXCERPT"> {
  if (source === AI_GUIDE_SOURCE) return "FULL";
  if (config.contentApi.url() && source === contentSourceName()) return "FULL";
  if (!source.startsWith("apify:")) return "EXCERPT";
  const row = await db.reviewSource.findUnique({ where: { slug: source.slice("apify:".length) }, select: { rights: true } });
  return row?.rights === "LICENSED" ? "FULL" : "EXCERPT";
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
