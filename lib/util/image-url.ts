/**
 * Responsive image URLs built from the source CDN's own resizing parameters: no proxy, no copies
 * of licensed files, no image-optimisation quota. The image shown never changes, only its size.
 *
 * - Pexels (images.pexels.com): `w`/`h` query parameters, keeping the original crop's aspect
 *   ratio; `auto=compress` lets the CDN negotiate AVIF/WebP from the browser's Accept header.
 * - Wikimedia (upload.wikimedia.org, thumb.wikimedia.org): the thumbnail path
 *   `/wikipedia/<project>/thumb/<a>/<ab>/<File>/<width>px-<File>`. Wikimedia only renders its
 *   standard thumbnail steps (other widths answer HTTP 400) and happily upscales small files, so
 *   candidates are limited to the standard steps and capped at a known source width.
 * - Anything else (local SVG placeholders, merchant images, unknown hosts) passes through untouched.
 */

/** Width ladder for Pexels (any width is allowed; these keep the srcset short). */
export const PEXELS_WIDTHS = [160, 320, 480, 640, 960, 1200, 1600, 1920] as const;
/** Wikimedia's standard thumbnail steps; other widths are refused with HTTP 400. */
export const COMMONS_WIDTHS = [120, 250, 330, 500, 960, 1280, 1920] as const;
/** MediaWiki shortens thumbnail names longer than this many bytes to `thumbnail.<ext>` (WMF abbrvThreshold). */
const COMMONS_ABBRV_THRESHOLD = 160;
const COMMONS_HOSTS = new Set(["upload.wikimedia.org", "thumb.wikimedia.org"]);
const COMMONS_RASTER = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
const COMMONS_TIFF = new Set(["tif", "tiff"]);

export type ResponsiveOptions = {
  /** Largest pixel width any layout will need (CSS px × device pixel ratio). Default 1920. */
  maxWidth?: number;
  /** Intrinsic size of the source file, when known (caps candidates so nothing is upscaled). */
  sourceWidth?: number;
  sourceHeight?: number;
  /** Aspect ratio (w/h) of the object-fit: cover box the image fills, so cropped images stay sharp. */
  boxAspect?: number;
};

export type ResponsiveImage = { src: string; srcSet?: string };

type Candidate = { url: string; width: number };

function parse(src: string): URL | null {
  if (!/^https:\/\//i.test(src)) return null;
  try {
    return new URL(src);
  } catch {
    return null;
  }
}

function positive(n: number | undefined): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

// ---------------------------------------------------------------- Pexels

function isPexels(u: URL): boolean {
  return u.hostname === "images.pexels.com" && u.pathname.startsWith("/photos/");
}

/** A Pexels URL resized to `width`, keeping its crop's aspect ratio and every other parameter. */
export function pexelsUrl(src: string, width: number): string {
  const u = parse(src);
  if (!u || !isPexels(u)) return src;
  const p = u.searchParams;
  const w0 = positive(Number(p.get("w")));
  const h0 = positive(Number(p.get("h")));
  const w = Math.max(1, Math.round(width));
  if (w0 && h0) p.set("h", String(Math.max(1, Math.round((w * h0) / w0))));
  else p.delete("h"); // a lone h (or none) means "keep the aspect ratio": w alone does the same
  p.set("w", String(w));
  p.delete("dpr"); // the srcset descriptor carries the density now
  if (!p.has("auto")) p.set("auto", "compress");
  if (!p.has("cs")) p.set("cs", "tinysrgb");
  return u.toString();
}

function pexelsCandidates(u: URL, src: string, opts: ResponsiveOptions): { candidates: Candidate[]; aspect?: number } {
  const w0 = positive(Number(u.searchParams.get("w")));
  const h0 = positive(Number(u.searchParams.get("h")));
  const sw = positive(opts.sourceWidth);
  const sh = positive(opts.sourceHeight);
  // Never request more pixels than the current URL already delivers.
  const cap = w0 ?? sw ?? Number.POSITIVE_INFINITY;
  const aspect = w0 && h0 ? w0 / h0 : sw && sh ? sw / sh : undefined;
  const widths: number[] = PEXELS_WIDTHS.filter((w) => w < cap);
  if (Number.isFinite(cap)) widths.push(cap);
  return { candidates: widths.map((w) => ({ url: pexelsUrl(src, w), width: w })), aspect };
}

// ---------------------------------------------------------------- Wikimedia

type CommonsFile = { base: string; hashA: string; hashAB: string; name: string; ext: string; thumbWidth?: number };

/** Parse an original or thumbnail Wikimedia upload URL (query string ignored). */
export function parseCommons(src: string): CommonsFile | null {
  const u = parse(src);
  if (!u || !COMMONS_HOSTS.has(u.hostname)) return null;
  const orig = u.pathname.match(/^\/(wikipedia\/[^/]+)\/([0-9a-f])\/([0-9a-f]{2})\/([^/]+)$/);
  const thumb = u.pathname.match(/^\/(wikipedia\/[^/]+)\/thumb\/([0-9a-f])\/([0-9a-f]{2})\/([^/]+)\/(?:lossy-|lossless-)?(?:page\d+-)?(\d+)px-[^/]+$/);
  const m = thumb ?? orig;
  if (!m || m[3][0] !== m[2]) return null;
  const name = m[4];
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return { base: `https://${u.hostname}/${m[1]}`, hashA: m[2], hashAB: m[3], name, ext, thumbWidth: thumb ? Number(thumb[5]) : undefined };
}

function decodedByteLength(encoded: string): number {
  let decoded = encoded;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    /* keep raw */
  }
  return new TextEncoder().encode(decoded).length;
}

