import type { PageRenderModel } from "@/lib/pipeline/render-model";
import { categoryPhotoSrc, type CategoryPhoto } from "@/lib/public/category-images";

/**
 * The hero: the stored image (exact product photo, else a representative Pexels photo), else the
 * category's licensed Pexels photo with its credit; the category photo is also the browser-side
 * alternate if the stored image fails. Our placeholder graphic only when neither exists.
 */
export function heroImage(image: PageRenderModel["image"], photo: CategoryPhoto | null) {
  const representative = image.subject === "ILLUSTRATIVE";
  if (!image.isFallback || !photo) {
    const alt = photo ? categoryPhotoSrc(photo) : null;
    return { url: image.url, alternates: alt && alt !== image.url && !image.isFallback ? [alt] : [], alt: image.alt, width: image.width, height: image.height, caption: image.attribution, captionUrl: image.attributionUrl, representative: representative || image.isFallback };
  }
  const landscape = Boolean(photo.landscape);
  return { url: categoryPhotoSrc(photo), alternates: [] as string[], alt: photo.alt || image.alt, width: landscape ? 1200 : 800, height: landscape ? 627 : 1200, caption: `Photo by ${photo.photographer} on Pexels`, captionUrl: photo.pexelsUrl, representative: true };
}
