"use client";

import { useEffect, useRef, useState } from "react";
import { optimizedImage, type DeliveryOptions } from "@/lib/images/delivery";
import type { ResponsiveOptions } from "@/lib/util/image-url";

type Props = Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src: string;
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
 * width/height (no layout shift). If the optimized image fails it retries the original (editorial
 * images only), and only then swaps to our own category placeholder.
 */
export default function SafeImg({ src, fallback, alt, responsive, sizes, width, height, priority, fit, focal, allowDirect = true, loading, fetchPriority, decoding = "async", style, ...rest }: Props) {
  // 0: optimized/srcset, 1: original src only, 2: placeholder.
  const [stage, setStage] = useState(0);
  const [shownSrc, setShownSrc] = useState(src);
  if (shownSrc !== src) {
    // A new image (client navigation): start again from its srcset.
    setShownSrc(src);
    setStage(0);
  }
  const ref = useRef<HTMLImageElement>(null);
  const opts: DeliveryOptions = { width: Number(width) || undefined, height: Number(height) || undefined, sizes, responsive, allowDirect };
  const d = optimizedImage(src, opts);
  // A URL that may not be loaded directly and can't be optimized shows the placeholder straight away.
  const effective = d.blocked ? 2 : stage;
  const canRetryDirect = d.retrySrc !== undefined;
  useEffect(() => {
    // An error that fired before hydration isn't delivered to onError; detect it on mount.
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0 && img.getAttribute("src") !== fallback) setStage((s) => (s === 0 && canRetryDirect ? 1 : 2));
  }, [fallback, canRetryDirect]);
  const imgSrc = effective === 2 ? fallback : effective === 1 ? (d.retrySrc ?? src) : d.src;
  const srcSet = effective === 0 ? d.srcSet : undefined;
  const fitStyle: React.CSSProperties | undefined =
    fit === "contain" && effective !== 2 ? { objectFit: "contain", objectPosition: "50% 50%", background: "var(--sheet, #f8f6f1)" } : fit === "cover" ? { objectFit: "cover", objectPosition: focal ?? "50% 50%" } : undefined;
  return (
    <img
      {...rest}
      ref={ref}
      src={imgSrc}
      srcSet={srcSet}
      sizes={srcSet ? d.sizes : undefined}
      width={width}
      height={height}
      alt={alt}
      // A high-priority (LCP) image is never lazy, whether marked with `priority` or `fetchPriority="high"`.
      loading={priority || fetchPriority === "high" ? "eager" : (loading ?? "lazy")}
      fetchPriority={priority ? "high" : fetchPriority}
      decoding={decoding}
      style={fitStyle || style ? { ...style, ...fitStyle } : undefined}
      data-delivery={effective === 2 ? "placeholder" : d.mode}
      onError={() => setStage((s) => (s === 0 && canRetryDirect ? 1 : 2))}
    />
  );
}
