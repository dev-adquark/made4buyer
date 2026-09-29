import { adminAction, field, optionalDate } from "@/lib/admin/route";
import { runLinkVerification, runOfferRefresh } from "@/lib/jobs/revalidation";
import { withLock, LockHeldError } from "@/lib/jobs/lock";
import { audit } from "@/lib/security/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Revalidation by date range (reviews published — or created, if unpublished — within the range). */
export const POST = adminAction("/admin/links", async ({ form, ctx }) => {
  const type = field(form, "type") || "links";
  const start = optionalDate(field(form, "start"));
  const end = optionalDate(field(form, "end"));
  if (field(form, "start") && !start) return { error: "Invalid start date" };
  if (field(form, "end") && !end) return { error: "Invalid end date" };
  if (start && end && end < start) return { error: "End date must be after start date" };
  const endOfDay = end ? new Date(end.getTime() + (field(form, "end").length <= 10 ? 86_399_999 : 0)) : undefined;
  const range = { start, end: endOfDay };
  try {
    const result =
      type === "offers"
        ? await withLock("job:revalidate-offers", 20 * 60_000, () => runOfferRefresh({ trigger: "admin", ctx, range, limit: 100 }))
        : await withLock("job:verify-links", 20 * 60_000, () => runLinkVerification({ trigger: "admin", ctx, range, onlyDue: false, limit: 500 }));
    await audit(ctx, { action: `revalidate.${type}`, entityType: "revalidation_run", entityId: result.runId, metadata: { range, ...result } });
    return { ok: `Revalidation (${type}) checked ${result.checked}: ${result.success} ok, ${result.failure} failed — ${Object.entries(result.reasons).map(([k, v]) => `${k}: ${v}`).join(", ") || "no items"}` };
  } catch (error) {
    if (error instanceof LockHeldError) return { error: error.message };
    throw error;
  }
});
