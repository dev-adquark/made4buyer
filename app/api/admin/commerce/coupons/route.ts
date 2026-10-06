import { adminAction, field } from "@/lib/admin/route";
import { ADMIN_INVALID_PREFIX } from "@/lib/commerce/coupons";
import { importCommerceSources } from "@/lib/commerce/sources";
import { db } from "@/lib/db";
import { audit } from "@/lib/security/audit";

export const dynamic = "force-dynamic";

const PAGE = "/admin/commerce/coupons";

/**
 * Admin → Commerce → Coupons actions. Enabling a third-party coupon site requires its terms to
 * be recorded as APPROVED first; revoking the approval also disables it. Every change is audited.
 */
export const POST = adminAction(PAGE, async ({ form, ctx }) => {
  const action = field(form, "action");
  const id = field(form, "id");

  if (action === "import-sources") {
    const r = await importCommerceSources();
    await audit(ctx, { action: "commerce.sources.import", entityType: "commerce_source", entityId: "seed", metadata: r });
    return { ok: `Coupon sources imported: ${r.created} added (disabled, terms unreviewed), ${r.updated} refreshed` };
  }

  if (action === "approve-terms" || action === "revoke-terms" || action === "toggle-source") {
    const source = await db.commerceSource.findUnique({ where: { id } });
    if (!source) return { error: "Source not found" };
    if (action === "approve-terms") {
      if (source.termsStatus === "APPROVED") return { ok: `${source.name}: terms already approved` };
      const after = await db.commerceSource.update({ where: { id }, data: { termsStatus: "APPROVED", notes: [source.notes, `Terms approved by ${ctx.actor} on ${new Date().toISOString().slice(0, 10)}`].filter(Boolean).join("\n") } });
      await audit(ctx, { action: "commerce.source.terms.approve", entityType: "commerce_source", entityId: id, before: { termsStatus: source.termsStatus }, after: { termsStatus: after.termsStatus } });
      return { ok: `${source.name}: terms recorded as APPROVED. It is still disabled until you enable it.` };
    }
    if (action === "revoke-terms") {
      const after = await db.commerceSource.update({ where: { id }, data: { termsStatus: "UNREVIEWED", enabled: false } });
      await audit(ctx, { action: "commerce.source.terms.revoke", entityType: "commerce_source", entityId: id, before: { termsStatus: source.termsStatus, enabled: source.enabled }, after: { termsStatus: after.termsStatus, enabled: after.enabled } });
      return { ok: `${source.name}: terms approval revoked and source disabled` };
    }
    const enable = !source.enabled;
    if (enable && source.termsStatus !== "APPROVED") return { error: `${source.name} cannot be enabled: record its terms as APPROVED first (only after confirming the site permits automated collection)` };
    const after = await db.commerceSource.update({ where: { id }, data: { enabled: enable } });
    await audit(ctx, { action: enable ? "commerce.source.enable" : "commerce.source.disable", entityType: "commerce_source", entityId: id, before: { enabled: source.enabled }, after: { enabled: after.enabled } });
    return { ok: enable ? `${source.name} enabled: crawled on the next coupon run` : `${source.name} disabled` };
  }

  if (action === "mark-invalid") {
    const coupon = await db.commerceCoupon.findUnique({ where: { id } });
    if (!coupon) return { error: "Coupon not found" };
    const evidence = `${ADMIN_INVALID_PREFIX}${ctx.actor} at ${new Date().toISOString()}`;
    await db.commerceCoupon.update({ where: { id }, data: { status: "INVALID", verificationEvidence: evidence } });
    await audit(ctx, { action: "commerce.coupon.invalidate", entityType: "commerce_coupon", entityId: id, before: { status: coupon.status, evidence: coupon.verificationEvidence }, after: { status: "INVALID", evidence } });
    return { ok: `${coupon.merchant} ${coupon.code} marked INVALID (kept on file, no longer shown)` };
  }

  return { error: "Unknown action" };
});
