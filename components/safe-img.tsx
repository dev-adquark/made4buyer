"use client";

import { useEffect, useRef, useState } from "react";
import { responsiveImage, type ResponsiveOptions } from "@/lib/util/image-url";

type Props = React.ImgHTMLAttributes<HTMLImageElement> & {
  src: string;
  fallback: string;
  /** Source-CDN srcset options (Pexels / Wikimedia); `false` serves `src` only. */
  responsive?: ResponsiveOptions | false;
};

/**
 * <img> with a source-CDN srcset (the same picture, sized for its slot, AVIF/WebP where the CDN
 * negotiates it). If a resized rendition fails it retries the original `src` without a srcset, and
 * only then swaps to our own category placeholder.
 */
export default function SafeImg({ src, fallback, alt, responsive, sizes, width, height, decoding = "async", ...rest }: Props) {
  // 0: srcset, 1: original src only, 2: placeholder.
  const [stage, setStage] = useState(0);
  const [shownSrc, setShownSrc] = useState(src);
  if (shownSrc !== src) {
    // A new image (client navigation): start again from its srcset.
    setShownSrc(src);
    setStage(0);
  }
  const ref = useRef<HTMLImageElement>(null);
  const w = Number(width) || undefined;
  const h = Number(height) || undefined;
  const r = responsive === false ? { src, srcSet: undefined } : responsiveImage(src, { maxWidth: w ? w * 2 : undefined, boxAspect: w && h ? w / h : undefined, ...responsive });
  const srcSet = stage === 0 ? r.srcSet : undefined;
  useEffect(() => {
    // An error that fired before hydration isn't delivered to onError; detect it on mount.
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0 && img.getAttribute("src") !== fallback) setStage((s) => (s === 0 && img.hasAttribute("srcset") ? 1 : 2));
  }, [fallback]);
  return (
    <img
      {...rest}
      ref={ref}
      src={stage === 2 ? fallback : stage === 1 ? src : r.src}
      srcSet={srcSet}
      sizes={srcSet ? (sizes ?? (w ? `(max-width: ${w}px) 100vw, ${w}px` : "100vw")) : undefined}
      width={width}
      height={height}
      alt={alt}
      decoding={decoding}
      onError={() => setStage((s) => (s === 0 && r.srcSet ? 1 : 2))}
    />
  );
}
