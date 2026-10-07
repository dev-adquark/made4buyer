import { commonsThumbUrl, COMMONS_WIDTHS, parseCommons, responsiveImage, type ResponsiveOptions } from "@/lib/util/image-url";
import { IMAGE_DEVICE_SIZES, IMAGE_QUALITY, IMAGE_SIZES, imageOptimizerEnabled, matchesImagePattern } from "./remote-patterns";

/**
 * How one image is delivered (pure; used by <SafeImg> on server and client).
 *
 *  optimizer   same-origin /_next/image URLs (AVIF/WebP, widths from IMAGE_SIZES/IMAGE_DEVICE_SIZES):
 *              any https URL matching IMAGE_REMOTE_PATTERNS, when next.config.ts has switched the
 *              optimizer on. Wikimedia originals are fetched as a standard thumbnail (never a
 *              multi-megabyte original).
 *  source-cdn  the source CDN's own srcset (lib/util/image-url.ts), when the optimizer is off.
 *  direct      the URL as is (unknown hosts, or `responsive: false` with the optimizer off).
 *  local       our own files (/placeholders/*.svg): served as is.
 *  blocked     a URL that must not be fetched by the browser directly (`allowDirect: false`, e.g.
 *              a brand's product photo) and that the optimizer can't serve: show the placeholder.
 */

export type DeliveryOptions = {
  /** Intrinsic slot size (the width/height attributes). */
  width?: number;
  height?: number;
  sizes?: string;
  /** Sizing hints; `false` disables the source-CDN srcset (the optimizer still sizes the image). */
  responsive?: ResponsiveOptions | false;
  allowDirect?: boolean;
};

export type Delivery = {
  mode: "optimizer" | "source-cdn" | "direct" | "local" | "blocked";
  src: string;
  srcSet?: string;
  sizes?: string;
  /** What to try when the delivered image fails (the original, editorial only); undefined: go to the placeholder. */
  retrySrc?: string;
  blocked: boolean;
};

const LADDER = [...new Set([...IMAGE_SIZES, ...IMAGE_DEVICE_SIZES])].sort((a, b) => a - b);

export function optimizerUrl(src: string, width: number, quality = IMAGE_QUALITY): string {
  return `/_next/image?url=${encodeURIComponent(src)}&w=${width}&q=${quality}`;
}

function positive(n: number | undefined): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Default `sizes`: the slot's CSS width, or the viewport below it. */
export function defaultSizes(width?: number): string {
  return width ? `(max-width: ${width}px) 100vw, ${width}px` : "100vw";
}

/** The upstream URL the optimizer fetches: a Wikimedia standard thumbnail wide enough for `need` px, else the URL itself. */
export function optimizerSource(src: string, need: number): string {
  const f = parseCommons(src);
  if (!f) return src;
  const step = COMMONS_WIDTHS.find((w) => w >= need) ?? COMMONS_WIDTHS[COMMONS_WIDTHS.length - 1];
  const capped = f.thumbWidth ? Math.min(step, f.thumbWidth) : step;
  const snapped = [...COMMONS_WIDTHS].reverse().find((w) => w <= capped) ?? COMMONS_WIDTHS[0];
  return commonsThumbUrl(src, snapped) ?? src; // SVG/PDF etc.: the file itself (the optimizer refuses non-raster → placeholder)
}

export function optimizedImage(src: string, opts: DeliveryOptions = {}): Delivery {
  const allowDirect = opts.allowDirect !== false;
  if (src.startsWith("/") && !src.startsWith("//")) return { mode: "local", src, blocked: false };
  const r: ResponsiveOptions = opts.responsive === false ? {} : (opts.responsive ?? {});
  const width = positive(opts.width);
  const height = positive(opts.height);

  if (imageOptimizerEnabled() && matchesImagePattern(src)) {
    // object-fit: cover of a wider photo into a narrower box needs proportionally more pixels.
    const box = positive(r.boxAspect) ?? (width && height ? width / height : undefined);
    const sw = positive(r.sourceWidth);
    const sh = positive(r.sourceHeight);
    const aspect = sw && sh ? sw / sh : undefined;
    const cover = box && aspect && aspect > box ? aspect / box : 1;
    const cap = (positive(r.maxWidth) ?? (width ? width * 2 : 1920)) * cover;
    const first = LADDER.findIndex((w) => w >= cap);
    let widths = first === -1 ? LADDER : LADDER.slice(0, first + 1);
    // Never ask for more than the source has (the optimizer doesn't upscale; extra widths are waste).
    if (sw) {
      const within = widths.filter((w) => w <= sw);
      widths = within.length ? [...within, ...widths.filter((w) => w > sw).slice(0, 1)] : widths.slice(0, 1);
    }
    // Tiny widths are useless for large slots: drop those under a quarter of the slot.
    if (width) widths = widths.filter((w, i) => w >= width / 4 || i === widths.length - 1);
    const upstream = optimizerSource(src, widths[widths.length - 1]);
    const seen = new Set<number>();
    const srcSet = widths
      .map((w) => ({ w, d: Math.max(1, Math.round(w / cover)) }))
      .filter((c) => (seen.has(c.d) ? false : (seen.add(c.d), true)))
      .map((c) => `${optimizerUrl(upstream, c.w)} ${c.d}w`)
      .join(", ");
    // The plain src (no srcset support) is the 1x-ish candidate.
    const base = widths.find((w) => w >= (width ?? 640) * cover) ?? widths[widths.length - 1];
    return { mode: "optimizer", src: optimizerUrl(upstream, base), srcSet, sizes: opts.sizes ?? defaultSizes(width), retrySrc: allowDirect ? src : undefined, blocked: false };
  }

  if (!allowDirect) return { mode: "blocked", src, blocked: true };
  if (opts.responsive === false) return { mode: "direct", src, blocked: false };
  const cdn = responsiveImage(src, { maxWidth: width ? width * 2 : undefined, boxAspect: width && height ? width / height : undefined, ...r });
  if (!cdn.srcSet) return { mode: "direct", src: cdn.src, blocked: false };
  return { mode: "source-cdn", src: cdn.src, srcSet: cdn.srcSet, sizes: opts.sizes ?? defaultSizes(width), retrySrc: src, blocked: false };
}
