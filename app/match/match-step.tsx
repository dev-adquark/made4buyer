"use client";

import { useEffect, useRef } from "react";

/**
 * One step of the match flow. Every answer is a full page load (see match-view.tsx), so when the
 * page was reached from the previous step, focus moves to the new question: keyboard and
 * screen-reader users land on what is being asked instead of the top of the page. A first visit
 * (from anywhere else) keeps the browser's default focus. No entrance animation: the question is
 * the page's LCP text and must never start hidden.
 */
export default function MatchStep({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let fromMatch = false;
    try {
      const from = document.referrer ? new URL(document.referrer) : null;
      fromMatch = Boolean(from && from.origin === location.origin && from.pathname === "/match");
    } catch {
      fromMatch = false;
    }
    if (fromMatch) ref.current?.querySelector<HTMLElement>("h1")?.focus();
  }, []);
  return <div ref={ref}>{children}</div>;
}
