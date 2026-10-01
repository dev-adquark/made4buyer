"use client";

import { useEffect, useRef } from "react";

/**
 * Desktop-only editorial cursor: a small ring that follows the pointer and shows the verb of
 * whatever is under it (READ, VIEW DEAL, COMPARE…) from a `data-cursor` attribute. The native
 * cursor stays visible, nothing depends on it, and it is off for touch, reduced motion and
 * forced colours.
 */
export default function EditorialCursor() {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const fine = window.matchMedia("(pointer: fine) and (hover: hover)");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!fine.matches || reduce.matches) return;
    let x = -100;
    let y = -100;
    let tx = -100;
    let ty = -100;
    let raf = 0;
    const tick = () => {
      x += (tx - x) * 0.28;
      y += (ty - y) * 0.28;
      node.style.setProperty("--cx", `${x.toFixed(1)}px`);
      node.style.setProperty("--cy", `${y.toFixed(1)}px`);
      raf = Math.abs(tx - x) + Math.abs(ty - y) > 0.3 ? requestAnimationFrame(tick) : 0;
    };
    const tag = node.querySelector(".tag")!;
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      tx = e.clientX;
      ty = e.clientY;
      const target = (e.target as Element | null)?.closest<HTMLElement>("[data-cursor]");
      const label = target?.dataset.cursor;
      if (label) {
        node.dataset.label = label;
        tag.textContent = label;
      } else delete node.dataset.label;
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const onLeave = () => {
      tx = ty = -100;
      delete node.dataset.label;
      if (!raf) raf = requestAnimationFrame(tick);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
    };
  }, []);
  return (
    <div ref={el} className="cursor" aria-hidden="true">
      <span className="ring" />
      <span className="tag" />
    </div>
  );
}
