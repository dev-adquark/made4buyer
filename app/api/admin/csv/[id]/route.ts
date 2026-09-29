import { adminAction, field } from "@/lib/admin/route";
import { processImportJob, retryFailedRows } from "@/lib/csv/import";
import { audit } from "@/lib/security/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return adminAction(`/admin/csv/${id}`, async ({ form, ctx }) => {
    const action = field(form, "action");
    if (action === "process") {
      await audit(ctx, { action: "csv.process", entityType: "csv_import_job", entityId: id });
      const job = await processImportJob(id, ctx);
      return { ok: `Processed: ${job.appliedRows} applied, ${job.failedRows} failed, ${job.invalidRows} invalid (${job.status})` };
    }
    if (action === "retry") {
      const job = await retryFailedRows(id, ctx);
      return { ok: `Retry finished: ${job.appliedRows} applied, ${job.failedRows} still failing` };
    }
    return { error: "Unknown action" };
  })(req);
}
