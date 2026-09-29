import { NextResponse } from "next/server";
import { CLIENT_EVENTS, recordEvent, type EventName } from "@/lib/analytics/events";
import { db } from "@/lib/db";
import { memoryRateLimit } from "@/lib/security/rate-limit";
import { clientIp } from "@/lib/security/request";
import { CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";

export const dynamic = "force-dynamic";

/** First-party analytics ingestion for client events. Validates, rate-limits and bounds every field. */
export async function POST(req: Request) {
  if (!memoryRateLimit(`events:${clientIp(req) ?? "unknown"}`, 120, 60_000)) return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  const text = await req.text().catch(() => "");
  if (text.length > 4000) return NextResponse.json({ ok: false, error: "payload_too_large" }, { status: 413 });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const event = String(body.event ?? "") as EventName;
  if (!CLIENT_EVENTS.has(event)) return NextResponse.json({ ok: false, error: "unsupported_event" }, { status: 422 });
  const sessionId = typeof body.sessionId === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(body.sessionId) ? body.sessionId : null;
  const path = typeof body.path === "string" && body.path.startsWith("/") ? body.path.slice(0, 300) : null;
  if (path?.startsWith("/admin")) return NextResponse.json({ ok: true, ignored: true });

  let reviewId: string | null = null;
  let categorySlug = typeof body.categorySlug === "string" && CATEGORY_BY_SLUG.has(body.categorySlug) ? body.categorySlug : null;
  if (typeof body.reviewId === "string" && /^[a-z0-9]{10,40}$/i.test(body.reviewId)) {
    const review = await db.normalizedReview.findUnique({ where: { id: body.reviewId }, select: { status: true, categorySlug: true } });
    if (!review || review.status !== "PUBLISHED") return NextResponse.json({ ok: false, error: "invalid_review" }, { status: 422 });
    reviewId = body.reviewId;
    categorySlug = review.categorySlug;
  }
  if (event === "deal_impression" && !reviewId) return NextResponse.json({ ok: false, error: "review_required" }, { status: 422 });

  const raw = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) ? (body.metadata as Record<string, unknown>) : {};
  const metadata: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw).slice(0, 10)) {
    if (!/^[a-zA-Z_]{1,30}$/.test(k)) continue;
    if (typeof v === "string") metadata[k] = v.slice(0, 200);
    else if (typeof v === "number" || typeof v === "boolean") metadata[k] = v;
    else if (Array.isArray(v)) metadata[k] = v.slice(0, 5).map((x) => String(x).slice(0, 60));
    else if (v && typeof v === "object") {
      const nested: Record<string, string | number | boolean> = {};
      for (const [nk, nv] of Object.entries(v as Record<string, unknown>).slice(0, 8)) {
        if (/^[a-zA-Z_]{1,30}$/.test(nk) && (typeof nv === "string" || typeof nv === "number" || typeof nv === "boolean")) nested[nk] = typeof nv === "string" ? nv.slice(0, 60) : nv;
      }
      metadata[k] = nested;
    }
  }
  await recordEvent({ event, normalizedReviewId: reviewId, categorySlug, sessionId, path, metadata });
  return NextResponse.json({ ok: true });
}
