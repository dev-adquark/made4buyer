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
    if (!r.brands && !r.runs) return { ok: "Nothing to retry: no failed brands or runs." };
    return { ok: `Re-queued ${r.brands} brand${r.brands === 1 ? "" : "s"} (due now, failure count reset) and marked ${r.runs} failed run${r.runs === 1 ? "" : "s"} RETRY_QUEUED.` };
  }
  return { error: `Unknown action "${action}"` };
});
