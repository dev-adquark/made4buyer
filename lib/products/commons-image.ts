import { config } from "@/lib/config";
import { db } from "@/lib/db";

/**
 * Licensed exact-product photos from Wikimedia Commons.
 *
 * The Wikidata lookup stores a product's P18 image as a ProductFact with field "image":
 *   value = the Commons file URL (https://upload.wikimedia.org/...), unit = licence short name
 *   (e.g. "CC BY-SA 4.0"), sourceName = author / attribution, sourceUrl = the Commons file page,
 *   source = "WIKIDATA", matchBasis = how the Wikidata item was matched to our product.
 *
 * A fact becomes a hero image only when every one of these holds:
 *  - the Wikidata item was matched by an identifier (GTIN, MPN, model, QID...) or by exact
 *    brand + name; anything looser could be a sibling product, and a wrong image is worse
 *    than no image;
 *  - it carries a free licence (CC0 / CC BY / CC BY-SA / public domain / GFDL / Free Art);
 *  - the file is served from upload.wikimedia.org (Commons), over https, and is not an SVG
 *    (Commons SVGs are logos and diagrams, never product photographs).
 * Facts that fail are rejected with a reason; nothing is downloaded or stored, we link the file.
 */

export type CommonsImage = {
  url: string;
  license: string;
  /** Credit line shown under the image, e.g. "Jane Doe / Wikimedia Commons, CC BY-SA 4.0". */
  attribution: string;
  /** The Commons file page: credits the author and states the licence in full. */
  filePageUrl: string;
  matchBasis: string;
  /** How sure we are the photo shows this content's product (0..1). */
  matchConfidence: number;
  productEntityId: string;
  productName: string;
  observedAt: Date;
};

export type ImageFactRow = {
  field: string;
  value: unknown;
  unit: string | null;
  source: string;
  sourceName: string;
  sourceUrl: string | null;
  observedAt: Date;
  matchBasis: string;
};

/** Identity bases that pin the Wikidata item to exactly this product. */
const IDENTIFIER_BASES = new Set(["gtin", "ean", "upc", "isbn", "mpn", "model", "sku", "qid", "wikidata", "wikidata-id", "wikidata-qid", "identifier"]);
/** Exact brand + product name (not fuzzy, not name-only). */
const EXACT_NAME_BASES = new Set(["brand+name", "exact-brand+name", "brand+name-exact"]);

const FREE_LICENCE = /\b(cc0|cc[\s-]?by(?:[\s-]?sa)?|creative commons attribution|public domain|pd|gfdl|free art)\b/i;
const NON_FREE = /\b(nc|nd|non-?commercial|no-?deriv\w*|fair[\s-]?use|non-?free|all rights reserved)\b/i;

/** The confidence an identity basis earns, or null when the basis is not trusted for images. */
export function matchBasisConfidence(basis: string | null | undefined): number | null {
  // "wikidata:gtin" / "wikidata:brand+name" (lib/products/wikidata.ts): the part after the prefix is the basis.
  const parts = (basis ?? "").trim().toLowerCase().split(":").map((x) => x.trim());
  const b = parts[0] === "wikidata" && parts[1] ? parts[1] : parts[0];
  if (IDENTIFIER_BASES.has(b)) return 1;
  if (EXACT_NAME_BASES.has(b)) return 0.9;
  return null;
}

export function isFreeLicence(licence: string | null | undefined): boolean {
  const l = (licence ?? "").trim();
  return Boolean(l) && FREE_LICENCE.test(l) && !NON_FREE.test(l);
}

/** True for an https file on upload.wikimedia.org under /wikipedia/commons/ (loopback only in tests). */
export function isCommonsFileUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (/\.svg$/i.test(u.pathname)) return false;
  if (u.protocol === "https:" && u.hostname === "upload.wikimedia.org" && u.pathname.startsWith("/wikipedia/commons/")) return true;
  return config.allowLoopbackForTests() && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
}

/** The Commons file page for a file URL ("…/thumb/a/ab/Name.jpg/1200px-Name.jpg" → File:Name.jpg). */
export function commonsFilePage(fileUrl: string): string | null {
  try {
    const parts = new URL(fileUrl).pathname.split("/").filter(Boolean);
    const thumb = parts.indexOf("thumb");
    const name = thumb >= 0 ? parts[parts.length - 2] : parts[parts.length - 1];
    return name ? `https://commons.wikimedia.org/wiki/File:${name}` : null;
  } catch {
    return null;
  }
}

