"use client";

import { useEffect, useRef } from "react";
import { track, type ClientEvent } from "./analytics";

/** Fires a single analytics event when mounted (category_view, search, comparison). */
export default function TrackOnce({ event, reviewId, categorySlug, metadata }: { event: ClientEvent; reviewId?: string; categorySlug?: string | null; metadata?: Record<string, unknown> }) {
  const sent = useRef(false);
  const key = JSON.stringify(metadata ?? {});
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    track(event, { reviewId, categorySlug, metadata: JSON.parse(key) as Record<string, unknown> });
  }, [event, reviewId, categorySlug, key]);
  return null;
}
