import { NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Download a persisted Day-30 report as JSON or HTML. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getAdminSession())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const report = await db.day30Report.findUnique({ where: { id } });
  if (!report) return NextResponse.json({ error: "Report not found" }, { status: 404 });
  const format = new URL(req.url).searchParams.get("format") === "html" ? "html" : "json";
  const name = `day30-report-${report.generatedAt.toISOString().slice(0, 10)}`;
  if (format === "html") {
    return new NextResponse(report.html, { headers: { "content-type": "text/html; charset=utf-8", "content-disposition": `inline; filename="${name}.html"`, "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } });
  }
  return new NextResponse(JSON.stringify(report.json, null, 2), { headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${name}.json"`, "cache-control": "no-store" } });
}
