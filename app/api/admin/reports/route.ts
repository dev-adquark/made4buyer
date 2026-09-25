import { adminAction } from "@/lib/admin/route";
import { generateDay30Report } from "@/lib/reports/day30";
import { audit } from "@/lib/security/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const POST = adminAction("/admin/reports", async ({ ctx }) => {
  const { id } = await generateDay30Report({ actor: ctx.actor });
  await audit(ctx, { action: "report.day30.generate", entityType: "day30_report", entityId: id });
  return { ok: "Day-30 report generated", redirect: `/admin/reports?id=${id}` };
});
