import { unstable_cache } from "next/cache";
import { cache } from "react";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { brandKeyOf, BRAND_LOGOS_TAG } from "./brand-logos";

/**
 * Public read side of official brand logos (lib/commerce/brand-logos.ts). A logo is shown ONLY when
 * the brand's logoStatus is VERIFIED and the stored file has a URL and dimensions; anything else
 * returns null and the card keeps its text/monogram. Never another brand's image.
 */

export type BrandLogo = { src: string; width: number; height: number; mime: string; source: string; license: string | null };
export type BrandLogoRow = { logoStatus: string | null; logoUrl: string | null; logoWidth: number | null; logoHeight: number | null; logoMime: string | null; logoSource: string | null; logoLicense: string | null };

/** Pure: the displayable logo of a brand row, or null. */
export function publicLogo(b: BrandLogoRow | null | undefined): BrandLogo | null {
  if (!b || b.logoStatus !== "VERIFIED" || !b.logoUrl || !b.logoWidth || !b.logoHeight || b.logoWidth <= 0 || b.logoHeight <= 0) return null;
  let u: URL;
  try {
    u = new URL(b.logoUrl);
  } catch {
    return null;
  }
  const loopback = config.allowLoopbackForTests() && /^(127\.0\.0\.1|localhost)$/.test(u.hostname);
  if (u.protocol !== "https:" && !loopback) return null;
  return { src: b.logoUrl, width: b.logoWidth, height: b.logoHeight, mime: b.logoMime ?? "", source: b.logoSource ?? "", license: b.logoLicense };
}

export type BrandLogoMap = { bySlug: Record<string, BrandLogo>; byName: Record<string, BrandLogo> };

async function loadBrandLogos(): Promise<BrandLogoMap> {
  const rows = await db.commerceBrand.findMany({
    where: { logoStatus: "VERIFIED", logoUrl: { not: null } },
    select: { slug: true, name: true, logoStatus: true, logoUrl: true, logoWidth: true, logoHeight: true, logoMime: true, logoSource: true, logoLicense: true },
  });
  const out: BrandLogoMap = { bySlug: {}, byName: {} };
  const nameCount = new Map<string, number>();
  for (const r of rows) nameCount.set(brandKeyOf(r.name), (nameCount.get(brandKeyOf(r.name)) ?? 0) + 1);
  for (const r of rows) {
    const logo = publicLogo(r);
    if (!logo) continue;
    out.bySlug[r.slug] = logo;
    // A name shared by two brands is never used for lookup (could be the wrong one).
    const key = brandKeyOf(r.name);
    if (key && nameCount.get(key) === 1) out.byName[key] = logo;
  }
  return out;
}

const cachedLogos = unstable_cache(loadBrandLogos, ["brand-logos-v1"], { revalidate: 3600, tags: [BRAND_LOGOS_TAG] });

/** Every verified brand logo (cached for an hour, purged when the job changes one; one load per request). */
export const brandLogoMap = cache(async (): Promise<BrandLogoMap> => {
  try {
    return await cachedLogos();
  } catch (error) {
    log.debug("brand logo cache unavailable; loading directly", { error: String(error).slice(0, 200) });
    try {
      return await loadBrandLogos();
    } catch (e) {
      log.warn("brand logos unavailable", { error: String(e).slice(0, 200) });
      return { bySlug: {}, byName: {} };
    }
  }
});

/** The verified logo for a commerce brand slug, else (when given) a uniquely named brand. */
export function lookupLogo(map: BrandLogoMap, slug: string | null | undefined, name?: string | null): BrandLogo | null {
  if (slug && map.bySlug[slug]) return map.bySlug[slug];
  const key = name ? brandKeyOf(name) : "";
  return (key && map.byName[key]) || null;
}
