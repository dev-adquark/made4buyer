import type { Prisma, ReviewStatus } from "@prisma/client";
import Link from "next/link";
import Flash from "@/components/flash";
import { ActionForm, Badge, Pager, pct } from "@/components/admin-ui";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { db } from "@/lib/db";
import { categoryName } from "@/lib/taxonomy/definitions";

export const dynamic = "force-dynamic";
export const metadata = { title: "QA queue" };

const STATUSES: ReviewStatus[] = ["NEEDS_REVIEW", "QUEUED", "PUBLISHED", "UNPUBLISHED", "REJECTED"];
const PAGE = 50;

export default async function QaPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const status = STATUSES.includes(param(sp, "status") as ReviewStatus) ? (param(sp, "status") as ReviewStatus) : undefined;
  const q = (param(sp, "q") ?? "").slice(0, 100);
  const page = Math.max(1, Number(param(sp, "page")) || 1);
  const where: Prisma.NormalizedReviewWhereInput = {
    ...(status ? { status } : { status: { in: ["NEEDS_REVIEW", "QUEUED"] } }),
    ...(q ? { OR: [{ canonicalTitle: { contains: q, mode: "insensitive" } }, { productName: { contains: q, mode: "insensitive" } }, { slug: { contains: q } }] } : {}),
  };
  const [total, rows, counts] = await Promise.all([
    db.normalizedReview.count({ where }),
    db.normalizedReview.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }],
      skip: (page - 1) * PAGE,
      take: PAGE,
      include: {
        entities: { select: { lowConfidenceFields: true } },
        images: { where: { isPrimary: true }, select: { isFallback: true, licenseState: true }, take: 1 },
        affiliateLinks: { where: { isActive: true }, select: { verificationStatus: true, isBest: true } },
      },
    }),
    db.normalizedReview.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const count = (s: string) => counts.find((c) => c.status === s)?._count._all ?? 0;
  const qs = new URLSearchParams({ ...(status ? { status } : {}), ...(q ? { q } : {}) }).toString();
  const base = `/admin/qa${qs ? `?${qs}` : ""}`;
  const returnTo = page > 1 ? `${base}${qs ? "&" : "?"}page=${page}` : base;
  const queued = rows.filter((r) => r.status === "QUEUED");

  return (
    <>
      <h1>QA queue</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <nav aria-label="Status filter">
        <ul className="chips">
          <li>
            <Link className="chip neutral" href="/admin/qa" aria-current={!status ? "true" : undefined}>
              Open ({count("NEEDS_REVIEW") + count("QUEUED")})
            </Link>
          </li>
          {STATUSES.map((s) => (
            <li key={s}>
              <Link className="chip neutral" href={`/admin/qa?status=${s}`} aria-current={status === s ? "true" : undefined}>
                {s} ({count(s)})
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <form className="toolbar" action="/admin/qa">
        {status && <input type="hidden" name="status" value={status} />}
        <div className="field">
          <label htmlFor="qa-q">Search</label>
          <input id="qa-q" name="q" defaultValue={q} placeholder="Title, product or slug" />
        </div>
        <button className="btn" type="submit">
          Filter
        </button>
      </form>
      {queued.length > 0 && (
        <form action="/api/admin/reviews" method="post" className="btnrow">
          <input type="hidden" name="action" value="bulk-publish" />
          <input type="hidden" name="returnTo" value={returnTo} />
          {queued.map((r) => (
            <input key={r.id} type="hidden" name="ids" value={r.id} />
          ))}
          <button className="btn primary" type="submit">
            Publish all {queued.length} QA-passed review(s) on this page
          </button>
        </form>
      )}
      <div className="table-wrap">
        <table className="table responsive">
          <caption className="visually-hidden">Reviews</caption>
          <thead>
            <tr>
              <th scope="col">Review</th>
              <th scope="col">Category</th>
              <th scope="col">Confidence</th>
              <th scope="col">QA</th>
              <th scope="col">Deal / link</th>
              <th scope="col">Image</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const failures = (r.qaFailures as Array<{ code: string; message: string }> | null) ?? [];
              const best = r.affiliateLinks.find((l) => l.isBest);
              return (
                <tr key={r.id}>
                  <td data-label="Review">
                    <Link href={`/admin/reviews/${r.id}`}>
                      <strong>{r.canonicalTitle}</strong>
                    </Link>
                    <div className="small muted">
                      {r.productName}
                      {r.brand ? ` · ${r.brand}` : ""}
                    </div>
                  </td>
                  <td data-label="Category">{r.categorySlug ? categoryName(r.categorySlug) : <Badge value="MISSING" tone="error" />}</td>
                  <td data-label="Confidence" className="small">
                    category {pct(r.classificationConfidence)}
                    <br />
                    entities {pct(r.entityConfidence)}
                    {r.entities?.lowConfidenceFields.length ? (
                      <>
                        <br />
                        <Badge value={`low: ${r.entities.lowConfidenceFields.join(", ")}`} tone="warn" />
                      </>
                    ) : null}
                  </td>
                  <td data-label="QA">{failures.length ? <span className="small">{failures.map((f) => f.code).join(", ")}</span> : <Badge value="PASS" tone="ok" />}</td>
                  <td data-label="Deal / link">
                    <Badge value={r.dealStatus} />
                    <br />
                    <Badge value={best?.verificationStatus ?? "NO LINK"} />
                  </td>
                  <td data-label="Image">{r.images[0] ? <Badge value={r.images[0].isFallback ? "FALLBACK" : r.images[0].licenseState} /> : <Badge value="NONE" />}</td>
                  <td data-label="Status">
                    <Badge value={r.status} />
                  </td>
                  <td data-label="Actions">
                    <div className="btnrow" style={{ margin: 0 }}>
                      <Link className="btn small" href={`/admin/reviews/${r.id}`}>
                        Edit
                      </Link>
                      {(r.status === "QUEUED" || r.status === "NEEDS_REVIEW" || r.status === "UNPUBLISHED") && (
                        <ActionForm action="/api/admin/reviews" fields={{ id: r.id, action: "publish" }} label="Publish" returnTo={returnTo} className="btn small primary" disabledReason={failures.length ? `QA: ${failures.map((f) => f.code).join(", ")}` : undefined} />
                      )}
                      {r.status === "PUBLISHED" && <ActionForm action="/api/admin/reviews" fields={{ id: r.id, action: "unpublish" }} label="Unpublish" returnTo={returnTo} confirm="Unpublish this review? It will disappear from the public site." />}
                      {(r.status === "REJECTED" || r.status === "UNPUBLISHED") && <ActionForm action="/api/admin/reviews" fields={{ id: r.id, action: "restore" }} label="Restore" returnTo={returnTo} />}
                      {r.status !== "REJECTED" && <ActionForm action="/api/admin/reviews" fields={{ id: r.id, action: "reject" }} label="Reject" returnTo={returnTo} confirm="Reject this review?" className="btn small danger" />}
                    </div>
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={8}>No reviews in this view.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={page} pages={Math.ceil(total / PAGE)} base={base} />
    </>
  );
}
