import { Prisma } from "@prisma/client";
import Link from "next/link";
import Flash from "@/components/flash";
import { ActionForm, Badge, pct } from "@/components/admin-ui";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { config } from "@/lib/config";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "Entities" };

/** Entity-extraction QA: low-confidence and overridden entities across all reviews. */
export default async function EntitiesPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const view = param(sp, "view") === "overrides" ? "overrides" : "low";
  const rows = await db.extractedEntities.findMany({
    where: view === "low" ? { lowConfidenceFields: { isEmpty: false } } : { NOT: [{ overrides: { equals: Prisma.AnyNull } }] },
    orderBy: { overallConfidence: "asc" },
    take: 200,
    include: { review: { select: { id: true, canonicalTitle: true, status: true } } },
  });
  const shown = view === "overrides" ? rows.filter((r) => r.overrides && Object.keys(r.overrides as object).length) : rows;
  return (
    <>
      <h1>Entities</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p className="muted">Core entities (product, brand, device type) below {pct(config.entities.lowConfidenceThreshold())} confidence block publishing until an editor confirms or overrides them.</p>
      <nav aria-label="View">
        <ul className="chips">
          <li>
            <Link className="chip neutral" href="/admin/entities" aria-current={view === "low" ? "true" : undefined}>
              Low confidence
            </Link>
          </li>
          <li>
            <Link className="chip neutral" href="/admin/entities?view=overrides" aria-current={view === "overrides" ? "true" : undefined}>
              Overridden
            </Link>
          </li>
        </ul>
      </nav>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Review</th>
              <th scope="col">Product</th>
              <th scope="col">Brand</th>
              <th scope="col">Device type</th>
              <th scope="col" className="num">Overall</th>
              <th scope="col">Needs review</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => {
              const conf = e.confidences as Record<string, number>;
              const cell = (field: "productName" | "brand" | "deviceType") => {
                const v = e[field];
                const low = e.lowConfidenceFields.includes(field);
                return (
                  <>
                    {v ?? <span className="muted">none</span>} <span className="small muted">({pct(conf[field])})</span> {low && <Badge value="LOW" tone="warn" />}
                  </>
                );
              };
              return (
                <tr key={e.id}>
                  <td data-label="Review">
                    <Link href={`/admin/reviews/${e.review.id}`}>{e.review.canonicalTitle}</Link> <Badge value={e.review.status} />
                  </td>
                  <td data-label="Product">{cell("productName")}</td>
                  <td data-label="Brand">{cell("brand")}</td>
                  <td data-label="Device type">{cell("deviceType")}</td>
                  <td data-label="Overall" className="num">{pct(e.overallConfidence)}</td>
                  <td data-label="Needs review">{e.lowConfidenceFields.join(", ") || "—"}</td>
                  <td data-label="Action">
                    <div className="btnrow" style={{ margin: 0 }}>
                      {e.lowConfidenceFields.length > 0 && <ActionForm action="/api/admin/reviews" fields={{ id: e.review.id, action: "confirm-entities" }} label="Confirm values" returnTo={`/admin/entities${view === "overrides" ? "?view=overrides" : ""}`} />}
                      <Link className="btn small" href={`/admin/reviews/${e.review.id}#ent-h`}>
                        Override
                      </Link>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!shown.length && (
              <tr>
                <td colSpan={7}>{view === "low" ? "No low-confidence entities." : "No overrides recorded."}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
