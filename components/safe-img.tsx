"use client";

import { useEffect, useRef, useState } from "react";
import { firstShowable, imageCandidates, nextImageStep, optimizedImage, type DeliveryOptions, type ImageStep } from "@/lib/images/delivery";
import type { ResponsiveOptions } from "@/lib/util/image-url";

type Props = Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src: string;
  /** Other relevant images, tried in order when `src` fails (e.g. the category's licensed photo). */
  alternates?: string[];
  /** Our placeholder graphic: shown only when `src` and every alternate failed. */
  fallback: string;
  /** Sizing hints (source size, cover box aspect, largest rendered width); `false` serves `src` only. */
  responsive?: ResponsiveOptions | false;
  /** The page's above-the-fold hero (LCP) image: eager + fetchpriority=high. Use on one image per page. */
  priority?: boolean;
  /** "contain": a product photo, whole, on a neutral background (never cropped). "cover": an editorial photo filling its box. */
  fit?: "contain" | "cover";
  /** object-position for "cover" (the photo's safe focal point). Default: centre. */
  focal?: string;
  /** false: this URL must never be fetched by the browser directly (deal images): optimizer or placeholder only. */
  allowDirect?: boolean;
};

/**
 * <img> served through the Next.js image optimizer when it is on (same-origin /_next/image: AVIF/WebP,
 * widths sized by `sizes`, no third-party cookies), else the source CDN's own srcset. Always carries
 * width/height (no layout shift). When an image fails it retries the original (editorial images
 * only), then moves to the next candidate (`alternates`: e.g. the stored representative photo, the
 * category's licensed photo), and only when every candidate failed shows our placeholder graphic.
 */
export default function SafeImg({ src, alternates, fallback, alt, responsive, sizes, width, height, priority, fit, focal, allowDirect = true, loading, fetchPriority, decoding = "async", style, ...rest }: Props) {
  // Candidates in order: the image, then each distinct alternate. Past the last one: the placeholder.
  const candidates = imageCandidates(src, alternates);
  const key = candidates.join("\n");
  const [step, setStep] = useState<ImageStep>({ index: 0, retry: 0 });
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) {
    // A new image (client navigation): start again from its first candidate.
    setShownKey(key);
    setStep({ index: 0, retry: 0 });
  }
  const ref = useRef<HTMLImageElement>(null);
  const opts: DeliveryOptions = { width: Number(width) || undefined, height: Number(height) || undefined, sizes, responsive, allowDirect };
  // Candidates that may not be loaded directly and can't be optimized are skipped.
  const index = firstShowable(candidates, step.index, opts);
  const current = index >= 0 ? candidates[index] : null;
  const d = current ? optimizedImage(current, opts) : null;
  const retry = index === step.index ? step.retry : 0;
  const canRetryDirect = d?.retrySrc !== undefined;
  const advance = () => setStep((s) => nextImageStep(s, Math.max(index, s.index), canRetryDirect));
  useEffect(() => {
    // An error that fired before hydration isn't delivered to onError; detect it on mount.
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0 && img.getAttribute("src") !== fallback) advance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fallback, key]);
  const imgSrc = !d ? fallback : retry === 1 ? (d.retrySrc ?? current!) : d.src;
  const srcSet = d && retry === 0 ? d.srcSet : undefined;
  const placeholder = !d;
  const fitStyle: React.CSSProperties | undefined =
    fit === "contain" && !placeholder ? { objectFit: "contain", objectPosition: "50% 50%", background: "var(--sheet, #f8f6f1)" } : fit === "cover" ? { objectFit: "cover", objectPosition: focal ?? "50% 50%" } : undefined;
  return (
    <img
      {...rest}
      ref={ref}
      src={imgSrc}
      srcSet={srcSet}
      sizes={srcSet ? d?.sizes : undefined}
      width={width}
      height={height}
      alt={alt}
      // A high-priority (LCP) image is never lazy, whether marked with `priority` or `fetchPriority="high"`.
      loading={priority || fetchPriority === "high" ? "eager" : (loading ?? "lazy")}
      fetchPriority={priority ? "high" : fetchPriority}
      decoding={decoding}
      style={fitStyle || style ? { ...style, ...fitStyle } : undefined}
      data-delivery={placeholder ? "placeholder" : d.mode}
      data-candidate={placeholder ? undefined : index > 0 ? "alternate" : undefined}
      onError={placeholder ? undefined : advance}
    />
  );
}
