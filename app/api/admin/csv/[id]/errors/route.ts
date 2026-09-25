import { NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth";
import { errorReportCsv } from "@/lib/csv/import";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getAdminSession())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const csv = await errorReportCsv(id);
    return new NextResponse(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="csv-import-${id}-errors.csv"`, "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Import job not found" }, { status: 404 });
  }
}
