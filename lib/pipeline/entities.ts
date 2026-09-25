import { CATEGORIES, INTENTS, PLATFORMS } from "@/lib/taxonomy/definitions";
import { canonicalBrand, familyBrand, findBrand } from "./brands";
import { parsePrice, type ValidatedContent } from "./validate";
import type { NormalizedCandidate } from "./normalize";

/**
 * Stage ENTITY_EXTRACTION. Deterministic rules over Content API fields first, then text.
 * Each entity carries its own confidence so QA can see exactly what is uncertain.
 */

export type EntityField = "productName" | "brand" | "deviceType" | "useCase" | "platform" | "price" | "modelNumber" | "source" | "publishDate";

export type ExtractedEntitySet = {
  productName: string;
  brand?: string;
  deviceType?: string;
  useCase?: string;
  platform?: string;
  price?: number;
  currency?: string;
  modelNumber?: string;
  source: string;
  publishDate?: Date;
  rating?: number;
  ratingScale?: number;
  confidences: Record<EntityField, number>;
  lowConfidenceFields: EntityField[];
  overallConfidence: number;
};

const CORE_WEIGHTS: Partial<Record<EntityField, number>> = { productName: 0.45, brand: 0.3, deviceType: 0.25 };

const DEVICE_TYPES: Array<[RegExp, string]> = CATEGORIES.flatMap((c) => {
  const words = c.signals.filter(([, w]) => w >= 3).map(([p]) => p);
  return words.length ? [[new RegExp(`(?<![a-z0-9])(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})(?![a-z0-9])`, "i"), c.deviceType] as [RegExp, string]] : [];
});

const MODEL_PATTERNS = [
  /\b([A-Z]{1,4}-?\d{3,5}[A-Z0-9]{0,4}(?:-[A-Z0-9]{1,4})?)\b/, // WH-1000XM5, SM-S928, G502
  /\b(\d{2}[A-Z]{1,3}\d{3,4}[A-Z]{0,2})\b/, // 14Q8235, 32UN880
];
const MODEL_STOPWORDS = /^(USB|HDMI|DDR\d|LPDDR\d|RTX|GTX|WIFI|WI-FI|\d{4}|4K|8K|5G|4G|LTE)$/i;

function round(n: number) {
  return Math.round(n * 100) / 100;
}

function firstMatch(patterns: Array<{ slug: string; name: string; signals: Array<[string, number]> }>, text: string): { name: string; strength: number } | undefined {
  const lower = text.toLowerCase();
  let best: { name: string; strength: number } | undefined;
  for (const p of patterns) {
    let strength = 0;
    for (const [pattern, weight] of p.signals) {
      if (pattern.trim() && lower.includes(pattern.toLowerCase())) strength += weight;
    }
    if (strength > 0 && (!best || strength > best.strength)) best = { name: p.name, strength };
  }
  return best;
}

export function extractModelNumber(text: string): string | undefined {
  for (const re of MODEL_PATTERNS) {
    const m = text.match(re);
    if (m && !MODEL_STOPWORDS.test(m[1])) return m[1];
  }
  return undefined;
}

