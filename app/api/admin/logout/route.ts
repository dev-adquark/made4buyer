import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, cookieOptions, revokeSession } from "@/lib/auth";
import { isSameOrigin } from "@/lib/security/request";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  await revokeSession((await cookies()).get(ADMIN_COOKIE)?.value);
  const res = NextResponse.redirect(new URL("/admin/login", req.url), 303);
  res.cookies.set(ADMIN_COOKIE, "", cookieOptions(0));
  return res;
}
