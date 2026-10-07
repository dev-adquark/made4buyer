/**
 * Image provenance (ImageAsset.imageType): what an image shows and how we know.
 *
 * A single-product page's hero is, in order: the exact product (a licensed source whose identity
 * match we can check), a labelled illustrative photo of that KIND of product (its type read from
 * the product name; the photo's own description must name the type), or a neutral category
 * image. A stock photo matched by product-name keywords is never presented as the product.
 */
export const IMAGE_TYPES = [
  "official-product", // the manufacturer's own photo, licensed to us
  "retailer-product", // a verified retailer's photo, licensed to us
  "commons-product", // a freely licensed photo of the exact product on Wikimedia Commons
  "source-product", // the review source's own image, explicitly licensed to us (Content API)
  "illustrative-product-type", // a labelled photo of the product's type (a tumbler for a tumbler review)
  "illustrative-category", // a labelled topic photo for category-level content (guides)
  "neutral-category", // our own category placeholder: names the category, shows no product
] as const;

export type ImageType = (typeof IMAGE_TYPES)[number];

/** Types that claim to show the exact product. */
export const PRODUCT_IMAGE_TYPES: ReadonlySet<string> = new Set<ImageType>(["official-product", "retailer-product", "commons-product", "source-product"]);

/** The provenance of a stored row written before provenance existed (null: not allowed any more). */
export function inferImageType(a: { sourceType: string; subject?: string | null }): ImageType | null {
  switch (a.sourceType) {
    case "PLACEHOLDER":
      return "neutral-category";
    case "WIKIMEDIA_COMMONS":
      return "commons-product";
    case "CONTENT_API":
      return a.subject === "ILLUSTRATIVE" ? "illustrative-category" : "source-product";
    case "ENRICHMENT_SERVICE":
      // Keyword stock photos are only ever illustrative; a stored "product" stock photo is invalid.
      return a.subject === "ILLUSTRATIVE" ? "illustrative-category" : null;
    default:
      return null;
  }
}

/** Below this, a photo claiming to be the exact product is "low confidence" (Admin → Images) and never used on a deal card. */
export const LOW_CONFIDENCE = 0.85;

/** Visible label on any image that is not the exact reviewed product (review hero, review cards). Kept equal to components/review-chrome.tsx. */
export const ILLUSTRATIVE_CAPTION = "Illustrative image — not the reviewed product";
/** Visible label on an illustrative deal / price card photo (same wording pattern). */
export const ILLUSTRATIVE_DEAL_CAPTION = "Illustrative image — not the exact product";
