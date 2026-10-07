"use client";

import { useEffect, useState } from "react";

/**
 * Keeps an overlay mounted while its CSS exit animation plays (a tiny replacement for
 * framer-motion's AnimatePresence, which cost ~60 KiB of JS on every page).
 *
 * Render the element while `mounted` is true and put `data-state={state}` on it; the CSS in
 * globals.css (`[data-motion]`) animates `open` in and `closed` out with transform/opacity only.
 * With prefers-reduced-motion the element unmounts immediately.
 */
export function usePresence(open: boolean, exitMs: number) {
  const [leaving, setLeaving] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  // Derived state (React's "adjust state while rendering" pattern): start leaving on close.
  if (open !== wasOpen) {
    setWasOpen(open);
    setLeaving(!open);
  }
  useEffect(() => {
    if (!leaving) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t = window.setTimeout(() => setLeaving(false), reduce ? 0 : exitMs);
    return () => window.clearTimeout(t);
  }, [leaving, exitMs]);
  return { mounted: open || leaving, state: open ? ("open" as const) : ("closed" as const) };
}
