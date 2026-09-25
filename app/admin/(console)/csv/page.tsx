import Link from "next/link";
import Flash from "@/components/flash";
import { Badge, when } from "@/components/admin-ui";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { OPTIONAL_COLUMNS, OVERRIDE_COLUMNS, REQUIRED_COLUMN } from "@/lib/csv/import";

export const dynamic = "force-dynamic";
export const metadata = { title: "CSV import" };

export default async function CsvPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const jobs = await db.csvImportJob.findMany({ orderBy: { createdAt: "desc" }, take: 30 });
  return (
    <>
      <h1>Bulk CSV overrides</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <section className="card card-body" aria-labelledby="upload-h">
        <h2 id="upload-h" style={{ marginTop: 0 }}>
          Upload
        </h2>
        <p className="small muted">
          Required column <code>{REQUIRED_COLUMN}</code> (review id, slug or dedupe key) plus at least one of: {[...OVERRIDE_COLUMNS, ...OPTIONAL_COLUMNS].map((c) => <code key={c} style={{ marginRight: 6 }}>{c}</code>)}. Max {Math.round(config.csv.maxBytes() / 1000)} KB, {config.csv.maxRows()} rows, UTF-8.
        </p>
        <form action="/api/admin/csv" method="post" encType="multipart/form-data" className="toolbar">
          <input type="hidden" name="returnTo" value="/admin/csv" />
          <div className="field">
            <label htmlFor="csv-file">CSV file</label>
            <input id="csv-file" name="file" type="file" accept=".csv,text/csv" required />
          </div>
          <button className="btn primary" type="submit">
            Upload &amp; validate
          </button>
          <a className="btn" href="/api/admin/csv/template" download>
            Download template
          </a>
        </form>
        <p className="small muted">Uploading only validates and previews. Overrides are applied when you press “Process” on the job page; each change is audited, then categorization, Sovrn matching, affiliate links and verification re-run for the affected reviews.</p>
      </section>
      <h2>Import jobs</h2>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Uploaded</th>
              <th scope="col">File</th>
              <th scope="col">By</th>
              <th scope="col" className="num">Rows</th>
              <th scope="col" className="num">Valid</th>
              <th scope="col" className="num">Invalid</th>
              <th scope="col" className="num">Applied</th>
              <th scope="col" className="num">Failed</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td data-label="Uploaded">{when(j.createdAt)}</td>
                <td data-label="File">
                  <Link href={`/admin/csv/${j.id}`}>{j.fileName}</Link>
                </td>
                <td data-label="By">{j.uploadedBy}</td>
                <td data-label="Rows" className="num">{j.rowCount}</td>
                <td data-label="Valid" className="num">{j.validRows}</td>
                <td data-label="Invalid" className="num">{j.invalidRows}</td>
                <td data-label="Applied" className="num">{j.appliedRows}</td>
                <td data-label="Failed" className="num">{j.failedRows}</td>
                <td data-label="Status">
                  <Badge value={j.status} />
                </td>
              </tr>
            ))}
            {!jobs.length && (
              <tr>
                <td colSpan={9}>No imports yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