function isCommonsFilePage(raw: string | null | undefined): raw is string {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname === "commons.wikimedia.org" && /^\/wiki\/File:./.test(u.pathname);
  } catch {
    return false;
  }
}

function plain(text: string): string {
  return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

export type ImageFactCheck = { ok: true; image: Omit<CommonsImage, "productEntityId" | "productName"> } | { ok: false; reason: string };

/** Validates one "image" fact; never trusts a fact without a free licence or off Commons. */
export function checkImageFact(fact: ImageFactRow): ImageFactCheck {
  if (fact.field !== "image") return { ok: false, reason: `not an image fact (${fact.field})` };
  if (fact.source !== "WIKIDATA") return { ok: false, reason: `image facts are accepted only from Wikidata/Commons, not ${fact.source}` };
  const confidence = matchBasisConfidence(fact.matchBasis);
  if (confidence === null) return { ok: false, reason: `match basis "${fact.matchBasis}" is not an identifier or exact brand+name match` };
  if (typeof fact.value !== "string" || !fact.value.trim()) return { ok: false, reason: "image fact has no file URL" };
  const url = fact.value.trim();
  if (!isCommonsFileUrl(url)) return { ok: false, reason: "image is not a Wikimedia Commons file (upload.wikimedia.org, https, non-SVG)" };
  if (!isFreeLicence(fact.unit)) return { ok: false, reason: fact.unit ? `licence "${fact.unit}" is not a free licence` : "image fact has no licence" };
  const filePageUrl = isCommonsFilePage(fact.sourceUrl) ? fact.sourceUrl : commonsFilePage(url);
  if (!filePageUrl) return { ok: false, reason: "no Commons file page to credit" };
  const license = fact.unit!.trim();
  const author = plain(fact.sourceName ?? "");
  const credit = author && !/^(wikidata|wikimedia commons|commons)$/i.test(author) ? `${author} / Wikimedia Commons` : "Wikimedia Commons";
  return { ok: true, image: { url, license, attribution: `${credit}, ${license}`, filePageUrl, matchBasis: fact.matchBasis, matchConfidence: confidence, observedAt: fact.observedAt } };
}

/** Entity links below this confidence are not trusted to pick a product photo (editor links always are). */
export const MIN_ENTITY_CONFIDENCE = 0.6;

export type PrimaryProduct = { productEntityId: string; name: string; brand: string | null; confidence: number; source: string };

/** The product a content item is about (its PRIMARY entity link), if any. */
export async function primaryProductOf(normalizedReviewId: string): Promise<PrimaryProduct | null> {
  const link = await db.contentEntity.findFirst({
    where: { normalizedReviewId, role: "PRIMARY" },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    include: { entity: { select: { name: true, brand: true } } },
  });
  return link ? { productEntityId: link.productEntityId, name: link.entity.name, brand: link.entity.brand, confidence: link.confidence, source: link.source } : null;
}

/**
 * Valid Commons photos of the product, best first (identifier match, then newest), plus the
 * reasons other image facts were rejected.
 */
export async function commonsImagesFor(product: PrimaryProduct): Promise<{ images: CommonsImage[]; rejected: string[] }> {
  if (product.source !== "ADMIN" && product.confidence < MIN_ENTITY_CONFIDENCE) {
    return { images: [], rejected: [`product link confidence ${product.confidence} is below ${MIN_ENTITY_CONFIDENCE}`] };
  }
  const facts = await db.productFact.findMany({ where: { productEntityId: product.productEntityId, field: "image" }, orderBy: { observedAt: "desc" } });
  const images: CommonsImage[] = [];
  const rejected: string[] = [];
  for (const f of facts) {
    const r = checkImageFact(f);
    if (r.ok) images.push({ ...r.image, productEntityId: product.productEntityId, productName: product.name });
    else rejected.push(r.reason);
  }
  images.sort((a, b) => b.matchConfidence - a.matchConfidence || b.observedAt.getTime() - a.observedAt.getTime());
  return { images, rejected };
}
