"use client";

import { useEffect, useRef } from "react";

/**
 * The cutting table: clippings drift a few pixels with the pointer and with scroll, each at its
 * own depth (data-depth). Fine pointers only, off for reduced motion, capped at ~14px.
 */
export default function Collage({ children, label }: { children: React.ReactNode; label: string }) {
  const host = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches || window.matchMedia("(max-width: 720px)").matches) return;
    const clips = [...el.querySelectorAll<HTMLElement>("[data-depth]")];
    let mx = 0;
    let my = 0;
    let raf = 0;
    const paint = () => {
      raf = 0;
      const sy = Math.min(1, window.scrollY / 700);
      for (const c of clips) {
        const d = Number(c.dataset.depth) || 1;
        c.style.setProperty("--px", `${(mx * 14 * d).toFixed(1)}px`);
        c.style.setProperty("--py", `${(my * 10 * d - sy * 40 * d).toFixed(1)}px`);
      }
    };
    const queue = () => {
      if (!raf) raf = requestAnimationFrame(paint);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      mx = e.clientX / window.innerWidth - 0.5;
      my = e.clientY / window.innerHeight - 0.5;
      queue();
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("scroll", queue, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("scroll", queue);
    };
  }, []);
  return (
    <aside ref={host} className="collage" aria-label={label}>
      {children}
      <span className="ruler" aria-hidden="true" />
    </aside>
  );
}
