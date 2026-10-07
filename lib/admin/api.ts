import { NextResponse } from "next/server";
import { getAdminSession, type AdminSession } from "@/lib/auth";
import { log, redactString } from "@/lib/log";
import type { AuditContext } from "@/lib/security/audit";
import { dbRateLimit } from "@/lib/security/rate-limit";
import { clientIp, isSameOrigin } from "@/lib/security/request";

/**
 * JSON admin API (/api/commerce/* admin endpoints). Every response is JSON with
 * Cache-Control: no-store. GETs need an admin session (401 JSON otherwise); POSTs additionally
 * need a same-origin request (403, CSRF), are rate-limited per admin, take a small JSON body and
 * never echo an error that could carry a secret (redactString).
 */

export const NO_STORE = { "Cache-Control": "no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow" } as const;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

export type AdminGetContext = { req: Request; url: URL; admin: AdminSession };

export function adminJsonGet(handler: (a: AdminGetContext) => Promise<unknown>) {
  return async (req: Request) => {
    const admin = await getAdminSession();
    if (!admin) return json({ error: "Unauthorized" }, 401);
    try {
      return json(await handler({ req, url: new URL(req.url), admin }));
    } catch (error) {
      const message = redactString((error instanceof Error ? error.message : String(error)).slice(0, 300));
      log.error("admin api failed", { path: new URL(req.url).pathname, error: message });
      return json({ error: "Internal error" }, 500);
    }
  };
}

export type AdminPostContext = { req: Request; body: Record<string, unknown>; admin: AdminSession; ctx: AuditContext };
export type AdminPostResult = { status?: number; body: unknown };

const MAX_BODY_BYTES = 4096;

/**
 * POST wrapper. `name` keys the rate limit (default 10 requests per minute per admin per endpoint);
 * the handler returns its own status (default 200).
 */
export function adminJsonPost(name: string, handler: (a: AdminPostContext) => Promise<AdminPostResult>, opts: { limit?: number; windowMs?: number } = {}) {
  return async (req: Request) => {
    if (!isSameOrigin(req)) return json({ error: "Cross-origin request rejected" }, 403);
    const admin = await getAdminSession();
    if (!admin) return json({ error: "Unauthorized" }, 401);

    const limit = await dbRateLimit(`admin-api:${name}:${admin.email.toLowerCase()}`, opts.limit ?? 10, opts.windowMs ?? 60_000);
    if (!limit.allowed) return json({ error: "Too many requests: try again in a minute" }, 429, { "Retry-After": "60" });

    let body: Record<string, unknown> = {};
    try {
      const text = await req.text();
      if (text.length > MAX_BODY_BYTES) return json({ error: "Request body too large" }, 413);
      if (text.trim()) {
        const type = req.headers.get("content-type") ?? "";
        if (!type.includes("application/json")) return json({ error: "Send a JSON body (Content-Type: application/json)" }, 415);
        const parsed = JSON.parse(text) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json({ error: "Body must be a JSON object" }, 400);
        body = parsed as Record<string, unknown>;
      }
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const ctx: AuditContext = { actor: admin.email, ip: clientIp(req), userAgent: req.headers.get("user-agent") };
    try {
      const r = await handler({ req, body, admin, ctx });
      return json(r.body, r.status ?? 200);
    } catch (error) {
      const message = redactString((error instanceof Error ? error.message : String(error)).slice(0, 500));
      log.error("admin api action failed", { path: new URL(req.url).pathname, actor: admin.email, error: message });
      return json({ error: message }, 500);
    }
  };
}
