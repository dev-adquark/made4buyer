"use client";

import { useEffect, useRef, useState } from "react";
import SafeImg from "./safe-img";

/** Sticky in-page navigation with scroll-spy (aria-current on the visible section). */
export function SectionNav({ items }: { items: Array<{ id: string; label: string }> }) {
  const [current, setCurrent] = useState(items[0]?.id);
  useEffect(() => {
    const els = items.map((i) => document.getElementById(i.id)).filter((e): e is HTMLElement => Boolean(e));
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setCurrent(visible.target.id);
      },
      { rootMargin: "-140px 0px -55% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [items]);
  return (
    <nav className="subnav" aria-label="On this page">
      <ul className="container">
        {items.map((i) => (
          <li key={i.id}>
            <a href={`#${i.id}`} aria-current={current === i.id ? "true" : undefined}>
              {i.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Hero image with pointer tilt and gentle scroll parallax (disabled for reduced motion / touch). */
export function ParallaxFigure({ src, fallback, alt, width, height, caption }: { src: string; fallback: string; alt: string; width: number; height: number; caption?: string | null }) {
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = frame.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => el.style.setProperty("--parallax", `${Math.min(40, window.scrollY * 0.08).toFixed(1)}px`));
    };
    const fine = window.matchMedia("(pointer: fine)").matches;
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty("--ry", `${(((e.clientX - r.left) / r.width - 0.5) * 8).toFixed(2)}deg`);
      el.style.setProperty("--rx", `${(-((e.clientY - r.top) / r.height - 0.5) * 6).toFixed(2)}deg`);
    };
    const onLeave = () => {
      el.style.removeProperty("--rx");
      el.style.removeProperty("--ry");
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    if (fine) {
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerleave", onLeave);
    }
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
    };
  }, []);
  return (
    <figure className="hero-figure">
      <div className="frame" ref={frame}>
        <SafeImg src={src} fallback={fallback} alt={alt} width={width} height={height} fetchPriority="high" decoding="async" />
      </div>
      {caption && <figcaption className="figcaption">Image: {caption}</figcaption>}
    </figure>
  );
}
