"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Homepage horizontal rail. Scrolling is native (CSS scroll-snap, touch swipe, trackpad and
 * shift+wheel all work without JavaScript); the Prev/Next buttons, arrow-key paging and mouse
 * drag are progressive enhancements. The vertical wheel is never captured.
 */
export default function HomeRail({ id, label, title, children }: { id: string; label: string; title?: React.ReactNode; children: React.ReactNode }) {
  const track = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [edges, setEdges] = useState({ start: true, end: true });

  const measure = useCallback(() => {
    const el = track.current;
    if (!el) return;
    const start = el.scrollLeft <= 1;
    const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
    setEdges((p) => (p.start === start && p.end === end ? p : { start, end }));
  }, []);

  const page = useCallback((dir: 1 | -1) => {
    const el = track.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // One "page": the visible width, less a sliver so the next card's leading edge stays in view.
    el.scrollBy({ left: dir * Math.max(120, el.clientWidth * 0.9), behavior: reduce ? "auto" : "smooth" });
  }, []);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    setReady(true);
    measure();
    let raf = 0;
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), measure()));
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);

    // Mouse drag-to-scroll (mouse only: touch and pen already scroll natively).
    let drag: { x: number; left: number; moved: boolean } | null = null;
    let suppressClick = false;
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      drag = { x: e.clientX, left: el.scrollLeft, moved: false };
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 6) return;
      if (!drag.moved) {
        drag.moved = true;
        el.classList.add("is-dragging");
      }
      el.scrollLeft = drag.left - dx;
    };
    const up = () => {
      if (!drag) return;
      if (drag.moved) {
        suppressClick = true;
        el.classList.remove("is-dragging");
        setTimeout(() => (suppressClick = false), 0);
      }
      drag = null;
    };
    const click = (e: MouseEvent) => {
      if (suppressClick) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const dragStart = (e: DragEvent) => e.preventDefault();
    el.addEventListener("pointerdown", down, { passive: true });
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerup", up, { passive: true });
    window.addEventListener("pointercancel", up, { passive: true });
    el.addEventListener("click", click, true);
    el.addEventListener("dragstart", dragStart);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      el.removeEventListener("click", click, true);
      el.removeEventListener("dragstart", dragStart);
    };
  }, [measure]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Only when the rail itself has focus: inside a card, keys keep their usual meaning.
    if (e.target !== e.currentTarget) return;
    const el = e.currentTarget;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const behavior: ScrollBehavior = reduce ? "auto" : "smooth";
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const card = el.querySelector<HTMLElement>(".hr-list > li");
      const step = card ? card.getBoundingClientRect().width : el.clientWidth * 0.8;
      el.scrollBy({ left: (e.key === "ArrowRight" ? 1 : -1) * step, behavior });
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      page(e.key === "PageDown" ? 1 : -1);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      el.scrollTo({ left: e.key === "Home" ? 0 : el.scrollWidth, behavior });
    }
  };

  const scrollable = !(edges.start && edges.end);
  return (
    <div className="hr">
      <div className="hr-head">
        {title ? <h3 className="hr-title">{title}</h3> : <span />}
        <div className="hr-nav" data-ready={ready && scrollable ? "" : undefined}>
          <button type="button" className="hr-btn" aria-controls={id} aria-label={`Previous: ${label}`} disabled={!ready || edges.start} onClick={() => page(-1)}>
            <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16">
              <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" />
            </svg>
          </button>
          <button type="button" className="hr-btn" aria-controls={id} aria-label={`Next: ${label}`} disabled={!ready || edges.end} onClick={() => page(1)}>
            <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16">
              <path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" />
            </svg>
          </button>
        </div>
      </div>
      <div id={id} ref={track} className="hr-track" role="region" aria-label={label} tabIndex={0} onKeyDown={onKeyDown}>
        <ul className="hr-list">{children}</ul>
      </div>
    </div>
  );
}
