import { NextResponse } from "next/server";
import { releaseInfo } from "@/lib/config";
import { db } from "@/lib/db";
import { checkSchema } from "@/lib/ops/schema-check";

export const dynamic = "force-dynamic";

/** Health check: app + database status, version/commit. Never exposes credentials or connection strings. */
export async function GET() {
  const release = releaseInfo();
  const timestamp = new Date().toISOString();
  let database: "ok" | "unavailable" = "ok";
  let latencyMs: number | undefined;
  try {
    const started = Date.now();
    await db.$queryRaw`SELECT 1`;
    latencyMs = Date.now() - started;
  } catch {
    database = "unavailable";
  }
  // Whether the database has everything this build needs (names stay in the build log/admin).
  let schema: "ok" | "mismatch" | "unknown" = "unknown";
  if (database === "ok") schema = await checkSchema(db).then((r) => (r.ok ? "ok" : "mismatch")).catch(() => "unknown" as const);
  const body = {
    status: database === "ok" && schema === "ok" ? "ok" : "degraded",
    application: "ok",
    database,
    schema,
    databaseLatencyMs: latencyMs,
    timestamp,
    version: release.version,
    commit: release.commit,
    // Which integrations are configured is admin-only information (Admin → Go-live); not public.
  };
  return NextResponse.json(body, { status: database === "ok" ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
