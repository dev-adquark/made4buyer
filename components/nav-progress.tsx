"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

/**
 * Top progress bar: starts on the click itself (before the next page is ready), so every link
 * answers instantly, and finishes when the URL changes. Same-page links, new-tab clicks, downloads
 * and external links never start it; a safety timeout ends it if a navigation never completes.
 */
function Bar() {
  const key = `${usePathname()}?${useSearchParams()}`;
  const [state, setState] = useState<"idle" | "run" | "done">("idle");
  const last = useRef(key);
  const timers = useRef<number[]>([]);
  const clear = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };

  useEffect(() => {
    if (last.current === key) return;
    last.current = key;
    clear();
    setState("done");
    timers.current.push(window.setTimeout(() => setState("idle"), 350));
  }, [key]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || !a.href || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search)) return;
      clear();
      setState("run");
      timers.current.push(window.setTimeout(() => setState("idle"), 15000));
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", () => setState("idle"));
    return () => {
      document.removeEventListener("click", onClick, true);
      clear();
    };
  }, []);

  return <div className="nav-progress" data-state={state} role="progressbar" aria-hidden={state === "idle"} aria-label="Loading page" />;
}

export default function NavProgress() {
  return (
    <Suspense fallback={null}>
      <Bar />
    </Suspense>
  );
}
