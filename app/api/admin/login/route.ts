import { NextResponse } from "next/server";
import { ADMIN_COOKIE, cookieOptions, createSession, sessionMaxAgeSeconds, validCredentials } from "@/lib/auth";
import { integrationStatus } from "@/lib/config";
import { audit } from "@/lib/security/audit";
import { dbRateLimit } from "@/lib/security/rate-limit";
import { clientIp, isSameOrigin } from "@/lib/security/request";

export const dynamic = "force-dynamic";

const back = (req: Request, error: string) => NextResponse.redirect(new URL(`/admin/login?error=${error}`, req.url), 303);

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return back(req, "origin");
  if (integrationStatus().admin !== "READY") return back(req, "config");
  const ip = clientIp(req) ?? "unknown";
  const form = await req.formData().catch(() => null);
  const email = String(form?.get("email") ?? "").slice(0, 200);
  const password = String(form?.get("password") ?? "").slice(0, 500);
  const [byIp, byEmail] = await Promise.all([dbRateLimit(`login:ip:${ip}`, 10, 15 * 60_000), dbRateLimit(`login:email:${email.toLowerCase()}`, 5, 15 * 60_000)]);
  if (!byIp.allowed || !byEmail.allowed) return back(req, "rate");
  const ctx = { actor: email || "anonymous", ip, userAgent: req.headers.get("user-agent") };
  if (!validCredentials(email, password)) {
    await audit(ctx, { action: "admin.login_failed", entityType: "admin_session", entityId: "-" });
    return back(req, "invalid");
  }
  const { token } = await createSession(email.trim().toLowerCase());
  await audit(ctx, { action: "admin.login", entityType: "admin_session", entityId: "-" });
  const res = NextResponse.redirect(new URL("/admin", req.url), 303);
  res.cookies.set(ADMIN_COOKIE, token, cookieOptions(sessionMaxAgeSeconds()));
  return res;
}
