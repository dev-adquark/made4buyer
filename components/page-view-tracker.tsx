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
  return null;
}
