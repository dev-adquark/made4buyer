import { adminAction, field } from "@/lib/admin/route";
import { nextSlotAfter, scheduleLabel, setWeeklySchedule } from "@/lib/commerce/weekly-refresh";
import { LockHeldError } from "@/lib/jobs/lock";
import { jobOutcome, runJob } from "@/lib/jobs/registry";
import { audit } from "@/lib/security/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const JOB = "deals-weekly-refresh" as const;

/** Admin → Commerce → Weekly deals refresh: set the weekly slot, or run (continue) a sweep now. Audited. */
export const POST = adminAction("/admin/commerce", async ({ form, ctx }) => {
  const action = field(form, "action");
  if (action === "set-schedule") {
    const r = await setWeeklySchedule({ weekday: field(form, "weekday"), hourUtc: field(form, "hourUtc") }, ctx);
    if (!r.ok) return { error: r.error };
    const same = r.before.weekday === r.after.weekday && r.before.hourUtc === r.after.hourUtc;
    return { ok: `Weekly deals refresh ${same ? "stays" : "now runs"} every ${scheduleLabel(r.after)}; next slot ${nextSlotAfter(new Date(), r.after).toISOString().slice(0, 16).replace("T", " ")} UTC.` };
  }
  if (action === "run-now") {
    try {
      const result = await runJob(JOB, `admin:${ctx.actor}`);
      await audit(ctx, { action: `job.run.${JOB}`, entityType: "job", entityId: JOB, metadata: result });
      const outcome = jobOutcome(result);
      if (!outcome.ran) return { error: `Weekly deals refresh did not run: ${outcome.status}${outcome.reason ? `: ${outcome.reason}` : ""}`, json: { ok: false, result } };
      return { ok: `Weekly deals refresh ${outcome.status === "COMPLETED" ? "completed" : "is in progress (it continues on the next invocations)"}: ${outcome.reason ?? ""}`.trim(), json: { ok: true, result } };
    } catch (error) {
      if (error instanceof LockHeldError) return { error: "A weekly deals refresh invocation is already running; it continues on its own." };
      throw error;
    }
  }
  return { error: `Unknown action "${action}"` };
});
