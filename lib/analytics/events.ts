import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { log } from "@/lib/log";

/** First-party analytics event names. Client-reported events are a strict subset. */
export const EVENT_NAMES = ["page_view", "deal_impression", "affiliate_click", "category_view", "search", "comparison", "publish", "ingestion", "verification"] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export const CLIENT_EVENTS: ReadonlySet<EventName> = new Set(["page_view", "deal_impression", "category_view", "search", "comparison"]);

export async function recordEvent(e: {
  event: EventName;
  normalizedReviewId?: string | null;
  categorySlug?: string | null;
  sessionId?: string | null;
  path?: string | null;
  metadata?: Record<string, unknown>;
}) {
  try {
    await db.analyticsEvent.create({
      data: {
        event: e.event,
        normalizedReviewId: e.normalizedReviewId ?? null,
        categorySlug: e.categorySlug ?? null,
        sessionId: e.sessionId ?? null,
        path: e.path?.slice(0, 300) ?? null,
        metadata: e.metadata ? (JSON.parse(JSON.stringify(e.metadata)) as Prisma.InputJsonValue) : undefined,
      },
    });
  } catch (error) {
    // Analytics must never break the user-facing request, but failures are logged.
    log.error("analytics event write failed", { event: e.event, error });
  }
}
