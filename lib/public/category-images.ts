import { unstable_cache } from "next/cache";
import { config } from "@/lib/config";
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

export type CategoryPhoto = { url: string; alt: string; photographer: string; photographerUrl: string; pexelsUrl: string };

async function fetchPhoto(slug: string): Promise<CategoryPhoto | null> {
  const key = config.images.pexelsKey();
  const query = QUERIES[slug];
  if (!key || !query) return null;
  const url = `https://api.pexels.com/v1/search?${new URLSearchParams({ query, per_page: "6", orientation: "portrait" })}`;
  const res = await safeFetch(url, { headers: { Authorization: key, Accept: "application/json" }, timeoutMs: 8000, maxRedirects: 2, readBody: true, maxBytes: 1_000_000 });
  if (!res.ok) {
    log.warn("category photo unavailable", { slug, status: res.status, error: res.error?.kind });
    return null;
  }
  try {
    const photos = (JSON.parse(res.body ?? "") as { photos?: Array<{ url: string; alt?: string; photographer: string; photographer_url: string; src: { portrait: string } }> }).photos ?? [];
    const p = photos.find((x) => typeof x?.src?.portrait === "string" && x.src.portrait.startsWith("https://images.pexels.com/"));
    return p ? { url: p.src.portrait, alt: p.alt ?? "", photographer: p.photographer, photographerUrl: p.photographer_url, pexelsUrl: p.url } : null;
  } catch {
    return null;
  }
}

export const categoryPhotos = unstable_cache(
  async (slugs: string[]) => {
    // Small batches, not one burst of 32 requests: Pexels limits are per hour and per key.
    const out: Record<string, CategoryPhoto | null> = {};
    for (let i = 0; i < slugs.length; i += 4) {
      const batch = slugs.slice(i, i + 4);
      const photos = await Promise.all(batch.map((s) => fetchPhoto(s).catch(() => null)));
      batch.forEach((s, j) => (out[s] = photos[j]));
    }
    return out;
  },
  ["category-photos-v2"],
  { revalidate: 86_400 },
);
