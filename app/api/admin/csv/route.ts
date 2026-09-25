import { NextResponse } from "next/server";
import { adminAction } from "@/lib/admin/route";
import { config } from "@/lib/config";
import { createImportJob } from "@/lib/csv/import";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** CSV upload: size/type/header/row validation, then job + queue rows are created for preview. */
export const POST = adminAction("/admin/csv", async ({ req, form, ctx }) => {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > config.csv.maxBytes() + 64_000) return { response: NextResponse.json({ error: "Upload too large" }, { status: 413 }) };
  const file = form.get("file");
  if (!file || typeof file === "string") return { error: "Choose a CSV file to upload" };
  if (file.size > config.csv.maxBytes()) return { error: `File exceeds ${config.csv.maxBytes()} bytes` };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    return { error: "File is not valid UTF-8 text" };
  }
  const job = await createImportJob({ name: file.name, size: file.size, type: file.type }, text, ctx);
  if (job.status === "REJECTED") return { redirect: `/admin/csv/${job.id}`, error: "CSV rejected — see errors" };
  return { redirect: `/admin/csv/${job.id}`, ok: `Validated ${job.rowCount} row(s): ${job.validRows} ready, ${job.invalidRows} invalid. Review the preview, then process.` };
});