export function extractEntities(v: ValidatedContent, n: NormalizedCandidate): ExtractedEntitySet {
  const confidences = {} as Record<EntityField, number>;
  const headline = `${n.productIdentity} ${v.title}`;
  const text = `${v.title}\n${v.summary ?? ""}\n${v.body}`;

  // productName
  const productName = n.productIdentity;
  confidences.productName = v.productName ? 0.95 : n.productIdentityFromTitle && productName !== v.title.slice(0, 80) ? 0.7 : 0.35;

  // brand
  let brand: string | undefined;
  if (v.brand) {
    brand = canonicalBrand(v.brand) ?? v.brand;
    confidences.brand = canonicalBrand(v.brand) || headline.toLowerCase().includes(v.brand.toLowerCase()) ? 0.95 : 0.85;
  } else if ((brand = findBrand(productName))) {
    confidences.brand = 0.9;
  } else if ((brand = familyBrand(productName))) {
    confidences.brand = 0.8;
  } else if ((brand = findBrand(v.title))) {
    confidences.brand = 0.75;
  } else if ((brand = familyBrand(v.title))) {
    confidences.brand = 0.65;
  } else {
    confidences.brand = 0;
  }

  // deviceType
  let deviceType: string | undefined;
  const headlineHit = DEVICE_TYPES.find(([re]) => re.test(headline));
  if (headlineHit) {
    deviceType = headlineHit[1];
    confidences.deviceType = 0.9;
  } else {
    const counts = DEVICE_TYPES.map(([re, type]) => ({ type, count: (text.match(new RegExp(re.source, "gi")) ?? []).length })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
    if (counts[0]?.count >= 2) {
      deviceType = counts[0].type;
      confidences.deviceType = counts[1]?.count && counts[1].count >= counts[0].count * 0.7 ? 0.45 : 0.65;
    } else confidences.deviceType = 0;
  }

  // useCase (intent-derived)
  const intent = firstMatch(INTENTS.filter((i) => ["gaming", "creator", "business", "developer", "productivity"].includes(i.slug)), text);
  const useCase = intent && intent.strength >= 4 ? intent.name : undefined;
  confidences.useCase = useCase ? round(Math.min(0.85, 0.4 + intent!.strength / 20)) : 0;

  // platform
  let platform: string | undefined;
  if (v.platform) {
    platform = v.platform;
    confidences.platform = 0.95;
  } else {
    const p = firstMatch(PLATFORMS, headline) ?? firstMatch(PLATFORMS, text);
    platform = p && p.strength >= 3 ? p.name : undefined;
    confidences.platform = platform ? (firstMatch(PLATFORMS, headline) ? 0.8 : 0.55) : 0;
  }

  // price
  let price = v.price;
  let currency = v.currency;
  if (price !== undefined) confidences.price = 0.95;
  else {
    const m = text.match(/(?:\$|USD\s?|€|EUR\s?|£|GBP\s?)\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/);
    if (m) {
      const parsed = parsePrice(m[0]);
      price = parsed.price;
      currency = parsed.currency;
      confidences.price = price !== undefined ? 0.55 : 0;
    } else confidences.price = 0;
  }

  // modelNumber
  let modelNumber = v.modelNumber;
  if (modelNumber) confidences.modelNumber = 0.95;
  else {
    modelNumber = extractModelNumber(`${productName} ${v.title}`);
    confidences.modelNumber = modelNumber ? 0.5 : 0;
  }

  confidences.source = 1;
  confidences.publishDate = v.publishedAt ? 0.95 : 0;

  let weighted = 0;
  let weightTotal = 0;
  for (const [field, weight] of Object.entries(CORE_WEIGHTS) as Array<[EntityField, number]>) {
    weighted += confidences[field] * weight;
    weightTotal += weight;
  }
  const overallConfidence = round(weighted / weightTotal);

  return {
    productName,
    brand,
    deviceType,
    useCase,
    platform,
    price,
    currency: price !== undefined ? currency ?? "USD" : undefined,
    modelNumber,
    source: v.publisher ?? n.source,
    publishDate: v.publishedAt,
    rating: v.rating,
    ratingScale: v.rating !== undefined ? v.ratingScale ?? (v.rating <= 5 ? 5 : v.rating <= 10 ? 10 : 100) : undefined,
    confidences,
    lowConfidenceFields: [] as EntityField[],
    overallConfidence,
  };
}

export function lowConfidenceFields(e: Pick<ExtractedEntitySet, "confidences">, threshold: number): EntityField[] {
  return (["productName", "brand", "deviceType"] as EntityField[]).filter((f) => (e.confidences[f] ?? 0) < threshold);
}
