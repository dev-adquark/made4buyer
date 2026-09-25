import crypto from "node:crypto";
import { cookies } from "next/headers";
import { config } from "@/lib/config";
import { db } from "@/lib/db";

/**
 * Admin sessions: an opaque random session id stored server-side (admin_sessions) with a
 * hard expiry, sent to the browser as `<id>.<hmac>` in an HttpOnly, SameSite=Strict cookie
 * (Secure + __Host- prefix in production). Logout revokes the row, so a stolen cookie
 * stops working immediately.
 */

export const ADMIN_COOKIE = process.env.NODE_ENV === "production" ? "__Host-m4b_admin" : "m4b_admin";

function secret(): string {
  const value = config.admin.sessionSecret();
  if (value && (value.length >= 32 || process.env.NODE_ENV !== "production")) return value;
  if (process.env.NODE_ENV === "production") throw new Error("ADMIN_SESSION_SECRET must be configured with at least 32 characters");
  return "development-only-session-secret-not-for-production";
}

function sign(value: string): string {
  return crypto.createHmac("sha256", secret()).update(value).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Constant-time credential check. Fails closed when admin credentials are not configured. */
export function validCredentials(email: string, password: string): boolean {
  const expectedEmail = config.admin.email();
  const expectedPassword = config.admin.password();
  if (!expectedEmail || !expectedPassword) return false;
  const emailOk = safeEqual(email.trim().toLowerCase(), expectedEmail.toLowerCase());
  const passwordOk = safeEqual(password, expectedPassword);
  return emailOk && passwordOk;
}

export function sessionMaxAgeSeconds(): number {
  return config.admin.sessionHours() * 3600;
}

export async function createSession(email: string): Promise<{ token: string; expiresAt: Date }> {
  const id = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionMaxAgeSeconds() * 1000);
  await db.adminSession.create({ data: { id, email, expiresAt } });
  return { token: `${id}.${sign(id)}`, expiresAt };
}

function parseToken(token: string | undefined): string | null {
  if (!token) return null;
  const [id, mac, extra] = token.split(".");
  if (!id || !mac || extra !== undefined) return null;
  return safeEqual(mac, sign(id)) ? id : null;
}

export type AdminSession = { email: string; sessionId: string };

export async function getAdminSession(): Promise<AdminSession | null> {
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  const id = parseToken(token);
  if (!id) return null;
  const row = await db.adminSession.findUnique({ where: { id } });
  if (!row || row.revokedAt || row.expiresAt <= new Date()) return null;
  // Credentials rotated since login → the session is no longer valid.
  if (row.email.toLowerCase() !== (config.admin.email() ?? "").toLowerCase()) return null;
  if (Date.now() - row.lastSeenAt.getTime() > 5 * 60_000) {
    await db.adminSession.update({ where: { id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  }
  return { email: row.email, sessionId: id };
}

export async function isAdmin(): Promise<boolean> {
  return Boolean(await getAdminSession());
}

export async function revokeSession(token: string | undefined): Promise<void> {
  const id = parseToken(token);
  if (id) await db.adminSession.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } });
}

export function cookieOptions(maxAge: number) {
  return { httpOnly: true, sameSite: "strict" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge };
}
