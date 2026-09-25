"use client";

import { useEffect, useRef, useState } from "react";

/** <img> that swaps to our own category placeholder if the source image fails to load. */
export default function SafeImg({ src, fallback, alt, ...rest }: React.ImgHTMLAttributes<HTMLImageElement> & { src: string; fallback: string }) {
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    // An error that fired before hydration isn't delivered to onError; detect it on mount.
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0 && img.getAttribute("src") !== fallback) setFailed(true);
  }, [fallback]);
  return <img {...rest} ref={ref} src={failed ? fallback : src} alt={alt} onError={() => setFailed(true)} />;
}
