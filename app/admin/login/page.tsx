import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { integrationStatus } from "@/lib/config";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Admin sign in", robots: { index: false, follow: false } };

const ERRORS: Record<string, string> = {
  invalid: "Invalid email or password.",
  rate: "Too many sign-in attempts. Wait 15 minutes and try again.",
  config: "Admin credentials are not configured on the server (ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_SESSION_SECRET).",
  origin: "Sign-in request was rejected (cross-origin).",
};

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await isAdmin()) redirect("/admin");
  const { error } = await searchParams;
  const configured = integrationStatus().admin === "READY";
  return (
    <main className="section">
      <div className="container" style={{ maxWidth: 440 }}>
        <div className="card card-body">
          <h1 style={{ fontSize: 28 }}>Admin sign in</h1>
          {error && (
            <p className="notice error" role="alert">
              {ERRORS[error] ?? "Sign-in failed."}
            </p>
          )}
          {!configured && <p className="notice warn">Admin access is BLOCKED_BY_ENVIRONMENT until ADMIN_EMAIL, ADMIN_PASSWORD and ADMIN_SESSION_SECRET are set.</p>}
          <form action="/api/admin/login" method="post">
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" name="email" type="email" autoComplete="username" required />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input id="password" name="password" type="password" autoComplete="current-password" required />
            </div>
            <button className="btn primary" type="submit" disabled={!configured}>
              Sign in
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
