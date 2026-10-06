import { NextResponse } from "next/server";
import { recordEvent } from "@/lib/analytics/events";
import { db } from "@/lib/db";
import { validateOutboundUrl } from "@/lib/net/safe-fetch";
import { offerUrl } from "@/lib/public/offers";
import { memoryRateLimit } from "@/lib/security/rate-limit";
import { clientIp } from "@/lib/security/request";

export const dynamic = "force-dynamic";

/**
 * Retailer click redirect. Only redirects to the stored URL of a commerce-engine offer
 * (FRESH or STALE) for the PRIMARY product of a PUBLISHED review — never to a URL supplied in
 * the request. The stored URL is the provider-generated affiliate URL when one exists,
 * otherwise the plain retailer URL.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const fallback = NextResponse.redirect(new URL("/", req.url), 302);
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return fallback;
  const offer = await db.commerceOffer.findUnique({ where: { id }, select: { id: true, status: true, destinationUrl: true, affiliateUrl: true, affiliateStatus: true, product: { select: { productEntityId: true } } } });
  if (!offer || (offer.status !== "FRESH" && offer.status !== "STALE") || !offer.product.productEntityId) return fallback;
  const link = await db.contentEntity.findFirst({
    where: { productEntityId: offer.product.productEntityId, role: "PRIMARY", review: { status: "PUBLISHED" } },
    orderBy: { createdAt: "asc" },
    select: { review: { select: { id: true, slug: true, categorySlug: true } } },
  });
  if (!link) return fallback;
  const { url, affiliated } = offerUrl(offer);
  const target = validateOutboundUrl(url, { standardPortsOnly: true });
  if (!target.url) return NextResponse.redirect(new URL(`/review/${link.review.slug}`, req.url), 302);
  const sid = req.headers.get("cookie")?.match(/(?:^|;\s*)m4b_sid=([A-Za-z0-9_-]{16,64})/)?.[1];
  // Bot/abuse protection: clicks beyond the per-IP budget are not recorded as analytics.
  if (memoryRateLimit(`click:${clientIp(req) ?? "unknown"}`, 30, 60_000)) {
    await recordEvent({ event: "affiliate_click", normalizedReviewId: link.review.id, categorySlug: link.review.categorySlug, sessionId: sid, path: `/review/${link.review.slug}`, metadata: { offerId: offer.id, affiliated } });
  }
  const res = NextResponse.redirect(target.url.toString(), 302);
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("X-Robots-Tag", "noindex, nofollow");
  res.headers.set("Referrer-Policy", "no-referrer-when-downgrade");
  return res;
}
