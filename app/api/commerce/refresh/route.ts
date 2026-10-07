import { adminJsonPost } from "@/lib/admin/api";
import { REFRESH_JOB, runCommerceJob } from "@/lib/commerce/admin-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** POST /api/commerce/refresh — admin, same-origin, rate-limited, audited: runs (forces) the weekly deals refresh. */
export const POST = adminJsonPost("commerce-refresh", async ({ ctx }) => runCommerceJob(REFRESH_JOB, ctx, { forced: true }), { limit: 4 });
