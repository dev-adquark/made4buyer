import { adminAction, field } from "@/lib/admin/route";
import { recheckImageAsset } from "@/lib/images/integrity";
import { memoryRateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Admin → Images "Re-check": runs the image-integrity check for one image now (audited as the admin). */
export const POST = adminAction("/admin/images", async ({ form, admin, ctx }) => {
  const id = field(form, "assetId");
  if (!id) return { error: "No image given." };
  if (!memoryRateLimit(`image-recheck:${admin.email}`, 120, 3_600_000)) return { error: "Too many re-checks this hour. Try again later." };
  const r = await recheckImageAsset(id, ctx);
  const text = `Re-check: ${r.outcome}${r.reason ? ` (${r.reason})` : ""}`;
  return r.outcome === "not-checkable" ? { error: text, json: r } : { ok: text, json: r };
});
