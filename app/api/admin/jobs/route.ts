import { adminAction, field } from "@/lib/admin/route";
import { isJobName, runJob } from "@/lib/jobs/registry";
import { LockHeldError } from "@/lib/jobs/lock";
import { audit } from "@/lib/security/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Manually trigger any scheduled job (same code path and lock as cron). */
export const POST = adminAction("/admin/jobs", async ({ form, ctx }) => {
  const job = field(form, "job");
  if (!isJobName(job)) return { error: `Unknown job "${job}"` };
  try {
    const result = await runJob(job, `admin:${ctx.actor}`);
    await audit(ctx, { action: `job.run.${job}`, entityType: "job", entityId: job, metadata: result });
    return { ok: `${job} finished: ${JSON.stringify(result).slice(0, 240)}`, json: { ok: true, job, result } };
  } catch (error) {
    if (error instanceof LockHeldError) return { error: error.message };
    throw error;
  }
});
