import { NextResponse } from "next/server";
import { searchGroups, suggest } from "@/lib/public/queries";
import { memoryRateLimit } from "@/lib/security/rate-limit";
import { clientIp } from "@/lib/security/request";

export const dynamic = "force-dynamic";

/**
 * Instant search from published content only. `suggestions` is the flat review list (used by
 * inline search fields); `groups=1` adds reviews/guides/deals/categories/brands for the palette.
 */
export async function GET(req: Request) {
  if (!memoryRateLimit(`suggest:${clientIp(req) ?? "unknown"}`, 120, 60_000)) return NextResponse.json({ suggestions: [], error: "rate_limited" }, { status: 429 });
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
  if (q.length < 2) return NextResponse.json({ suggestions: [] });
  try {
    const headers = { "Cache-Control": "public, max-age=30, s-maxage=60" };
    if (url.searchParams.get("groups") === "1") return NextResponse.json({ groups: await searchGroups(q) }, { headers });
    return NextResponse.json({ suggestions: await suggest(q) }, { headers });
  } catch {
    return NextResponse.json({ suggestions: [], error: "unavailable" }, { status: 503 });
  }
}
