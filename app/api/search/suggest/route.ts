import { NextResponse } from "next/server";
import { suggest } from "@/lib/public/queries";
import { memoryRateLimit } from "@/lib/security/rate-limit";
import { clientIp } from "@/lib/security/request";

export const dynamic = "force-dynamic";

/** Instant search suggestions from published reviews only. */
export async function GET(req: Request) {
  if (!memoryRateLimit(`suggest:${clientIp(req) ?? "unknown"}`, 120, 60_000)) return NextResponse.json({ suggestions: [], error: "rate_limited" }, { status: 429 });
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 80);
  if (q.length < 2) return NextResponse.json({ suggestions: [] });
  try {
    return NextResponse.json({ suggestions: await suggest(q) }, { headers: { "Cache-Control": "public, max-age=30, s-maxage=60" } });
  } catch {
    return NextResponse.json({ suggestions: [], error: "unavailable" }, { status: 503 });
  }
}
