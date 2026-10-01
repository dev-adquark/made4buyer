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
    const p = photos[0];
    return p ? { url: p.src.portrait, alt: p.alt ?? "", photographer: p.photographer, photographerUrl: p.photographer_url, pexelsUrl: p.url } : null;
  } catch {
    return null;
  }
}

export const categoryPhotos = unstable_cache(
  async (slugs: string[]) => Object.fromEntries(await Promise.all(slugs.map(async (s) => [s, await fetchPhoto(s).catch(() => null)] as const))) as Record<string, CategoryPhoto | null>,
  ["category-photos-v1"],
  { revalidate: 86_400 },
);
