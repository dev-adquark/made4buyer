import { cleanText, firstSentences, sha256, slugify, stableStringify, truncateWords } from "@/lib/util/text";
import { stripLeadingBrand } from "./brands";
import type { ValidatedContent } from "./validate";

/**
 * Stages NORMALIZATION + DEDUPE key derivation. Pure and deterministic.
 *
 * Dedupe key = product key | publisher host | YYYY-MM date bucket, where the product key
 * is the slugified product identity with any leading brand removed. Two items for the
 * same product from the same publisher in the same month are duplicates regardless of
 * their source IDs. Identical sourceId + contentHash re-fetches are "unchanged" duplicates.
 */

export type NormalizedCandidate = {
  source: string;
  sourceId: string;
  sourceUrl?: string;
  canonicalUrl?: string;
  canonicalTitle: string;
  slugBase: string;
  productIdentity: string;
  productIdentityFromTitle: boolean;
  summary: string;
  body: string;
  author?: string;
  publisher?: string;
  publishedAt?: Date;
  contentHash: string;
  dedupeKey: string;
};

const TITLE_MAX = 110;

export function contentHash(v: ValidatedContent): string {
  return sha256(
    stableStringify({
      title: v.title,
      body: v.body,
      summary: v.summary,
      productName: v.productName,
      brand: v.brand,
      url: v.url,
      publishedAt: v.publishedAt?.toISOString(),
      imageUrl: v.imageUrl,
      price: v.price,
      category: v.category,
      modelNumber: v.modelNumber,
    }),
  );
}

/** Derives a product name from a review headline, e.g. "Apple MacBook Air M3 review: …" → "Apple MacBook Air M3". */
export function productFromTitle(title: string): string | undefined {
  let t = cleanText(title).replace(/^(review|hands-on|tested|first look)\s*[:\-–—]\s*/i, "");
  t = t.split(/\s+[|–—]\s+|:\s+/)[0];
  t = t.replace(/\s+(long-term\s+)?(review|reviewed|hands-on|tested|first look|test)\b.*$/i, "");
  t = t.replace(/^(the\s+)?(new\s+)?/i, "").trim();
  if (t.length < 2 || t.length > 80) return undefined;
  if (/^(best|top \d+|\d+ best|how to|why|what|when|should)\b/i.test(t)) return undefined;
  return t;
}

function stripPublisherSuffix(title: string, publisher?: string, host?: string): string {
  const names = [publisher, host?.replace(/^www\./, "").split(".")[0]].filter((n): n is string => Boolean(n)).map((n) => n.toLowerCase());
  const match = title.match(/^(.*\S)\s+[|–—-]\s+([^|–—-]{2,60})$/);
  if (match && names.some((n) => match[2].toLowerCase().includes(n))) return match[1];
  return title;
}

export function canonicalTitle(v: Pick<ValidatedContent, "title" | "productName" | "publisher">, host?: string): string {
  let title = stripPublisherSuffix(cleanText(v.title), v.publisher, host);
  title = title.replace(/\b(review)(\s+\1\b)+/gi, "$1");
  if (v.productName && !title.toLowerCase().includes(v.productName.toLowerCase())) {
    title = `${v.productName}: ${title}`;
  }
  return truncateWords(title, TITLE_MAX);
}

export function hostOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

export function dateBucket(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export function dedupeKey(parts: { productIdentity: string; brand?: string; publisherKey: string; date: Date }): string {
  const productKey = slugify(stripLeadingBrand(parts.productIdentity, parts.brand), 80) || "unknown-product";
  return `${productKey}|${slugify(parts.publisherKey, 60) || "unknown-source"}|${dateBucket(parts.date)}`;
}

export function normalizeContent(v: ValidatedContent, opts: { source: string; fetchedAt: Date }): NormalizedCandidate {
  const host = hostOf(v.canonicalUrl ?? v.url);
  const titleProduct = productFromTitle(v.title);
  const productIdentity = v.productName ?? titleProduct ?? cleanText(v.title).slice(0, 80);
  const title = canonicalTitle(v, host);
  const summary = v.summary ? truncateWords(cleanText(v.summary), 320) : firstSentences(v.body, 280);
  return {
    source: opts.source,
    sourceId: v.sourceId,
    sourceUrl: v.url,
    canonicalUrl: v.canonicalUrl ?? v.url,
    canonicalTitle: title,
    slugBase: slugify(title, 90) || "review",
    productIdentity,
    productIdentityFromTitle: !v.productName,
    summary,
    body: v.body,
    author: v.author,
    publisher: v.publisher,
    publishedAt: v.publishedAt,
    contentHash: contentHash(v),
    dedupeKey: dedupeKey({ productIdentity, brand: v.brand, publisherKey: host ?? v.publisher ?? opts.source, date: v.publishedAt ?? opts.fetchedAt }),
  };
}
