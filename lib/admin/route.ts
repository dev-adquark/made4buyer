import { NextResponse } from "next/server";
import { getAdminSession, type AdminSession } from "@/lib/auth";
import { log } from "@/lib/log";
import type { AuditContext } from "@/lib/security/audit";
import { clientIp, isSameOrigin, safeReturnPath } from "@/lib/security/request";

/**
 * Wrapper for every admin mutation endpoint: same-origin (CSRF) check, session check,
 * body parsing, audit context, uniform error handling, and a 303 redirect back to the
 * originating admin page with a flash message (or JSON when the client asks for it).
 */

export type AdminActionContext = { req: Request; form: FormData; admin: AdminSession; ctx: AuditContext };
export type AdminActionResult = { ok?: string; error?: string; redirect?: string; json?: unknown; response?: Response };

export function wantsJson(req: Request): boolean {
  return (req.headers.get("accept") ?? "").includes("application/json");
}

function redirectWith(req: Request, path: string, params: Record<string, string | undefined>) {
  const url = new URL(path, req.url);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v.slice(0, 300));
  return NextResponse.redirect(url, 303);
}

export function adminAction(fallbackPath: string, handler: (a: AdminActionContext) => Promise<AdminActionResult>) {
  return async (req: Request) => {
    if (!isSameOrigin(req)) return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
    const admin = await getAdminSession();
    if (!admin) return wantsJson(req) ? NextResponse.json({ error: "Unauthorized" }, { status: 401 }) : NextResponse.redirect(new URL("/admin/login", req.url), 303);

    let form: FormData;
    try {
      const type = req.headers.get("content-type") ?? "";
      if (type.includes("application/json")) {
        const body = (await req.json()) as Record<string, unknown>;
        form = new FormData();
        for (const [k, v] of Object.entries(body ?? {})) if (v !== undefined && v !== null) form.set(k, String(v));
      } else form = await req.formData();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    const returnTo = safeReturnPath(form.get("returnTo"), fallbackPath);
    const ctx: AuditContext = { actor: admin.email, ip: clientIp(req), userAgent: req.headers.get("user-agent") };

    try {
      const result = await handler({ req, form, admin, ctx });
      if (result.response) return result.response;
      if (wantsJson(req)) return NextResponse.json(result.json ?? { ok: result.ok ?? true, error: result.error }, { status: result.error ? 422 : 200 });
      return redirectWith(req, result.redirect ?? returnTo, { ok: result.ok, error: result.error });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("admin action failed", { path: new URL(req.url).pathname, actor: admin.email, error: message });
      if (wantsJson(req)) return NextResponse.json({ error: message }, { status: 500 });
      return redirectWith(req, returnTo, { error: message });
    }
  };
}

export function field(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
}

export function optionalDate(value: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
