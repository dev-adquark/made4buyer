import { startBrandRun } from "./pipeline";
import type { AdminPostResult } from "@/lib/admin/api";
import { db } from "@/lib/db";
import { LockHeldError, withLock } from "@/lib/jobs/lock";
import { isJobName, jobOutcome, runJob } from "@/lib/jobs/registry";
import { audit, type AuditContext } from "@/lib/security/audit";

/**
 * Admin JSON API actions that start commerce work (/api/commerce/apify/run, /verify, /refresh).
 * They only ever run the registered jobs (lib/jobs/registry.ts, same code path, lock and JobRun
 * record as cron and Admin → Jobs) or the pipeline's own brand run; a request names a brand by
 * slug and a purpose/scope from a fixed list, never a URL. Every call is audited.
 */

export const RUN_PURPOSES = ["PRODUCT", "COUPON", "DEAL"] as const;
export type RunPurpose = (typeof RUN_PURPOSES)[number];

/** Which job each run purpose starts when no brand is named (the next due brands). */
export const PURPOSE_JOB: Record<RunPurpose, string> = { PRODUCT: "commerce-discover", DEAL: "commerce-discover", COUPON: "commerce-coupons" };

/** Verification scopes → jobs. "deals" is registered by the deal classifier; until then it answers 503. */
export const VERIFY_JOBS = { links: "commerce-validate-links", official: "commerce-official-verify", coupons: "commerce-collect", deals: "commerce-classify-deals" } as const;
export type VerifyScope = keyof typeof VERIFY_JOBS;
export const isVerifyScope = (v: unknown): v is VerifyScope => typeof v === "string" && Object.prototype.hasOwnProperty.call(VERIFY_JOBS, v);

export const REFRESH_JOB = "deals-weekly-refresh";

/** Runs a registered job as an admin ("admin:" trigger: runs even when paused by a switch; the weekly refresh is forced). */
export async function runCommerceJob(job: string, ctx: AuditContext, metadata: Record<string, unknown> = {}): Promise<AdminPostResult> {
  if (!isJobName(job)) return { status: 503, body: { ok: false, job, error: `${job} is not available: the job is not registered yet` } };
  try {
    const result = await runJob(job, `admin:${ctx.actor}`);
    const outcome = jobOutcome(result);
    await audit(ctx, { action: `job.run.${job}`, entityType: "job", entityId: job, metadata: { via: "api", ...metadata, outcome: outcome.status, result } });
    return { status: outcome.ran ? 200 : 422, body: { ok: outcome.ran, job, status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}), result } };
  } catch (error) {
    if (error instanceof LockHeldError) return { status: 409, body: { ok: false, job, status: "LOCK_HELD", error: `${job} is already running` } };
    throw error;
  }
}

/**
 * Starts one brand's Apify run now (PRODUCT or DEAL: the brand run the pipeline builds — price
 * re-checks first, then the brand's product/deal pages and discovery). The pipeline itself
 * enforces the engine switch, the monthly budget and one active run per brand.
 */
export async function startBrandApifyRun(slug: string, purpose: RunPurpose, ctx: AuditContext): Promise<AdminPostResult> {
  const brand = await db.commerceBrand.findUnique({ where: { slug } });
  if (!brand) return { status: 404, body: { ok: false, error: `No brand with slug ${slug}` } };
  if (!brand.enabled) return { status: 422, body: { ok: false, brand: slug, error: `${brand.name} is disabled: enable it in Commerce → Sources first` } };
  if (purpose === "COUPON") {
    return { status: 422, body: { ok: false, brand: slug, error: "A single-brand coupon run is not available; send {purpose: \"COUPON\"} without a brand to start the due coupon runs" } };
  }
  try {
    const r = await withLock(`commerce-brand-run:${brand.id}`, 5 * 60_000, () => startBrandRun(brand, `admin:${ctx.actor}`, new Date()));
    await audit(ctx, { action: "commerce.apify.run", entityType: "commerce_brand", entityId: brand.id, metadata: { brand: slug, purpose, status: r.status, code: r.code ?? null, runId: r.runId ?? null, urls: r.urls, recheck: r.recheck, discovery: r.discovery, reason: r.reason ?? null } });
    const started = r.status === "STARTED";
    return {
      status: started ? 200 : 422,
      body: { ok: started, brand: slug, purpose, status: r.status, ...(r.code ? { code: r.code } : {}), ...(r.reason ? { reason: r.reason } : {}), runId: r.runId ?? null, urls: r.urls, recheck: r.recheck, discovery: r.discovery },
    };
  } catch (error) {
    if (error instanceof LockHeldError) return { status: 409, body: { ok: false, brand: slug, status: "LOCK_HELD", error: `A run for ${brand.name} is already being started` } };
    throw error;
  }
}
