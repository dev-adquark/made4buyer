import { adminJsonPost } from "@/lib/admin/api";
import { isVerifyScope, runCommerceJob, VERIFY_JOBS } from "@/lib/commerce/admin-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/commerce/verify {scope: "links" | "official" | "coupons" | "deals"} — admin, same-origin,
 * rate-limited, audited. Runs commerce-validate-links / commerce-official-verify / commerce-collect /
 * commerce-classify-deals (503 until that job is registered).
 */
export const POST = adminJsonPost(
  "commerce-verify",
  async ({ body, ctx }) => {
    if (!isVerifyScope(body.scope)) return { status: 400, body: { ok: false, error: `scope must be one of ${Object.keys(VERIFY_JOBS).join(", ")}` } };
    return runCommerceJob(VERIFY_JOBS[body.scope], ctx, { scope: body.scope });
  },
  { limit: 6 },
);
