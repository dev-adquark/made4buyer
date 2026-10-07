"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Progressive scroll reveal. The server-rendered HTML is always fully visible (no SSR CSS hides
 * anything), so the first paint and the LCP never wait for JavaScript. After hydration this marks
 * only the `.reveal` / `.mask-reveal` elements that are still BELOW the fold as `.rv-pending`
 * (hidden while offscreen) and fades each one in (`.in`) as it scrolls into view. Elements already
 * in (or above) the viewport are never touched. Disabled entirely for prefers-reduced-motion.
 */
export default function RevealProvider() {
  const pathname = usePathname();
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    // Read every position first, then write classes: one layout pass, no read/write thrashing.
    const els = [...document.querySelectorAll<HTMLElement>(".reveal:not(.in):not(.rv-pending), .mask-reveal:not(.in):not(.rv-pending)")];
    const vh = window.innerHeight;
    const below = els.filter((el) => el.getBoundingClientRect().top >= vh);
    for (const el of below) {
      el.classList.add("rv-pending");
      io.observe(el);
    }
    document.documentElement.classList.add("reveal-ready");
    return () => io.disconnect();
  }, [pathname]);
  return null;
}
