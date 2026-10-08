import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { BRAND_LIMITS, checkRegistryUrl } from "@/lib/commerce/brands";
import { discoverProductUrls } from "@/lib/commerce/discovery";
import { stripLeadingBrand } from "@/lib/pipeline/brands";
import { slugify } from "@/lib/util/text";
import { exactImagesFromProducts } from "./review-exact-image";

/**
 * Finding the brand's official product page for a reviewed product, so the commerce engine can read
 * its exact product photo (lib/images/review-exact-image.ts):
 *
 *   For each published single-product review whose PRIMARY product has no identity-matched commerce
 *   product with an exact photo yet, the brand registry's own sitemaps (robots-respecting discovery,
 *   lib/commerce/discovery.ts, with the brand's productUrlPatterns) are searched for a product URL
 *   whose slug names exactly that product (`urlNamesProduct`). A match is added to the brand's
 *   productUrls, so the next commerce run extracts the page; the page then still has to pass the
 *   commerce pipeline's identity match (sameProduct) before its photo is ever shown.
 *
 * Bounded: at most `maxBrands` brands per run, each searched at most once a week (AutomationSetting).
 */

const VARIANT_WORDS = new Set(["pro", "max", "ultra", "plus", "mini", "lite", "fold", "flip", "xl", "xs", "se", "fe", "edge", "slim", "air", "neo", "prime", "go", "s", "a", "e", "r", "x", "kids", "jr", "junior", "lt", "sport", "classic"]);
const ACCESSORY_WORDS = new Set(["case", "cases", "cover", "covers", "charger", "cable", "protector", "screen", "strap", "straps", "band", "bands", "mount", "stand", "dock", "bundle", "kit", "refurbished", "renewed", "certified", "replacement", "parts", "part", "filter", "filters", "sleeve", "skin", "skins", "insert", "pouch", "adapter", "battery", "accessory", "accessories", "gift", "card", "warranty", "protection", "plan"]);
const STOP = new Set(["the", "and", "with", "for", "by", "of", "new"]);
/** Path words that say nothing about which product a page is ("products", "us", "en", "shop", …). */
const PATH_WORDS = new Set(["products", "product", "p", "dp", "pd", "item", "items", "shop", "store", "buy", "us", "en", "en-us", "html", "htm", "www", "collections", "all"]);

function words(s: string): string[] {
  let text = s;
  try {
    text = decodeURIComponent(s);
  } catch {
    /* keep raw */
  }
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * True when one path segment of `url` names exactly this product: all of the product's words (brand
 * stripped) appear in it in order (spacing ignored: "fold8" = "Fold 8", "6l" = "6L"), and the
 * segment adds no other model word (no "pro" for a "Pixel 11"), no other number, and no accessory
 * word ("case", "strap", "bundle"). Conservative on purpose: a missed page costs nothing, a wrong one
 * would be stopped by the identity check later anyway.
 */
export function urlNamesProduct(url: string, productName: string, brand?: string | null): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const brandWords = new Set(words(brand ?? ""));
  // Letters and digits split apart, so "fold8" = "Fold 8" and "6l" = "6L".
  const parts = (ws: string[]) => ws.flatMap((w) => w.match(/[a-z]+|\d+/g) ?? []);
  const product = parts(words(stripLeadingBrand(productName, brand)).filter((w) => !STOP.has(w) && !brandWords.has(w)));
  // A product name that is only a number or one short word is too vague to find by slug.
  if (!product.length || product.join("").length < 4 || !product.some((w) => /[a-z]{2,}/.test(w))) return false;
  for (const seg of u.pathname.split("/").filter(Boolean)) {
    const segParts = parts(words(seg.replace(/\.(html?|aspx?|php)$/i, "")).filter((w) => !PATH_WORDS.has(w) && !brandWords.has(w) && !STOP.has(w)));
    for (let i = 0; i + product.length <= segParts.length; i++) {
      if (!product.every((w, j) => segParts[i + j] === w)) continue;
      // What the segment adds beyond the product's own words.
      const added = [...segParts.slice(0, i), ...segParts.slice(i + product.length)];
      if (added.some((w) => VARIANT_WORDS.has(w) || ACCESSORY_WORDS.has(w) || /^\d+$/.test(w))) continue;
      // Anything else (a colour, a size word) at most twice.
      if (added.length <= 2) return true;
    }
  }
  return false;
}

export type OfficialUrlSearchResult = { brands: number; searched: number; added: number; skipped: number; items: Array<{ brand: string; product: string; url?: string; outcome: string }> };

const SEARCH_EVERY_MS = 7 * 86_400_000;
const keyFor = (brandSlug: string) => `image-official-url-search:${brandSlug}`;

type Want = { entityId: string; name: string; brand: string | null };

