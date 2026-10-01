"use client";

import { useEffect } from "react";

/** Marks the masthead compact once the page has scrolled (one passive listener, no re-renders). */
export default function MastheadState() {
  useEffect(() => {
    const head = document.querySelector<HTMLElement>(".masthead");
    if (!head) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      head.dataset.compact = String(window.scrollY > 48);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);
  return null;
}
