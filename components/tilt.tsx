"use client";

import { useRef, type ReactNode } from "react";

/**
 * Pointer-driven perspective tilt (fine pointers only, off for reduced motion). Sets CSS
 * variables consumed by `.review-card` / `.hero-figure .frame`; no layout work per frame.
 */
export default function Tilt({ children, className, max = 6, style }: { children: ReactNode; className?: string; max?: number; style?: React.CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const allowed = () => typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const onMove = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el || !allowed()) return;
    cancelAnimationFrame(frame.current);
    const { clientX, clientY } = e;
    frame.current = requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      const x = (clientX - r.left) / r.width - 0.5;
      const y = (clientY - r.top) / r.height - 0.5;
      el.style.setProperty("--ry", `${(x * max).toFixed(2)}deg`);
      el.style.setProperty("--rx", `${(-y * max).toFixed(2)}deg`);
    });
  };
  const reset = () => {
    cancelAnimationFrame(frame.current);
    ref.current?.style.removeProperty("--rx");
    ref.current?.style.removeProperty("--ry");
  };
  return (
    <div ref={ref} className={className} style={style} onPointerMove={onMove} onPointerLeave={reset}>
      {children}
    </div>
  );
}
