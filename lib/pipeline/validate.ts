import { z } from "zod";
import { cleanText, htmlToPlainText } from "@/lib/util/text";

/**
 * Stage VALIDATION. Maps a raw Content API item (tolerating common field-name aliases,
 * see docs/CONTENT_API_CONTRACT.md) onto a canonical shape and validates it. A failing
 * item is isolated: it is persisted with CONTENT_SCHEMA_INVALID and never aborts the batch.
 */

export type ValidatedContent = {
  sourceId: string;
  title: string;
  body: string;
  summary?: string;
  url?: string;
  canonicalUrl?: string;
  publishedAt?: Date;
  productName?: string;
  brand?: string;
  category?: string;
  subcategory?: string;
  tags: string[];
  price?: number;
  currency?: string;
  modelNumber?: string;
  platform?: string;
  imageUrl?: string;
  imageLicense?: string;
  imageAttribution?: string;
  imageLicenseVerified: boolean;
  author?: string;
  publisher?: string;
  rating?: number;
  ratingScale?: number;
};

export type ValidationResult = { ok: true; value: ValidatedContent } | { ok: false; issues: string[]; sourceId?: string };

type Raw = Record<string, unknown>;

function pick(raw: Raw, keys: string[]): unknown {
  for (const key of keys) {
    const path = key.split(".");
    let v: unknown = raw;
    for (const p of path) v = v && typeof v === "object" ? (v as Raw)[p] : undefined;
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (v && typeof v === "object" && typeof (v as Raw).name === "string") return ((v as Raw).name as string).trim() || undefined;
  return undefined;
}

export function parsePrice(v: unknown): { price?: number; currency?: string } {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? { price: v } : {};
  if (v && typeof v === "object") {
    const o = v as Raw;
    const inner = parsePrice(o.amount ?? o.value ?? o.price);
    return { ...inner, currency: asString(o.currency) ?? inner.currency };
  }
  if (typeof v !== "string") return {};
  const currency = /€|eur/i.test(v) ? "EUR" : /£|gbp/i.test(v) ? "GBP" : /\$|usd/i.test(v) ? "USD" : undefined;
  const match = v.replace(/,(?=\d{3}\b)/g, "").match(/\d+(?:\.\d{1,2})?/);
  if (!match) return {};
  const price = Number(match[0]);
  return Number.isFinite(price) ? { price, currency } : {};
}

function asDate(v: unknown): Date | undefined {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v;
  if (typeof v === "number") {
    const d = new Date(v < 1e12 ? v * 1000 : v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  if (typeof v !== "string") return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function asTags(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(asString).filter((t): t is string => Boolean(t)).slice(0, 30);
  if (typeof v === "string") return v.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 30);
  return [];
}

const httpUrl = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an absolute http(s) URL");

const schema = z.object({
  sourceId: z.string().min(1, "id is required").max(200),
  title: z.string().min(8, "title must be at least 8 characters").max(300),
  body: z.string().min(120, "body must be at least 120 characters of text").max(200_000),
  summary: z.string().max(2000).optional(),
  url: httpUrl.optional(),
  canonicalUrl: httpUrl.optional(),
  publishedAt: z.date().optional(),
  productName: z.string().min(2).max(160).optional(),
  brand: z.string().min(1).max(80).optional(),
  category: z.string().max(120).optional(),
  subcategory: z.string().max(120).optional(),
  tags: z.array(z.string().max(80)),
  price: z.number().nonnegative().max(1_000_000).optional(),
  currency: z.string().length(3).optional(),
  modelNumber: z.string().max(80).optional(),
  platform: z.string().max(80).optional(),
  imageUrl: httpUrl.optional(),
  imageLicense: z.string().max(200).optional(),
  imageAttribution: z.string().max(300).optional(),
  imageLicenseVerified: z.boolean(),
  author: z.string().max(160).optional(),
  publisher: z.string().max(160).optional(),
  rating: z.number().min(0).max(100).optional(),
  ratingScale: z.number().positive().max(100).optional(),
});

export function validateContentItem(input: unknown): ValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, issues: ["item must be a JSON object"] };
  const raw = input as Raw;
  const sourceIdRaw = asString(pick(raw, ["id", "sourceId", "source_id", "guid", "uuid"]));
  const bodyRaw = asString(pick(raw, ["body", "content", "content.text", "text", "html", "articleBody"]));
  const priceParsed = parsePrice(pick(raw, ["price", "product.price", "msrp"]));
  const ratingRaw = pick(raw, ["rating", "score", "review.rating"]);

  const candidate = {
    sourceId: sourceIdRaw,
    title: asString(pick(raw, ["title", "headline", "name"])) ? cleanText(htmlToPlainText(asString(pick(raw, ["title", "headline", "name"]))!)) : undefined,
    body: bodyRaw ? htmlToPlainText(bodyRaw) : undefined,
    summary: asString(pick(raw, ["summary", "excerpt", "description", "dek", "subtitle"])),
    url: asString(pick(raw, ["url", "sourceUrl", "source_url", "link", "permalink"])),
    canonicalUrl: asString(pick(raw, ["canonicalUrl", "canonical_url", "canonical"])),
    publishedAt: asDate(pick(raw, ["publishedAt", "published_at", "datePublished", "pubDate", "date", "published"])),
    productName: asString(pick(raw, ["productName", "product_name", "product.name", "product"])),
    brand: asString(pick(raw, ["brand", "product.brand", "manufacturer"])),
    category: asString(pick(raw, ["category", "section", "product.category"])),
    subcategory: asString(pick(raw, ["subcategory", "sub_category"])),
    tags: asTags(pick(raw, ["tags", "keywords", "topics"])),
    price: priceParsed.price,
    currency: (asString(pick(raw, ["currency", "product.currency"])) ?? priceParsed.currency)?.toUpperCase(),
    modelNumber: asString(pick(raw, ["modelNumber", "model_number", "model", "product.model", "sku", "mpn"])),
    platform: asString(pick(raw, ["platform", "os", "operatingSystem"])),
    imageUrl: asString(pick(raw, ["imageUrl", "image_url", "image.url", "image", "thumbnail", "featuredImage"])),
    imageLicense: asString(pick(raw, ["imageLicense", "image_license", "image.license"])),
    imageAttribution: asString(pick(raw, ["imageAttribution", "image_attribution", "image.attribution", "image.credit"])),
    imageLicenseVerified: pick(raw, ["imageLicenseVerified", "image.licenseVerified"]) === true,
    author: asString(pick(raw, ["author", "author.name", "byline"])),
    publisher: asString(pick(raw, ["publisher", "publisher.name", "source", "site"])),
    rating: typeof ratingRaw === "number" ? ratingRaw : typeof ratingRaw === "string" && ratingRaw.trim() !== "" ? Number(ratingRaw) : undefined,
    ratingScale: (() => {
      const v = pick(raw, ["ratingScale", "rating_scale", "bestRating"]);
      return typeof v === "number" ? v : typeof v === "string" ? Number(v) : undefined;
    })(),
  };

  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      sourceId: sourceIdRaw,
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "item"}: ${i.message}`),
    };
  }
  return { ok: true, value: parsed.data };
}
