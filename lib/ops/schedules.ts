import { db } from "@/lib/db";
import { getSwitches, SWITCHES, type SwitchKey } from "@/lib/automation/settings";
import { JOB_SWITCHES, JOBS } from "@/lib/jobs/registry";
import { describeCron, nextRun, parseCron, previousRun, scheduledEntries, type ScheduledEntry } from "./cron-schedule";

/**
 * Read model for Admin → Schedules: every job's schedules, last/next run, success rate and
 * failures, all from stored execution records (JobRun, written by runJob). Nothing is estimated:
 * a job without records says so.
 */

export type ScheduleInfo = ScheduledEntry & { english: string; next: Date | null; previous: Date | null };

export type JobRunView = { id: string; status: string; outcome: string | null; reason: string | null; error: string | null; trigger: string; startedAt: Date; finishedAt: Date | null; durationMs: number | null };

export type RateView = { succeeded: number; failed: number; other: number; rate: number | null };

export type ScheduleRow = {
  job: string;
  registered: boolean;
  schedules: ScheduleInfo[];
  next: Date | null;
  nextVia: ScheduleInfo | null;
  lastRun: JobRunView | null;
  /** Last run from the audit log, only when no JobRun exists yet (runs before run recording). */
  lastAudit: { at: Date; actor: string; status: string } | null;
  last30: RateView;
  last7d: RateView;
  failures7d: number;
  lastFailure: JobRunView | null;
  lock: { state: "free" } | { state: "held" | "stale"; until: Date };
  switches: Array<{ key: SwitchKey; label: string; on: boolean }>;
  paused: boolean;
};

function rate(runs: Array<{ status: string }>): RateView {
  const succeeded = runs.filter((r) => r.status === "SUCCEEDED").length;
  const failed = runs.filter((r) => r.status === "FAILED").length;
  return { succeeded, failed, other: runs.length - succeeded - failed, rate: succeeded + failed ? succeeded / (succeeded + failed) : null };
}

const runSelect = { id: true, status: true, outcome: true, reason: true, error: true, trigger: true, startedAt: true, finishedAt: true, durationMs: true } as const;

export async function loadScheduleRows(now = new Date()): Promise<ScheduleRow[]> {
  const entries = scheduledEntries();
  const registered = Object.keys(JOBS);
  const names = [...new Set([...entries.map((e) => e.job), ...registered])];
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const [locks, switches, auditLast] = await Promise.all([
    db.jobLock.findMany(),
    getSwitches(),
    db.auditLog.findMany({ where: { entityType: "job", action: { startsWith: "job.run." } }, orderBy: { createdAt: "desc" }, distinct: ["entityId"], select: { entityId: true, actor: true, createdAt: true, metadata: true } }),
  ]);
  return Promise.all(
    names.map(async (job): Promise<ScheduleRow> => {
      const [last30, week, lastFailure] = await Promise.all([
        db.jobRun.findMany({ where: { job }, orderBy: { startedAt: "desc" }, take: 30, select: runSelect }),
        db.jobRun.findMany({ where: { job, startedAt: { gte: weekAgo } }, select: { status: true } }),
        db.jobRun.findFirst({ where: { job, status: "FAILED" }, orderBy: { startedAt: "desc" }, select: runSelect }),
      ]);
      const schedules = entries
        .filter((e) => e.job === job)
        .map((e) => {
          const c = parseCron(e.cron);
          return { ...e, english: describeCron(c), next: nextRun(c, now), previous: previousRun(c, now) };
        });
      const nextVia = schedules.reduce<ScheduleInfo | null>((best, s) => (s.next && (!best?.next || s.next < best.next) ? s : best), null);
      const lockRow = locks.find((l) => l.name === (job === "ingest" ? "ingestion" : `job:${job}`));
      const keys = ["automation", ...(JOB_SWITCHES[job] ?? [])] as SwitchKey[];
      const sw = keys.map((key) => ({ key, label: SWITCHES[key].label, on: switches[key] }));
      const audit = last30.length ? undefined : auditLast.find((a) => a.entityId === job);
      const auditStatus = audit ? (((audit.metadata ?? {}) as { status?: unknown }).status as string | undefined) : undefined;
      return {
        job,
        registered: registered.includes(job),
        schedules,
        next: nextVia?.next ?? null,
        nextVia,
        lastRun: last30[0] ?? null,
        lastAudit: audit ? { at: audit.createdAt, actor: audit.actor, status: typeof auditStatus === "string" ? auditStatus : "OK" } : null,
        last30: rate(last30),
        last7d: rate(week),
        failures7d: week.filter((r) => r.status === "FAILED").length,
        lastFailure,
        lock: lockRow ? { state: lockRow.expiresAt > now ? "held" : "stale", until: lockRow.expiresAt } : { state: "free" },
        switches: sw,
        paused: sw.some((s) => !s.on),
      };
    }),
  );
}