/** Published single-product reviews whose product has no exact commerce photo yet, grouped by commerce brand. */
async function productsWanting(): Promise<Map<string, { brand: { id: string; slug: string; name: string; officialDomain: string; discoveryUrls: string[]; productUrlPatterns: string[]; productUrls: string[]; maxProductsPerRun: number; lastCrawlAt: Date | null; market: string }; wants: Want[] }>> {
  const links = await db.contentEntity.findMany({
    where: { role: "PRIMARY", review: { status: "PUBLISHED" } },
    select: { productEntityId: true, entity: { select: { name: true, brand: true, brandSlug: true } } },
    take: 2000,
  });
  const entityIds = [...new Set(links.map((l) => l.productEntityId))];
  const matched = await db.commerceProduct.findMany({
    where: { identityStatus: "MATCHED", productEntityId: { in: entityIds } },
    select: { productEntityId: true, canonicalUrl: true, data: true, name: true, identityStatus: true, brand: { select: { officialDomain: true, name: true } } },
  });
  const covered = new Set(matched.filter((m) => exactImagesFromProducts([m]).length).map((m) => m.productEntityId!));
  const brands = await db.commerceBrand.findMany({
    where: { enabled: true },
    select: { id: true, slug: true, name: true, officialDomain: true, discoveryUrls: true, productUrlPatterns: true, productUrls: true, maxProductsPerRun: true, lastCrawlAt: true, market: true },
  });
  const bySlug = new Map(brands.map((b) => [b.slug, b]));
  const byName = new Map(brands.map((b) => [slugify(b.name, 60), b]));
  const out = new Map<string, { brand: (typeof brands)[number]; wants: Want[] }>();
  const seen = new Set<string>();
  for (const l of links) {
    if (covered.has(l.productEntityId) || seen.has(l.productEntityId)) continue;
    seen.add(l.productEntityId);
    const slug = l.entity.brandSlug ?? (l.entity.brand ? slugify(l.entity.brand, 60) : null);
    const b = slug ? (bySlug.get(slug) ?? byName.get(slug)) : undefined;
    if (!b) continue;
    // Already queued: the next commerce run reads it.
    if (b.productUrls.some((u) => urlNamesProduct(u, l.entity.name, l.entity.brand ?? b.name))) continue;
    const entry = out.get(b.id) ?? { brand: b, wants: [] };
    entry.wants.push({ entityId: l.productEntityId, name: l.entity.name, brand: l.entity.brand ?? b.name });
    out.set(b.id, entry);
  }
  return out;
}

export async function runOfficialProductUrlSearch(trigger: string, opts: { maxBrands?: number; now?: Date } = {}): Promise<OfficialUrlSearchResult> {
  const now = opts.now ?? new Date();
  const out: OfficialUrlSearchResult = { brands: 0, searched: 0, added: 0, skipped: 0, items: [] };
  const groups = await productsWanting();
  out.brands = groups.size;
  for (const { brand, wants } of groups.values()) {
    if (out.searched >= (opts.maxBrands ?? 2)) break;
    const key = keyFor(brand.slug);
    const last = await db.automationSetting.findUnique({ where: { key } }).catch(() => null);
    if (last && now.getTime() - Date.parse(last.value) < SEARCH_EVERY_MS) {
      out.skipped++;
      continue;
    }
    out.searched++;
    await db.automationSetting.upsert({ where: { key }, create: { key, value: now.toISOString(), updatedBy: `job:${trigger}`.slice(0, 200) }, update: { value: now.toISOString(), updatedBy: `job:${trigger}`.slice(0, 200) } });
    const found = await discoverProductUrls(brand, { now, persist: false, maxSitemaps: 6, timeoutMs: 8000, filter: (url) => wants.some((w) => urlNamesProduct(url, w.name, w.brand)) });
    const add: string[] = [];
    for (const w of wants) {
      // The shortest matching URL is the product itself (longer ones tend to be variants or bundles).
      const url = found.urls.filter((u) => urlNamesProduct(u, w.name, w.brand)).sort((a, b) => a.length - b.length)[0];
      if (!url || checkRegistryUrl("Product URLs", url, brand.officialDomain)) {
        out.items.push({ brand: brand.slug, product: w.name, outcome: url ? "rejected by the registry URL rules" : `not found (${found.status})` });
        continue;
      }
      add.push(url);
      out.items.push({ brand: brand.slug, product: w.name, url, outcome: "queued for the next commerce run" });
    }
    if (!add.length) continue;
    const fresh = await db.commerceBrand.findUnique({ where: { id: brand.id }, select: { productUrls: true } });
    const merged = [...new Set([...(fresh?.productUrls ?? []), ...add])];
    // The registry's own cap: the oldest explicit URLs stay, new ones are added while there is room.
    const capped = merged.slice(0, BRAND_LIMITS.urlListItems);
    const added = capped.length - (fresh?.productUrls.length ?? 0);
    if (added > 0) {
      await db.commerceBrand.update({ where: { id: brand.id }, data: { productUrls: capped } });
      out.added += added;
      log.info("official product pages queued for exact images", { stage: "IMAGE_ENRICHMENT", trigger, brand: brand.slug, added });
    }
  }
  return out;
}
