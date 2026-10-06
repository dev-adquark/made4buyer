/**
 * Image provenance (ImageAsset.imageType): what an image shows and how we know.
 *
 * A single-product page's hero is either the exact product (from a licensed source whose
 * identity match we can check) or a neutral category image. A keyword-matched stock photo is
 * never the hero of a single-product page; it may illustrate category-level content only, and
 * is then labelled "Illustrative photo, not the reviewed product".
 */
export const IMAGE_TYPES = [
  "official-product", // the manufacturer's own photo, licensed to us
  "retailer-product", // a verified retailer's photo, licensed to us
  "commons-product", // a freely licensed photo of the exact product on Wikimedia Commons
  "source-product", // the review source's own image, explicitly licensed to us (Content API)
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
