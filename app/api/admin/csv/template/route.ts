import { NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth";
import { ALL_COLUMNS } from "@/lib/csv/import";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await getAdminSession())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return new NextResponse(ALL_COLUMNS.join(",") + "\r\n", { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="override-template.csv"', "cache-control": "no-store" } });
}
