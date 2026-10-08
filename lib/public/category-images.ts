import { unstable_cache } from "next/cache";
import { cache } from "react";
import { CATEGORIES } from "@/lib/taxonomy/definitions";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { safeFetch } from "@/lib/net/safe-fetch";

/**
 * Editorial photography for category panels, from Pexels (same API key and licence as the
 * product-image pipeline). Queries describe the category's real context, not a product, so
 * these images are never presented as a specific reviewed product. Cached for a day; with
 * no key (or on any error) the panel shows its typographic fallback instead.
 */

const QUERIES: Record<string, string> = {
  laptops: "laptop on desk minimal",
  phones: "smartphone in hand",
  tablets: "tablet device reading",
  "ai-tools": "abstract technology workspace",
  "developer-software": "developer coding laptop",
  accessories: "keyboard mouse desk setup",
  audio: "headphones close up",
  wearables: "smartwatch on wrist",
  networking: "wifi router home",
  desktops: "desktop computer workspace",
  "pc-components": "graphics card computer hardware",
  monitors: "computer monitor desk setup",
  printers: "office printer",
  "smart-home": "smart home device",
  cameras: "mirrorless camera photography",
  gaming: "game controller console",
  "tv-home-entertainment": "living room television",
  "streaming-devices": "tv remote streaming",
  "productivity-software": "laptop office productivity",
  "security-software": "cybersecurity padlock laptop",
  "business-software": "team meeting laptop office",
  "website-ecommerce": "website design laptop",
  "creative-software": "graphic designer workspace",
  "drones-gadgets": "drone flying",
  "automotive-tech": "car dashboard technology",
  mattresses: "bedroom bed mattress",
  furniture: "ergonomic office chair desk",
  "kitchen-appliances": "kitchen countertop appliances",
  "home-appliances": "modern home interior appliance",
  "fitness-equipment": "home gym equipment",
  "personal-care": "bathroom grooming products",
  "outdoor-garden": "garden backyard grill",
  "tools-diy": "power tools workshop",
  "baby-kids": "baby stroller park",
  "pet-supplies": "dog at home",
  "luggage-travel": "suitcase travel airport",
};

/** Cache tag of the category photos (purged by the image-integrity job when one no longer loads). */
export const CATEGORY_PHOTOS_TAG = "category-photos";

/** `url` is the portrait rendition (category panels); `landscape` the 1200×627 crop for cards and heroes. */
export type CategoryPhoto = { url: string; landscape?: string; alt: string; photographer: string; photographerUrl: string; pexelsUrl: string };

async function fetchPhoto(slug: string): Promise<CategoryPhoto | null> {
  const key = config.images.pexelsKey();
  const query = QUERIES[slug];
  if (!key || !query) return null;
  const url = `${config.images.pexelsBaseUrl()}/search?${new URLSearchParams({ query, per_page: "6", orientation: "portrait" })}`;
  const res = await safeFetch(url, { headers: { Authorization: key, Accept: "application/json" }, timeoutMs: 8000, maxRedirects: 2, readBody: true, maxBytes: 1_000_000 });
  if (!res.ok) {
    log.warn("category photo unavailable", { slug, status: res.status, error: res.error?.kind });
    return null;
  }
  try {
    const photos = (JSON.parse(res.body ?? "") as { photos?: Array<{ url: string; alt?: string; photographer: string; photographer_url: string; src: { portrait: string; landscape?: string } }> }).photos ?? [];
    const p = photos.find((x) => typeof x?.src?.portrait === "string" && x.src.portrait.startsWith("https://images.pexels.com/"));
    if (!p) return null;
    const landscape = typeof p.src.landscape === "string" && p.src.landscape.startsWith("https://images.pexels.com/") ? p.src.landscape : undefined;
    return { url: p.src.portrait, ...(landscape ? { landscape } : {}), alt: p.alt ?? "", photographer: p.photographer, photographerUrl: p.photographer_url, pexelsUrl: p.url };
  } catch {
    return null;
  }
}

/**
 * Last-known-good category photos (automation_settings), so a Pexels rate limit (429) or outage never
 * blanks a slot: Pexels is asked only for a category with no stored photo or one older than a week.
 */
const LAST_GOOD_KEY = "category-photos:last-good";
const REFRESH_AFTER_MS = 7 * 86_400_000;
type StoredPhoto = CategoryPhoto & { at: string };

