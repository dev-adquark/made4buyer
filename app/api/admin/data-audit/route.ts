import { adminAction } from "@/lib/admin/route";
import { LockHeldError } from "@/lib/jobs/lock";
import { runJob } from "@/lib/jobs/registry";
import type { DataAuditResult } from "@/lib/ops/data-audit";
import { audit } from "@/lib/security/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** "Run audit now": same code path, lock and run record as the scheduled data-audit job. */
export const POST = adminAction("/admin/data-audit", async ({ ctx }) => {
  try {
    const result = (await runJob("data-audit", `admin:${ctx.actor}`)) as DataAuditResult;
    await audit(ctx, { action: "job.run.data-audit", entityType: "job", entityId: "data-audit", metadata: { counts: result.counts, fixed: result.fixed, totalFlagged: result.totalFlagged } });
    return {
      ok: `Audit finished: ${result.totalFlagged} flagged; fixed ${result.fixed.offersMarkedStale} stale offer(s) and ${result.fixed.couponsMarkedExpired} expired coupon(s).`,
      json: { ok: true, result },
    };
  } catch (error) {
    if (error instanceof LockHeldError) return { error: "A data audit is already running." };
    throw error;
  }
});
