"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { themeStyle } from "@/lib/taxonomy/themes";

export type TickerItem = { key: string; href: string; label: string; text: string; slug?: string | null };

/**
 * The running strip. It is a real horizontal scroller (drag, trackpad, touch and keyboard all
 * work); it drifts on its own only when motion is allowed, and pauses on hover, focus or touch.
 * Vertical wheel scrolling is never captured.
 */
export default function Ticker({ items, label }: { items: TickerItem[]; label: string }) {
  const track = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const list = el.querySelector<HTMLElement>(".ticker-list");
    let paused = false;
    let raf = 0;
    let drag: { x: number; left: number } | null = null;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const step = () => {
      if (!paused && !drag && list) {
        el.scrollLeft += 0.45;
        if (el.scrollLeft >= list.offsetWidth) el.scrollLeft -= list.offsetWidth;
      }
      raf = requestAnimationFrame(step);
    };
    if (!reduce) raf = requestAnimationFrame(step);
    const pause = () => (paused = true);
    const resume = () => (paused = false);
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return pause();
      drag = { x: e.clientX, left: el.scrollLeft };
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      el.scrollLeft = drag.left - (e.clientX - drag.x);
    };
    const up = () => (drag = null);
    el.addEventListener("pointerenter", pause);
    el.addEventListener("pointerleave", resume);
    el.addEventListener("focusin", pause);
    el.addEventListener("focusout", resume);
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerup", up);
    el.addEventListener("touchend", () => setTimeout(resume, 2500), { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);
  if (!items.length) return null;
  const render = (copy: boolean) => (
    <ul className="ticker-list" aria-hidden={copy || undefined}>
      {items.map((it) => (
        <li key={`${copy ? "b" : "a"}-${it.key}`} className="ticker-item" style={themeStyle(it.slug) as React.CSSProperties}>
          <span className="dot" aria-hidden="true" />
          <span className="label">{it.label}</span>
          <Link href={it.href} tabIndex={copy ? -1 : undefined} draggable={false}>
            {it.text}
          </Link>
        </li>
      ))}
    </ul>
  );
  return (
    <section className="ticker" aria-label={label}>
      <div className="ticker-track" ref={track} tabIndex={0}>
        {render(false)}
        {render(true)}
      </div>
    </section>
  );
}
