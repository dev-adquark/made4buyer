import { NextResponse } from "next/server";
import { recordEvent } from "@/lib/analytics/events";
import { db } from "@/lib/db";
import { validateOutboundUrl } from "@/lib/net/safe-fetch";
import { couponIsCurrent } from "@/lib/pipeline/render-model";
import { isProviderAffiliateUrl } from "@/lib/sovrn/offers";
import { memoryRateLimit } from "@/lib/security/rate-limit";
import { clientIp } from "@/lib/security/request";

export const dynamic = "force-dynamic";

/**
 * Coupon click redirect. Only redirects to the stored Sovrn affiliated URL of an active,
 * recently verified code on a PUBLISHED page — never to a URL supplied in the request.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const home = NextResponse.redirect(new URL("/", req.url), 302);
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return home;
  const c = await db.sovrnCoupon.findUnique({ where: { id }, include: { review: { select: { status: true, slug: true, categorySlug: true } } } });
  const current = c?.isActive && c.verified && c.verifiedAt && couponIsCurrent({ verifiedAt: c.verifiedAt.toISOString() });
  if (!c || !current || c.review.status !== "PUBLISHED" || !isProviderAffiliateUrl(c.affiliatedUrl)) {
    return NextResponse.redirect(new URL(c?.review.status === "PUBLISHED" ? `/review/${c.review.slug}` : "/", req.url), 302);
  }
  const target = validateOutboundUrl(c.affiliatedUrl, { standardPortsOnly: true });
  if (!target.url) return home;
  if (memoryRateLimit(`click:${clientIp(req) ?? "unknown"}`, 30, 60_000)) {
    await recordEvent({ event: "affiliate_click", normalizedReviewId: c.normalizedReviewId, categorySlug: c.review.categorySlug, path: `/review/${c.review.slug}`, metadata: { couponId: c.id } });
  }
  const res = NextResponse.redirect(target.url.toString(), 302);
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("X-Robots-Tag", "noindex, nofollow");
  return res;
}
