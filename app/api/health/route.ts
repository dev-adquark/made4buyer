import { NextResponse } from "next/server";
import { integrationStatus, releaseInfo } from "@/lib/config";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Health check: app + database status, version/commit. Never exposes credentials or connection strings. */
export async function GET() {
  const release = releaseInfo();
  const timestamp = new Date().toISOString();
  const integrations = integrationStatus();
  let database: "ok" | "unavailable" = "ok";
  let latencyMs: number | undefined;
  try {
    const started = Date.now();
    await db.$queryRaw`SELECT 1`;
    latencyMs = Date.now() - started;
  } catch {
    database = "unavailable";
  }
  const body = {
    status: database === "ok" ? "ok" : "degraded",
    application: "ok",
    database,
    databaseLatencyMs: latencyMs,
    timestamp,
    version: release.version,
    commit: release.commit,
    environment: release.environment,
    integrations,
  };
  return NextResponse.json(body, { status: database === "ok" ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
