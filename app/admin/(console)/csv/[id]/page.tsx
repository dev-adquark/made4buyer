import Link from "next/link";
import { notFound } from "next/navigation";
import Flash from "@/components/flash";
import { ActionForm, Badge, Stat, when } from "@/components/admin-ui";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "CSV import job" };

export default async function CsvJobPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  await requireAdminPage();
  const { id } = await params;
  const sp = await searchParams;
  const job = await db.csvImportJob.findUnique({ where: { id }, include: { items: { orderBy: { rowNumber: "asc" }, take: 1000, include: { review: { select: { slug: true, productName: true } } } } } });
  if (!job) notFound();
  const self = `/admin/csv/${id}`;
  const pending = job.items.filter((i) => i.processingStatus === "PENDING").length;
  const failed = job.items.filter((i) => i.processingStatus === "FAILED").length;
  const headerErrors = (job.headerErrors ?? []) as string[];

  return (
    <>
      <p className="small">
        <Link href="/admin/csv">← All imports</Link>
      </p>
      <h1>{job.fileName}</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p>
        <Badge value={job.status} /> <span className="small muted">uploaded {when(job.createdAt)} by {job.uploadedBy}{job.completedAt ? ` · completed ${when(job.completedAt)}` : ""}</span>
      </p>
      {headerErrors.length > 0 && (
        <div className="notice error" role="alert">
          <strong>File rejected:</strong>
          <ul>
            {headerErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="stats">
        <Stat label="Rows" value={job.rowCount} />
        <Stat label="Pending" value={pending} />
        <Stat label="Invalid" value={job.invalidRows} />
        <Stat label="Applied" value={job.appliedRows} />
        <Stat label="Failed" value={job.failedRows} />
      </div>
      <div className="btnrow">
        <ActionForm action={`/api/admin/csv/${id}`} fields={{ action: "process" }} label={`Process ${pending} pending row(s)`} returnTo={self} className="btn primary" disabledReason={job.status === "REJECTED" ? "File was rejected" : pending === 0 ? "No pending rows" : undefined} />
        <ActionForm action={`/api/admin/csv/${id}`} fields={{ action: "retry" }} label={`Retry ${failed} failed row(s)`} returnTo={self} disabledReason={failed === 0 ? "No failed rows" : undefined} />
        <a className="btn" href={`/api/admin/csv/${id}/errors`}>
          Download error report (CSV)
        </a>
      </div>
      <div className="table-wrap">
        <table className="table responsive">
          <caption>Row preview</caption>
          <thead>
            <tr>
              <th scope="col" className="num">Row</th>
              <th scope="col">Review key</th>
              <th scope="col">Category</th>
              <th scope="col">Brand</th>
              <th scope="col">Product name</th>
              <th scope="col">Deal ID</th>
              <th scope="col">Other</th>
              <th scope="col">Status</th>
              <th scope="col">Error</th>
            </tr>
          </thead>
          <tbody>
            {job.items.map((i) => (
              <tr key={i.id}>
                <td data-label="Row" className="num">{i.rowNumber}</td>
                <td data-label="Review key" style={{ wordBreak: "break-all" }}>
                  {i.normalizedReviewId ? <Link href={`/admin/reviews/${i.normalizedReviewId}`}>{i.review?.productName ?? i.normalizedReviewKey}</Link> : i.normalizedReviewKey}
                </td>
                <td data-label="Category">{i.overridePrimaryCategory ?? "—"}</td>
                <td data-label="Brand">{i.entityBrandOverride ?? "—"}</td>
                <td data-label="Product name">{i.entityProductNameOverride ?? "—"}</td>
                <td data-label="Deal ID">{i.sovrnDealIdOverride ?? "—"}</td>
                <td data-label="Other" className="small">{i.extraOverrides ? Object.entries(i.extraOverrides as Record<string, string | undefined>).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(", ") : "—"}</td>
                <td data-label="Status">
                  <Badge value={i.processingStatus} />
                  {i.retryCount > 0 && <span className="small muted"> ({i.retryCount} retr{i.retryCount === 1 ? "y" : "ies"})</span>}
                </td>
                <td data-label="Error" className="small">
                  {i.errorCode && <Badge value={i.errorCode} tone={i.processingStatus === "APPLIED" ? "info" : "error"} />} {i.errorReason ?? ""}
                </td>
              </tr>
            ))}
            {!job.items.length && (
              <tr>
                <td colSpan={9}>No rows.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
