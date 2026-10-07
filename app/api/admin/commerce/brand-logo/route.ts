import { adminAction, field } from "@/lib/admin/route";
import { overrideBrandLogo, recheckBrandLogo, unlockBrandLogo } from "@/lib/commerce/brand-logos";
import { audit } from "@/lib/security/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PAGE = "/admin/commerce/sources";

/** Admin → Commerce → Sources, official logo: recheck | override (URL, validated, locks) | unlock. Every change is audited. */
export const POST = adminAction(PAGE, async ({ form, ctx }) => {
  const action = field(form, "action");
  const id = field(form, "id");
  if (!id) return { error: "Brand id missing" };

  if (action === "recheck") {
    const r = await recheckBrandLogo(id);
    if (!r.ok) return { error: r.error };
    await audit(ctx, { action: "commerce_brand.logo_recheck", entityType: "commerce_brand", entityId: id, metadata: { status: r.status, reason: r.reason.slice(0, 300), locked: r.locked } });
    return { ok: `Logo ${r.locked ? "kept (locked override)" : r.status}: ${r.reason.slice(0, 200)}` };
  }

  if (action === "override") {
    const r = await overrideBrandLogo(id, field(form, "logoUrl"));
    if (!r.ok) return { error: r.error };
    await audit(ctx, { action: "commerce_brand.logo_override", entityType: "commerce_brand", entityId: id, before: r.before, after: r.after });
    return { ok: "Logo override saved and locked: the logo checker will not change it" };
  }

  if (action === "unlock") {
    const r = await unlockBrandLogo(id);
    if (!r.ok) return { error: r.error };
    await audit(ctx, { action: "commerce_brand.logo_unlock", entityType: "commerce_brand", entityId: id, after: { logoLocked: false } });
    return { ok: `${r.name}: logo unlocked; it is re-checked on the next brand-logos run` };
  }

  return { error: `Unknown action: ${action || "(none)"}` };
});
