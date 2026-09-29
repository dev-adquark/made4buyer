"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Progressive scroll reveal. Content is fully visible without JS; once this runs it marks
 * <html> as reveal-ready and fades `.reveal` elements in as they enter the viewport.
 * Disabled entirely for prefers-reduced-motion.
 */
export default function RevealProvider() {
  const pathname = usePathname();
  useEffect(() => {
    const root = document.documentElement;
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
    const scan = () => {
      document.querySelectorAll(".reveal:not(.in)").forEach((el) => {
        const r = el.getBoundingClientRect();
        // Anything already on screen is shown immediately, so nothing flashes on load.
        if (r.top < window.innerHeight && r.bottom > 0) el.classList.add("in");
        else io.observe(el);
      });
    };
    scan();
    root.classList.add("reveal-ready");
    return () => io.disconnect();
  }, [pathname]);
  return null;
}
