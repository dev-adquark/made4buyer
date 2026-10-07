import { adminJsonPost } from "@/lib/admin/api";
import { PURPOSE_JOB, RUN_PURPOSES, runCommerceJob, startBrandApifyRun, type RunPurpose } from "@/lib/commerce/admin-jobs";
import { slugToken } from "@/lib/commerce/admin-queries";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/commerce/apify/run {brand?: slug, purpose?: "PRODUCT" | "COUPON" | "DEAL"} — admin,
 * same-origin, rate-limited, audited. With a brand: that brand's run now. Without: the job that
 * starts runs for the next due brands (commerce-discover, or commerce-coupons for COUPON).
 */
export const POST = adminJsonPost(
  "commerce-apify-run",
  async ({ body, ctx }) => {
    const purposeRaw = body.purpose === undefined || body.purpose === null || body.purpose === "" ? "PRODUCT" : String(body.purpose).toUpperCase();
    if (!(RUN_PURPOSES as readonly string[]).includes(purposeRaw)) return { status: 400, body: { ok: false, error: `purpose must be one of ${RUN_PURPOSES.join(", ")}` } };
    const purpose = purposeRaw as RunPurpose;
    if (body.brand !== undefined && body.brand !== null && body.brand !== "") {
      const slug = typeof body.brand === "string" ? slugToken(body.brand) : undefined;
      if (!slug) return { status: 400, body: { ok: false, error: "brand must be a brand slug (lowercase letters, digits and dashes)" } };
      return startBrandApifyRun(slug, purpose, ctx);
    }
    return runCommerceJob(PURPOSE_JOB[purpose], ctx, { purpose });
  },
  { limit: 6 },
);
