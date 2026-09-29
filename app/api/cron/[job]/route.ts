import { NextResponse } from "next/server";
import { LockHeldError } from "@/lib/jobs/lock";
import { isJobName, runJob, type JobName } from "@/lib/jobs/registry";
import { log } from "@/lib/log";
import { cronAuthorized } from "@/lib/security/request";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Backwards-compatible aliases for the previous cron paths.
const ALIASES: Record<string, JobName[]> = { revalidate: ["revalidate-offers", "verify-links"] };

/** Vercel Cron entry point. Requires `Authorization: Bearer <CRON_SECRET>` (sent by Vercel automatically). */
export async function GET(req: Request, { params }: { params: Promise<{ job: string }> }) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { job } = await params;
  const jobs = ALIASES[job] ?? (isJobName(job) ? [job] : null);
  if (!jobs) return NextResponse.json({ error: `Unknown job "${job}"` }, { status: 404 });
  const results: Record<string, unknown> = {};
  try {
    for (const j of jobs) results[j] = await runJob(j, "cron");
    return NextResponse.json({ ok: true, results }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof LockHeldError) return NextResponse.json({ ok: false, error: error.message, results }, { status: 409 });
    log.error("cron job failed", { job, error });
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error), results }, { status: 500 });
  }
}
