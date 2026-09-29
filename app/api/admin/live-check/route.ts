import { adminAction, field } from "@/lib/admin/route";
import { withLock } from "@/lib/jobs/lock";
import { runLiveCheck } from "@/lib/ops/live-check";
import { memoryRateLimit } from "@/lib/security/rate-limit";
import { audit } from "@/lib/security/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Runs the read-only integration preflight with the deployment's own credentials. */
export const POST = adminAction("/admin/go-live", async ({ form, admin, ctx }) => {
  if (!memoryRateLimit(`live-check:${admin.email}`, 10, 3_600_000)) return { error: "Too many checks this hour. Try again later." };
  const product = field(form, "product").slice(0, 120) || undefined;
  const brand = field(form, "brand").slice(0, 60) || undefined;
  const report = await withLock("live-check", 3 * 60_000, () => runLiveCheck({ product, brand }));
  // The report holds statuses and counts only (no secret values), so it is kept in the audit log.
  await audit(ctx, { action: "integrations.live_check", entityType: "site", entityId: "integrations", metadata: report });
  const failed = report.results.filter((r) => !["OK", "BLOCKED_BY_ENVIRONMENT", "EMPTY"].includes(r.status));
  return failed.length ? { error: `Checks finished: ${failed.map((f) => `${f.integration} ${f.status}`).join(", ")}`, json: report } : { ok: "Checks finished. No configured integration failed.", json: report };
});
