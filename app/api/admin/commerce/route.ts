import { adminAction, field } from "@/lib/admin/route";
import { retryFailed, setCommerceEngine } from "@/lib/commerce/admin-actions";

export const dynamic = "force-dynamic";

/** Admin → Commerce engine: pause, resume, or re-queue failed brands and runs (all audited). */
export const POST = adminAction("/admin/commerce", async ({ form, ctx }) => {
  const action = field(form, "action");
  if (action === "pause" || action === "resume") {
    const { before, after } = await setCommerceEngine(action === "resume", ctx);
    return { ok: before === after ? `Commerce engine was already ${after ? "running" : "paused"}.` : `Commerce engine ${after ? "resumed" : "paused"}.` };
  }
  if (action === "retry-failed") {
    const r = await retryFailed(ctx);
    const skippedNote = r.skipped.brands || r.skipped.runs ? ` ${r.skipped.brands} brand${r.skipped.brands === 1 ? "" : "s"} and ${r.skipped.runs} run${r.skipped.runs === 1 ? "" : "s"} left alone: their last error won't change on a retry (e.g. an Apify account/permission block) — fix that first, then retry.` : "";
    if (!r.brands && !r.runs) return { ok: `Nothing retryable.${skippedNote || " No failed brands or runs."}` };
    return { ok: `Re-queued ${r.brands} brand${r.brands === 1 ? "" : "s"} (due now, failure count reset) and marked ${r.runs} failed run${r.runs === 1 ? "" : "s"} RETRY_QUEUED.${skippedNote}` };
  }
  return { error: `Unknown action "${action}"` };
});
