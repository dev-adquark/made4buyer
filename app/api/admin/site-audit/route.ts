import { adminAction } from "@/lib/admin/route";
import { runSiteAudit } from "@/lib/admin/site-audit";
import { audit } from "@/lib/security/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = adminAction("/admin/audit", async ({ ctx }) => {
  const result = await runSiteAudit();
  await audit(ctx, { action: "site.audit", entityType: "site", entityId: result.base, metadata: { checked: result.checked, broken: result.broken } });
  const summary = `Checked ${result.checked} URL(s), ${result.broken} broken${result.errors.length ? `: ${result.errors.slice(0, 5).map((e) => `${e.status || "ERR"} ${e.url}${e.error ? ` (${e.error})` : ""}`).join("; ")}` : ""}`;
  return result.broken ? { error: summary, json: result } : { ok: summary, json: result };
});
