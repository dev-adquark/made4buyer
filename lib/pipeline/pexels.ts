import { config } from "@/lib/config";
import { safeFetch } from "@/lib/net/safe-fetch";
import { tokenize } from "@/lib/util/text";
import { KNOWN_BRANDS, stripLeadingBrand } from "./brands";

/**
 * Pexels image provider (https://www.pexels.com/api/). Photos are licensed under the
 * Pexels License (free commercial/editorial use); the API terms require crediting the
 * photographer and Pexels with a link, which we store as attribution + attributionUrl.
 *
 * Relevance rule: a photo is used only if its description names the product itself — at
 * least one distinctive product token (e.g. "macbook", "pixel", "wh-1000xm6") must appear,
 * and it must not name a different known brand. Generic "a laptop on a desk" photos are
 * rejected, so the page never implies a stock photo shows the reviewed product.
 */

export type PexelsPhoto = { id: number; url: string; alt: string; photographer: string; width: number; height: number; src: { large: string; large2x: string; landscape: string } };

const GENERIC = new Set(["the", "and", "with", "for", "new", "review", "gen", "generation", "inch", "wireless", "laptop", "notebook", "phone", "smartphone", "tablet", "headphones", "earbuds", "mouse", "keyboard", "charger", "monitor", "watch", "plus", "pro", "max", "mini", "ultra", "lite", "edition", "model", "series"]);
const BRANDS_LOWER = KNOWN_BRANDS.map((b) => b.toLowerCase());

export function distinctiveTokens(productName: string, brand?: string | null): string[] {
  return [...new Set(tokenize(stripLeadingBrand(productName, brand)).filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !GENERIC.has(t) && t !== brand?.toLowerCase()))];
}

/**
 * True when the photo names a different version of the product, e.g. the product is
 * "MX Master 4" but the description says "MX Master 3": a matched token is followed by a
 * number that differs from the product's own number at that position.
 */
export function conflictingVersion(alt: string, productName: string, brand: string | null | undefined, matched: string[]): boolean {
  const product = tokenize(stripLeadingBrand(productName, brand));
  const words = alt.trim().split(" ");
  for (const t of matched) {
    const pi = product.indexOf(t);
    const ai = words.indexOf(t);
    if (pi < 0 || ai < 0) continue;
    const next = words[ai + 1];
    const want = product[pi + 1];
    if (next && /^\d/.test(next) && next !== want) return true;
  }
  return false;
}

export function pickRelevantPhoto(photos: PexelsPhoto[], productName: string, brand?: string | null): { photo: PexelsPhoto; matched: string[] } | null {
  const tokens = distinctiveTokens(productName, brand);
  if (!tokens.length) return null;
  const ownBrand = brand?.toLowerCase();
  let best: { photo: PexelsPhoto; matched: string[] } | null = null;
  for (const photo of photos) {
    const alt = ` ${tokenize(photo.alt ?? "").join(" ")} `;
    const otherBrand = BRANDS_LOWER.some((b) => b !== ownBrand && b.length >= 3 && alt.includes(` ${b} `));
    if (otherBrand) continue;
    const matched = tokens.filter((t) => alt.includes(` ${t} `));
    if (conflictingVersion(alt, productName, brand, matched)) continue;
    // Multi-word products must match at least two distinctive tokens ("visual studio code"
    // must not match a generic "screen with code" photo).
    if (matched.length >= Math.min(2, tokens.length) && (!best || matched.length > best.matched.length)) best = { photo, matched };
  }
  return best;
}

export function pexelsConfigured(): boolean {
  return Boolean(config.images.pexelsKey());
}

export async function searchPexels(productName: string, brand?: string | null): Promise<{ image?: { url: string; width: number; height: number; attribution: string; attributionUrl: string; license: string }; reason?: string }> {
  const key = config.images.pexelsKey();
  if (!key) return { reason: "PEXELS_API_KEY not configured" };
  const query = `${brand && !productName.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ` : ""}${productName}`.slice(0, 80);
  const url = `https://api.pexels.com/v1/search?${new URLSearchParams({ query, per_page: "15", orientation: "landscape" })}`;
  const res = await safeFetch(url, { headers: { Authorization: key, Accept: "application/json" }, timeoutMs: config.images.timeoutMs(), maxRedirects: 2, readBody: true, maxBytes: 2_000_000 });
  if (!res.ok) return { reason: `Pexels ${res.error ? res.error.kind : `HTTP ${res.status}`}` };
  let photos: PexelsPhoto[];
  try {
    photos = (JSON.parse(res.body ?? "") as { photos?: PexelsPhoto[] }).photos ?? [];
  } catch {
    return { reason: "Pexels returned invalid JSON" };
  }
  const pick = pickRelevantPhoto(photos, productName, brand);
  if (!pick) return { reason: `no Pexels photo depicts "${query}" (${photos.length} results checked)` };
  const p = pick.photo;
  return {
    image: {
      url: p.src.large,
      width: 940,
      height: Math.round((940 * p.height) / p.width),
      attribution: `Photo by ${p.photographer} on Pexels`,
      attributionUrl: p.url,
      license: "Pexels License (https://www.pexels.com/license/)",
    },
  };
}