async function readLastGood(): Promise<Record<string, StoredPhoto>> {
  const row = await db.automationSetting.findUnique({ where: { key: LAST_GOOD_KEY } }).catch(() => null);
  if (!row) return {};
  try {
    const v = JSON.parse(row.value) as Record<string, StoredPhoto>;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

async function writeLastGood(value: Record<string, StoredPhoto>): Promise<void> {
  const json = JSON.stringify(value);
  await db.automationSetting
    .upsert({ where: { key: LAST_GOOD_KEY }, create: { key: LAST_GOOD_KEY, value: json, updatedBy: "category-photos" }, update: { value: json, updatedBy: "category-photos" } })
    .catch((error: unknown) => log.warn("category photos not saved", { error: String(error).slice(0, 200) }));
}

/** Drops a stored category photo that no longer loads (image-integrity), so the next read fetches a new one. */
export async function forgetCategoryPhoto(slug: string): Promise<void> {
  const stored = await readLastGood();
  if (!stored[slug]) return;
  delete stored[slug];
  await writeLastGood(stored);
}

/** Every requested category's photo: the stored copy, refreshed from Pexels when missing or a week old. */
export async function loadCategoryPhotos(slugs: string[], now = Date.now()): Promise<Record<string, CategoryPhoto | null>> {
  const stored = await readLastGood();
  const due = slugs.filter((s) => QUERIES[s] && now - (Date.parse(stored[s]?.at ?? "") || 0) > REFRESH_AFTER_MS);
  let fetched = 0;
  // Small batches, not one burst of 32 requests: Pexels limits are per hour and per key.
  for (let i = 0; i < due.length; i += 4) {
    const batch = due.slice(i, i + 4);
    const photos = await Promise.all(batch.map((s) => fetchPhoto(s).catch(() => null)));
    batch.forEach((s, j) => {
      const p = photos[j];
      if (p) {
        stored[s] = { ...p, at: new Date(now).toISOString() };
        fetched++;
      }
    });
  }
  if (fetched) await writeLastGood(stored);
  const out: Record<string, CategoryPhoto | null> = {};
  for (const s of slugs) {
    out[s] = stored[s] ? toPhoto(stored[s]) : null;
  }
  return out;
}

/** The stored photos only (no Pexels request): what a slot shows while Pexels is unavailable. */
async function storedCategoryPhotos(slugs: string[]): Promise<Record<string, CategoryPhoto | null>> {
  const stored = await readLastGood();
  return Object.fromEntries(slugs.map((s) => [s, stored[s] ? toPhoto(stored[s]) : null]));
}

function toPhoto(p: StoredPhoto): CategoryPhoto {
  return { url: p.url, ...(p.landscape ? { landscape: p.landscape } : {}), alt: p.alt, photographer: p.photographer, photographerUrl: p.photographerUrl, pexelsUrl: p.pexelsUrl };
}

export const categoryPhotos = unstable_cache(
  async (slugs: string[]) => {
    const out = await loadCategoryPhotos(slugs);
    // An incomplete answer (Pexels limited, nothing stored yet) is not cached for a day: the next
    // request asks Pexels again, for the missing categories only.
    if (slugs.some((s) => QUERIES[s] && !out[s])) throw new Error("category photos incomplete");
    return out;
  },
  ["category-photos-v4"],
  { revalidate: 86_400, tags: [CATEGORY_PHOTOS_TAG] },
);

/**
 * The cached category photos for the image-integrity job (no extra Pexels requests). Outside a
 * Next.js request context (tests, scripts) the cache is unavailable: no photos are returned.
 */
export async function cachedCategoryPhotosForCheck(slugs: string[]): Promise<Record<string, CategoryPhoto | null>> {
  try {
    return await categoryPhotos(slugs);
  } catch {
    return storedCategoryPhotos(slugs).catch(() => ({}));
  }
}

const ALL_SLUGS = CATEGORIES.map((c) => c.slug);

/**
 * Every category's photo, once per request (one data-cache entry for all categories, shared with the
 * home page's category panels). Empty outside a Next.js request context or when Pexels is unavailable.
 */
export const allCategoryPhotos = cache(async (): Promise<Record<string, CategoryPhoto | null>> => {
  try {
    return await categoryPhotos(ALL_SLUGS);
  } catch {
    return storedCategoryPhotos(ALL_SLUGS).catch(() => ({}));
  }
});

/** A category photo's landscape rendition (cards, heroes), else its portrait one. */
export function categoryPhotoSrc(p: CategoryPhoto): string {
  return p.landscape ?? p.url;
}

/**
 * The last resort of every public image slot before our placeholder graphic: the category's licensed
 * Pexels photo, labelled "Representative photo" with its credit. Null when there is none.
 */
export async function categoryFallbackPhoto(categorySlug: string | null | undefined): Promise<CategoryPhoto | null> {
  if (!categorySlug) return null;
  return (await allCategoryPhotos())[categorySlug] ?? null;
}