// ── Recent failures across every execution record ────────────────────────────

export type FailureView = { origin: string; job: string; subject: string | null; error: string; at: Date; retries: number | null; status: string; href?: string };

const COMMERCE_RUN_FAILED = ["FAILED", "ABORTED", "TIMED-OUT", "COLLECT_FAILED", "START_FAILED"];
const APIFY_RUN_FAILED = ["FAILED", "ABORTED", "TIMED-OUT", "COLLECT_FAILED"];

function firstError(errors: unknown): string | null {
  if (!Array.isArray(errors) || !errors.length) return null;
  const e = errors[0] as { code?: unknown; reason?: unknown; url?: unknown };
  const parts = [e.code, e.reason, e.url].filter((p) => typeof p === "string" && p);
  return parts.length ? parts.join(": ") : JSON.stringify(errors[0]).slice(0, 300);
}

export async function loadRecentFailures(limit = 60): Promise<FailureView[]> {
  const [jobRuns, pipeline, commerce, slots, apify] = await Promise.all([
    db.jobRun.findMany({ where: { status: "FAILED" }, orderBy: { startedAt: "desc" }, take: limit }),
    db.pipelineFailure.findMany({ where: { resolvedAt: null }, orderBy: { lastOccurredAt: "desc" }, take: limit }),
    db.commerceRun.findMany({ where: { status: { in: COMMERCE_RUN_FAILED } }, orderBy: { startedAt: "desc" }, take: limit, include: { brand: { select: { name: true, consecutiveFailures: true } }, source: { select: { name: true, consecutiveFailures: true } } } }),
    db.automationSlot.findMany({ where: { status: { in: ["BLOCKED", "RETRYING"] } }, orderBy: { updatedAt: "desc" }, take: limit }),
    db.apifyRun.findMany({ where: { status: { in: APIFY_RUN_FAILED } }, orderBy: { startedAt: "desc" }, take: limit, include: { source: { select: { name: true } } } }),
  ]);
  const queueIds = slots.map((s) => s.queueItemId).filter((id): id is string => Boolean(id));
  const queue = queueIds.length ? await db.contentQueueItem.findMany({ where: { id: { in: queueIds } }, select: { id: true, keyword: true } }) : [];
  const out: FailureView[] = [
    ...jobRuns.map((r) => ({ origin: "Job run", job: r.job, subject: `trigger ${r.trigger}`, error: r.error ?? r.reason ?? r.outcome ?? "FAILED (no message recorded)", at: r.startedAt, retries: null, status: r.outcome ? `FAILED (${r.outcome})` : "FAILED" })),
    ...pipeline.map((f) => ({ origin: "Pipeline failure", job: f.stage, subject: `${f.entityType} ${f.entityId}`, error: `${f.errorCode}: ${f.message}`, at: f.lastOccurredAt, retries: f.retryCount, status: f.kind, href: f.normalizedReviewId ? `/admin/reviews/${f.normalizedReviewId}` : "/admin/failures" })),
    ...commerce.map((r) => ({
      origin: "Commerce run",
      job: r.actorId.startsWith("feedico:") ? "feedico-coupons" : r.purpose === "COUPON" ? "commerce-coupons" : "commerce-discover / commerce-collect",
      subject: r.brand ? `brand ${r.brand.name}` : r.source ? `source ${r.source.name}` : null,
      error: firstError(r.errors) ?? r.status,
      at: r.finishedAt ?? r.startedAt,
      retries: r.brand?.consecutiveFailures ?? r.source?.consecutiveFailures ?? null,
      status: r.status,
      href: "/admin/commerce",
    })),
    ...slots.map((s) => ({ origin: "Daily article slot", job: "daily-article", subject: `${s.day} ${s.slot}${s.queueItemId ? ` · keyword "${queue.find((q) => q.id === s.queueItemId)?.keyword ?? s.queueItemId}"` : ""}`, error: s.lastError ?? s.status, at: s.lastAttemptAt ?? s.updatedAt, retries: s.attempts, status: s.status, href: "/admin/automation" })),
    ...apify.map((r) => ({ origin: "Apify run", job: "scrape-sources / collect-scrapes", subject: `source ${r.source.name}`, error: r.error ?? r.status, at: r.finishedAt ?? r.startedAt, retries: null, status: r.status, href: "/admin/sources" })),
  ];
  return out.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}