/** The thumbnail URL for a Wikimedia file at `width`, or null for formats we don't thumbnail. */
export function commonsThumbUrl(src: string, width: number): string | null {
  const f = parseCommons(src);
  if (!f) return null;
  const tiff = COMMONS_TIFF.has(f.ext);
  if (!tiff && !COMMONS_RASTER.has(f.ext)) return null; // SVG (vector, scales itself), PDF, video…
  const short = decodedByteLength(f.name) > COMMONS_ABBRV_THRESHOLD ? `thumbnail.${f.ext}` : f.name;
  const w = Math.round(width);
  const thumbName = tiff ? `lossy-page1-${w}px-${short}.jpg` : `${w}px-${short}`;
  return `${f.base}/thumb/${f.hashA}/${f.hashAB}/${f.name}/${thumbName}`;
}

function commonsCandidates(src: string, opts: ResponsiveOptions): { candidates: Candidate[]; aspect?: number; tiff: boolean } | null {
  const f = parseCommons(src);
  if (!f || !commonsThumbUrl(src, COMMONS_WIDTHS[0])) return null;
  const sw = positive(opts.sourceWidth);
  const sh = positive(opts.sourceHeight);
  // A thumbnail URL already caps what we deliver; a known source width prevents upscaling.
  const cap = Math.min(f.thumbWidth ?? Number.POSITIVE_INFINITY, sw ?? Number.POSITIVE_INFINITY);
  const candidates: Candidate[] = COMMONS_WIDTHS.filter((w) => w <= cap).map((w) => ({ url: commonsThumbUrl(src, w)!, width: w }));
  const tiff = COMMONS_TIFF.has(f.ext);
  const top = candidates.at(-1)?.width ?? 0;
  // The original itself is a valid top candidate when its width is known and the steps stop short.
  if (!tiff && !f.thumbWidth && sw && sw > top) candidates.push({ url: src, width: sw });
  return { candidates, aspect: sw && sh ? sw / sh : undefined, tiff };
}

// ---------------------------------------------------------------- srcset

/**
 * `src` + `srcSet` for an image, or just `src` when its host can't be resized. The `w` descriptors
 * are divided by the object-fit: cover overflow so a wide photo cropped into a narrower box is
 * still fetched sharp enough for the part that is visible.
 */
export function responsiveImage(src: string, opts: ResponsiveOptions = {}): ResponsiveImage {
  const u = parse(src);
  if (!u) return { src };
  let built: { candidates: Candidate[]; aspect?: number; tiff?: boolean } | null = null;
  if (isPexels(u)) built = pexelsCandidates(u, src, opts);
  else if (COMMONS_HOSTS.has(u.hostname)) built = commonsCandidates(src, opts);
  if (!built || !built.candidates.length) return { src };

  const box = positive(opts.boxAspect);
  const cover = box && built.aspect && built.aspect > box ? built.aspect / box : 1;
  const maxWidth = (positive(opts.maxWidth) ?? 1920) * cover;
  // Keep candidates up to the first one that covers maxWidth; larger ones would never be picked.
  const firstEnough = built.candidates.findIndex((c) => c.width >= maxWidth);
  const kept = firstEnough === -1 ? built.candidates : built.candidates.slice(0, firstEnough + 1);
  // A TIFF can't be shown by most browsers, so its fallback src is the largest JPEG thumbnail.
  const fallbackSrc = built.tiff ? kept.at(-1)!.url : src;
  if (kept.length < 2) return { src: fallbackSrc };
  const seen = new Set<number>();
  const srcSet = kept
    .map((c) => ({ url: c.url, w: Math.max(1, Math.round(c.width / cover)) }))
    .filter((c) => (seen.has(c.w) ? false : (seen.add(c.w), true)))
    // Raw commas or spaces in a file name would split a srcset entry; percent-encode them.
    .map((c) => `${c.url.replace(/,/g, "%2C").replace(/\s/g, "%20")} ${c.w}w`)
    .join(", ");
  return { src: fallbackSrc, srcSet };
}
