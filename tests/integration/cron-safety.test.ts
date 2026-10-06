import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/cron/[job]/route";
import { db } from "@/lib/db";
import { acquireLock, releaseLock } from "@/lib/jobs/lock";
import { JOBS, runJob } from "@/lib/jobs/registry";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

/**
 * Cron endpoint safety: fails closed without CRON_SECRET, rejects wrong secrets without running
 * anything, refuses overlapping runs via the DB lock, and every execution leaves one JobRun row.
 */

const SECRET = "test-cron-secret-0123456789";
let restore: () => void;

beforeAll(async () => {
  await seedTaxonomy();
});
beforeEach(async () => {
  await resetDb();
  restore = withEnv({ CRON_SECRET: SECRET, AUTOMATION_ENABLED: undefined });
});
afterEach(() => {
  restore();
  vi.restoreAllMocks();
});

const call = (job: string, auth?: string) => GET(new Request(`http://localhost/api/cron/${job}`, { headers: auth ? { authorization: auth } : {} }), { params: Promise.resolve({ job }) });

async function nothingRan() {
  expect(await db.jobRun.count()).toBe(0);
  expect(await db.auditLog.count({ where: { entityType: "job" } })).toBe(0);
}

describe("cron authentication", () => {
  it("fails closed when CRON_SECRET is not configured, even with a bearer token", async () => {
    restore();
    restore = withEnv({ CRON_SECRET: undefined });
    const spy = vi.spyOn(JOBS["cleanup-cache"], "run");
    expect((await call("cleanup-cache")).status).toBe(401);
    expect((await call("cleanup-cache", "Bearer ")).status).toBe(401);
    expect((await call("cleanup-cache", "Bearer undefined")).status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    await nothingRan();
  });

  it("rejects missing, wrong and near-miss secrets without running the job", async () => {
    const spy = vi.spyOn(JOBS["cleanup-cache"], "run");
    for (const auth of [undefined, `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(0, -1)}X`, SECRET, `bearer ${SECRET}`, `Basic ${SECRET}`]) {
      expect((await call("cleanup-cache", auth)).status, String(auth)).toBe(401);
    }
    // Unknown jobs are checked only after authentication.
    expect((await call("no-such-job", "Bearer wrong")).status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    await nothingRan();
  });

  it("runs with the right secret and records the run", async () => {
    const res = await call("cleanup-cache", `Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ran: true });
    const runs = await db.jobRun.findMany();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ job: "cleanup-cache", trigger: "cron", status: "SUCCEEDED" });
    expect(runs[0].finishedAt).not.toBeNull();
    expect(runs[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(await db.auditLog.count({ where: { action: "job.run.cleanup-cache" } })).toBe(1);
    expect((await call("no-such-job", `Bearer ${SECRET}`)).status).toBe(404);
  });
});

describe("overlap protection", () => {
  it("returns 409 while the job's lock is held and does not run the job", async () => {
    const spy = vi.spyOn(JOBS["cleanup-cache"], "run");
    const owner = await acquireLock("job:cleanup-cache", 60_000);
    const res = await call("cleanup-cache", `Bearer ${SECRET}`);
    expect(res.status).toBe(409);
    expect(spy).not.toHaveBeenCalled();
    expect(await db.jobRun.findMany({ select: { status: true } })).toEqual([{ status: "LOCK_HELD" }]);
    await releaseLock("job:cleanup-cache", owner!);
    expect((await call("cleanup-cache", `Bearer ${SECRET}`)).status).toBe(200);
  });

  it("two concurrent invocations never both run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let active = 0;
    let maxActive = 0;
    vi.spyOn(JOBS["cleanup-cache"], "run").mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await gate;
      active--;
      return { status: "OK" } as never;
    });
    const first = runJob("cleanup-cache", "test");
    // Wait until the first holds the lock.
    for (let i = 0; i < 50 && !(await db.jobLock.findUnique({ where: { name: "job:cleanup-cache" } })); i++) await new Promise((r) => setTimeout(r, 20));
    await expect(runJob("cleanup-cache", "test")).rejects.toThrow(/already running/);
    release();
    await first;
    expect(maxActive).toBe(1);
    const statuses = (await db.jobRun.findMany({ orderBy: { startedAt: "asc" }, select: { status: true } })).map((r) => r.status).sort();
    expect(statuses).toEqual(["LOCK_HELD", "SUCCEEDED"]);
  });
});

describe("run records", () => {
  it("records a failure with a redacted, truncated error and returns 500", async () => {
    vi.spyOn(JOBS["cleanup-cache"], "run").mockRejectedValue(new Error(`boom with ${"x".repeat(800)}`));
    const res = await call("cleanup-cache", `Bearer ${SECRET}`);
    expect(res.status).toBe(500);
    const run = await db.jobRun.findFirstOrThrow();
    expect(run.status).toBe("FAILED");
    expect(run.error).toMatch(/^Error: boom/);
    expect(run.error!.length).toBeLessThanOrEqual(500);
    expect(await db.jobLock.count()).toBe(0);
  });

  it("records a paused run when the master switch is off", async () => {
    await db.automationSetting.create({ data: { key: "automation", value: "off" } });
    const spy = vi.spyOn(JOBS["cleanup-cache"], "run");
    const res = await call("cleanup-cache", `Bearer ${SECRET}`);
    expect(await res.json()).toMatchObject({ ok: true, ran: false });
    expect(spy).not.toHaveBeenCalled();
    expect(await db.jobRun.findFirstOrThrow()).toMatchObject({ status: "PAUSED", outcome: "PAUSED" });
  });
});

describe("schedules read model", () => {
  it("shows recorded runs, next runs and 'no runs' honestly", async () => {
    const { loadScheduleRows } = await import("@/lib/ops/schedules");
    expect((await call("cleanup-cache", `Bearer ${SECRET}`)).status).toBe(200);
    vi.spyOn(JOBS["cleanup-cache"], "run").mockRejectedValueOnce(new Error("disk full"));
    expect((await call("cleanup-cache", `Bearer ${SECRET}`)).status).toBe(500);
    const now = new Date();
    const rows = await loadScheduleRows(now);
    const cleanup = rows.find((r) => r.job === "cleanup-cache")!;
    expect(cleanup.schedules.map((s) => s.cron)).toEqual(["0 3 * * *"]);
    expect(cleanup.next!.getTime()).toBeGreaterThan(now.getTime());
    expect(cleanup.lastRun).toMatchObject({ status: "FAILED" });
    expect(cleanup.last30).toEqual({ succeeded: 1, failed: 1, other: 0, rate: 0.5 });
    expect(cleanup.failures7d).toBe(1);
    expect(cleanup.lastFailure?.error).toContain("disk full");
    expect(cleanup.lock).toEqual({ state: "free" });
    const daily = rows.find((r) => r.job === "daily-article")!;
    expect(daily.schedules.map((s) => s.origin)).toEqual(["vercel", "vercel", "github-actions"]);
    expect(daily.lastRun).toBeNull();
    expect(daily.lastAudit).toBeNull();
    expect(daily.last30.rate).toBeNull();
    const audit = rows.find((r) => r.job === "data-audit")!;
    expect(audit.registered).toBe(true);
    expect(audit.switches.map((s) => s.key)).toEqual(["automation"]);
  });

  it("lists recent failures from every execution record", async () => {
    const { loadRecentFailures } = await import("@/lib/ops/schedules");
    const t = (h: number) => new Date(Date.now() - h * 3_600_000);
    await db.jobRun.create({ data: { job: "publish-cycle", trigger: "cron", status: "FAILED", error: "Error: db down", startedAt: t(1), finishedAt: t(1), durationMs: 5 } });
    await db.pipelineFailure.create({ data: { fingerprint: "fp", stage: "PUBLISH", kind: "RETRYABLE_FAILURE", errorCode: "X", message: "nope", entityType: "normalized_review", entityId: "r1", retryCount: 2, lastOccurredAt: t(2) } });
    const brand = await db.commerceBrand.create({ data: { name: "Acme", slug: "acme", officialDomain: "acme.example.test", consecutiveFailures: 3 } });
    await db.commerceRun.create({ data: { purpose: "PRODUCT", brandId: brand.id, actorId: "a", trigger: "cron", status: "TIMED-OUT", errors: [{ code: "TIMEOUT", reason: "actor timed out" }], startedAt: t(3) } });
    await db.commerceRun.create({ data: { purpose: "PRODUCT", brandId: brand.id, actorId: "a", trigger: "cron", status: "COLLECTED", startedAt: t(3) } });
    const q = await db.contentQueueItem.create({ data: { key: "k", topic: "Best mice", keyword: "best mice", kind: "GUIDE", categorySlug: "computing" } });
    await db.automationSlot.create({ data: { day: "2026-10-07", slot: "MORNING", status: "BLOCKED", attempts: 3, queueItemId: q.id, lastError: "QA failed", lastAttemptAt: t(4) } });
    const source = await db.reviewSource.create({ data: { slug: "src", name: "Example Reviews", homepageUrl: "https://reviews.example.test" } });
    await db.apifyRun.create({ data: { sourceId: source.id, apifyRunId: "run-1", status: "ABORTED", trigger: "cron", error: "aborted", startedAt: t(5) } });
    const rows = await loadRecentFailures();
    expect(rows.map((r) => r.origin).slice(0, 4)).toEqual(["Job run", "Pipeline failure", "Commerce run", "Daily article slot"]);
    expect(rows.find((r) => r.origin === "Commerce run")).toMatchObject({ subject: "brand Acme", retries: 3, status: "TIMED-OUT", error: "TIMEOUT: actor timed out" });
    expect(rows.find((r) => r.origin === "Daily article slot")?.subject).toContain('keyword "best mice"');
    expect(rows.filter((r) => r.origin === "Commerce run")).toHaveLength(1);
    expect(rows.find((r) => r.origin === "Apify run")).toMatchObject({ subject: "source Example Reviews", status: "ABORTED", error: "aborted" });
  });
});
