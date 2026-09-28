import { NextResponse } from "next/server";
import { navFeed } from "@/lib/public/queries";
import { memoryRateLimit } from "@/lib/security/rate-limit";
import { clientIp } from "@/lib/security/request";
import { CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";

export const dynamic = "force-dynamic";

/** Mega-menu data for one category (published reviews, guides and verified offers only). */
export async function GET(req: Request, { params }: { params: Promise<{ category: string }> }) {
  const { category } = await params;
  if (!CATEGORY_BY_SLUG.has(category)) return NextResponse.json({ error: "unknown_category" }, { status: 404 });
  if (!memoryRateLimit(`nav:${clientIp(req) ?? "unknown"}`, 120, 60_000)) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  try {
    return NextResponse.json(await navFeed(category), { headers: { "Cache-Control": "public, max-age=60, s-maxage=120" } });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
