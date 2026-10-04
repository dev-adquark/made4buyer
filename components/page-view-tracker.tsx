"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { track } from "./analytics";

/** Records one page_view per public route change. Admin pages are excluded. */
export default function PageViewTracker() {
  const pathname = usePathname();
  useEffect(() => {
    if (!pathname || pathname.startsWith("/admin")) return;
    track("page_view");
  }, [pathname]);
  // Outbound clicks to a source publisher (links marked data-track="outbound").
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.(
        "a[data-track='outbound']",
      ) as HTMLAnchorElement | null;
      if (!a) return;
      track("outbound_click", {
        reviewId: a.dataset.reviewId,
        metadata: {
          host: new URL(a.href).hostname,
          kind: a.dataset.kind ?? "source",
        },
      });
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  return null;
}
