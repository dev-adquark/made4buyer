import { db } from "@/lib/db";
import { log, redactString } from "@/lib/log";

/**
 * Uniform execution record for scheduled jobs: runJob writes one JobRun row per execution
 * (cron, GitHub Actions, Admin "Run now"), whatever the job does internally. Recording never
 * breaks a job: a failed write is logged and the job carries on.
 */

export type JobRunStatus = "RUNNING" | "SUCCEEDED" | "SKIPPED" | "PAUSED" | "FAILED" | "LOCK_HELD";

/** Job result statuses that mean the job tried and failed (as opposed to having nothing to do). */
const FAILED_OUTCOMES = new Set(["FAILED", "AUTH_FAILED", "BLOCKED", "RETRYING", "REJECTED"]);

/** Maps a job's own outcome (see jobOutcome in the registry) to a run status. */
export function runStatusFor(outcome: { ran: boolean; status: string }): Exclude<JobRunStatus, "RUNNING"> {
  if (outcome.ran) return "SUCCEEDED";
  if (outcome.status === "PAUSED") return "PAUSED";
  if (FAILED_OUTCOMES.has(outcome.status)) return "FAILED";
  return "SKIPPED";
}

export function errorSummary(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactString(message).slice(0, 500);
}

export type RunHandle = { id: string | null; job: string; trigger: string; startedAt: Date };

export async function startJobRun(job: string, trigger: string): Promise<RunHandle> {
  const startedAt = new Date();
  try {
    const row = await db.jobRun.create({ data: { job, trigger: trigger.slice(0, 200), status: "RUNNING", startedAt }, select: { id: true } });
    return { id: row.id, job, trigger, startedAt };
  } catch (error) {
    log.error("failed to record job run start", { job, error });
    return { id: null, job, trigger, startedAt };
  }
}

type Finish = { status: Exclude<JobRunStatus, "RUNNING">; outcome?: string; reason?: string; error?: string };

export async function finishJobRun(run: RunHandle, finish: Finish): Promise<void> {
  const finishedAt = new Date();
  const data = {
    status: finish.status,
    outcome: finish.outcome?.slice(0, 100) ?? null,
    reason: finish.reason ? redactString(finish.reason).slice(0, 500) : null,
    error: finish.error ?? null,
    finishedAt,
    durationMs: finishedAt.getTime() - run.startedAt.getTime(),
  };
  try {
    if (run.id) await db.jobRun.update({ where: { id: run.id }, data });
    else await db.jobRun.create({ data: { job: run.job, trigger: run.trigger.slice(0, 200), startedAt: run.startedAt, ...data } });
  } catch (error) {
    log.error("failed to record job run finish", { job: run.job, error });
  }
}

/** A run that finished immediately (e.g. paused by an admin switch). */
export async function recordJobRun(job: string, trigger: string, finish: Finish): Promise<void> {
  await finishJobRun({ id: null, job, trigger, startedAt: new Date() }, finish);
}
