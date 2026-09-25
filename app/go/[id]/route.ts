import { NextResponse } from "next/server";
import { recordEvent } from "@/lib/analytics/events";
import { db } from "@/lib/db";
import { validateOutboundUrl } from "@/lib/net/safe-fetch";
import { memoryRateLimit } from "@/lib/security/rate-limit";
import { clientIp } from "@/lib/security/request";

export const dynamic = "force-dynamic";

/**
 * Affiliate click redirect. Only redirects to a persisted, active, VERIFIED_OK affiliate
 * link of a PUBLISHED review — never to a URL supplied in the request.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const fallback = NextResponse.redirect(new URL("/", req.url), 302);
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return fallback;
  const link = await db.affiliateLink.findUnique({ where: { id }, include: { review: { select: { status: true, categorySlug: true, slug: true } } } });
  if (!link || !link.isActive || link.verificationStatus !== "VERIFIED_OK" || link.review.status !== "PUBLISHED") {
    return NextResponse.redirect(new URL(link?.review.status === "PUBLISHED" ? `/review/${link.review.slug}` : "/", req.url), 302);
  }
  const target = validateOutboundUrl(link.affiliateUrl, { standardPortsOnly: true });
  if (!target.url) return fallback;
  const sid = req.headers.get("cookie")?.match(/(?:^|;\s*)m4b_sid=([A-Za-z0-9_-]{16,64})/)?.[1];
  // Bot/abuse protection: clicks beyond the per-IP budget are not recorded as analytics.
  if (memoryRateLimit(`click:${clientIp(req) ?? "unknown"}`, 30, 60_000)) {
    await recordEvent({ event: "affiliate_click", normalizedReviewId: link.normalizedReviewId, categorySlug: link.review.categorySlug, sessionId: sid, path: `/review/${link.review.slug}`, metadata: { linkId: link.id, offerId: link.sovrnOfferId } });
  }
  const res = NextResponse.redirect(target.url.toString(), 302);
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("X-Robots-Tag", "noindex, nofollow");
  res.headers.set("Referrer-Policy", "no-referrer-when-downgrade");
  return res;
}
