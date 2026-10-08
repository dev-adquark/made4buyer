import { db } from "@/lib/db";
import type { ExactProductImage } from "@/lib/pipeline/images";
import { dealImage, retailerDealImage } from "./deal-image";
import { exactConfidence } from "./deal-card-image";

/**
 * Exact product photos for a single-product review, from the commerce engine (no network here):
 *
 *   1. official  the brand's own product page of this exact product: a CommerceProduct identity-matched
 *                (MATCHED) to the review's PRIMARY ProductEntity, on its brand's official domain, whose
 *                stored official photos (Shopify variant / JSON-LD / og:image; lib/images/deal-image.ts) are
 *                https on that same domain and not marked broken by the image-integrity job;
 *   2. retailer  an identity-matched retailer page's own photo of the product, on the retailer's own domain.
 *
 * The review publisher's article image is never used here (it isn't licensed to us).
 */
export async function exactProductImagesFor(productEntityId: string): Promise<ExactProductImage[]> {
  const products = await db.commerceProduct.findMany({
    where: { productEntityId, identityStatus: "MATCHED" },
    orderBy: { observedAt: "desc" },
    take: 20,
    select: { canonicalUrl: true, data: true, name: true, identityStatus: true, brand: { select: { officialDomain: true, name: true } } },
  });
  return exactImagesFromProducts(products);
}

export type ExactImageProduct = { canonicalUrl: string; data: unknown; name: string; identityStatus: string | null; brand: { officialDomain: string; name: string } | null };

/** Pure: official photos first (each product's best), then retailer photos. */
export function exactImagesFromProducts(products: ExactImageProduct[]): ExactProductImage[] {
  const official: ExactProductImage[] = [];
  const retailer: ExactProductImage[] = [];
  for (const p of products) {
    if (p.identityStatus !== "MATCHED") continue;
    // Official only when the product belongs to a brand and its page is on that brand's own domain (dealImage checks).
    const own = p.brand ? dealImage(p, { requireListedDomain: false }) : null;
    if (own) {
      official.push({ url: own.src, kind: "official", pageUrl: p.canonicalUrl, basis: `commerce-product:${own.source}`, confidence: exactConfidence(own.source), alt: own.alt ?? p.name, width: own.width, height: own.height, publisher: p.brand?.name ?? null });
      continue;
    }
    const ret = retailerDealImage(p);
    if (ret) retailer.push({ url: ret.src, kind: "retailer", pageUrl: p.canonicalUrl, basis: `retailer-product:${ret.source}`, confidence: exactConfidence(ret.source) * 0.9, alt: ret.alt ?? p.name, width: ret.width, height: ret.height, publisher: hostOf(p.canonicalUrl) });
  }
  const seen = new Set<string>();
  return [...official, ...retailer].filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true)));
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
