"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { track } from "./analytics";

/**
 * Wraps a priced seller offer. Emits one deal_impression when at least half of it is visible —
 * these are the "eligible deal impressions" used as the CTR denominator.
 */
export default function DealImpression({ offerId, reviewId, categorySlug, children }: { offerId: string; reviewId: string; categorySlug?: string | null; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let sent = false;
    const fire = () => {
      if (sent) return;
      sent = true;
      track("deal_impression", { reviewId, categorySlug, metadata: { offerId } });
    };
    if (typeof IntersectionObserver === "undefined") {
      fire();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          fire();
          io.disconnect();
        }
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [offerId, reviewId, categorySlug]);
  return <div ref={ref}>{children}</div>;
}
