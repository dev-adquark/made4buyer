"use client";

/** Client-side first-party analytics. Events go to /api/events; failures never affect the page. */

export type ClientEvent = "page_view" | "deal_impression" | "category_view" | "search" | "comparison";

const COOKIE = "m4b_sid";

export function sessionId(): string | undefined {
  try {
    const match = document.cookie.match(/(?:^|;\s*)m4b_sid=([A-Za-z0-9_-]{16,64})/);
    if (match) return match[1];
    const id = crypto.randomUUID().replace(/-/g, "");
    document.cookie = `${COOKIE}=${id}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
    return id;
  } catch {
    return undefined;
  }
}

type ExternalWindow = Window & { gtag?: (...args: unknown[]) => void; plausible?: (event: string, opts?: { props?: Record<string, unknown> }) => void };

/** Mirrors events to an external analytics script if one is loaded (gtag / Plausible-compatible). */
function forwardToExternal(event: ClientEvent, metadata?: Record<string, unknown>) {
  const w = window as ExternalWindow;
  if (event === "page_view") return; // external scripts track page views themselves
  if (typeof w.gtag === "function") w.gtag("event", event, metadata ?? {});
  if (typeof w.plausible === "function") w.plausible(event, { props: metadata });
}

export function track(event: ClientEvent, data: { reviewId?: string; categorySlug?: string | null; metadata?: Record<string, unknown> } = {}) {
  try {
    forwardToExternal(event, data.metadata);
    const body = JSON.stringify({ event, reviewId: data.reviewId, categorySlug: data.categorySlug ?? undefined, sessionId: sessionId(), path: location.pathname, metadata: data.metadata });
    if (navigator.sendBeacon && navigator.sendBeacon("/api/events", new Blob([body], { type: "application/json" }))) return;
    void fetch("/api/events", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => undefined);
  } catch {
    /* analytics is best-effort on the client */
  }
}
