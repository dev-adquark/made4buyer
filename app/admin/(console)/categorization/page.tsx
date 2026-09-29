import Link from "next/link";
import Flash from "@/components/flash";
import { ActionForm, Badge, pct } from "@/components/admin-ui";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { CATEGORIES, categoryName, subcategoryName } from "@/lib/taxonomy/definitions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Categorization" };

export default async function CategorizationPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const view = param(sp, "view") === "all" ? "all" : param(sp, "view") === "missing" ? "missing" : "low";
  const threshold = config.taxonomy.autoAcceptThreshold();
  const [missing, rows, stats] = await Promise.all([
    db.normalizedReview.findMany({ where: { categorySlug: null, status: { not: "REJECTED" } }, take: 100, orderBy: { createdAt: "desc" }, select: { id: true, canonicalTitle: true, productName: true } }),
    db.reviewCategoryAssignment.findMany({
      where: { active: true, tagType: "CATEGORY", ...(view === "low" ? { confidence: { lt: threshold }, isOverride: false, reviewState: "UNREVIEWED" } : {}) },
      include: { review: { select: { id: true, canonicalTitle: true, productName: true, subcategorySlug: true, status: true } }, categoryTag: { select: { slug: true, name: true } } },
      orderBy: [{ confidence: "asc" }, { createdAt: "desc" }],
      take: 200,
    }),
    db.reviewCategoryAssignment.groupBy({ by: ["reviewState"], where: { tagType: "CATEGORY" }, _count: { _all: true } }),
  ]);
  const state = (s: string) => stats.find((x) => x.reviewState === s)?._count._all ?? 0;

  return (
    <>
      <h1>Categorization</h1>
      <Flash ok={param(sp, "ok")} error={param(sp, "error")} />
      <p className="muted">
        Assignments below {pct(threshold)} confidence need an editor decision before publishing. Accepted: {state("ACCEPTED")} · rejected: {state("REJECTED")} · unreviewed: {state("UNREVIEWED")}.
      </p>
      <nav aria-label="View">
        <ul className="chips">
          <li>
            <Link className="chip neutral" href="/admin/categorization" aria-current={view === "low" ? "true" : undefined}>
              Low confidence ({view === "low" ? rows.length : "…"})
            </Link>
          </li>
          <li>
            <Link className="chip neutral" href="/admin/categorization?view=missing" aria-current={view === "missing" ? "true" : undefined}>
              Missing category ({missing.length})
            </Link>
          </li>
          <li>
            <Link className="chip neutral" href="/admin/categorization?view=all" aria-current={view === "all" ? "true" : undefined}>
              All active
            </Link>
          </li>
        </ul>
      </nav>

      {view === "missing" ? (
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>
                <th scope="col">Review</th>
                <th scope="col">Set category</th>
              </tr>
            </thead>
            <tbody>
              {missing.map((r) => (
                <tr key={r.id}>
                  <td data-label="Review">
                    <Link href={`/admin/reviews/${r.id}`}>{r.canonicalTitle}</Link>
                    <div className="small muted">{r.productName}</div>
                  </td>
                  <td data-label="Set category">
                    <OverrideForm reviewId={r.id} returnTo="/admin/categorization?view=missing" />
                  </td>
                </tr>
              ))}
              {!missing.length && (
                <tr>
                  <td colSpan={2}>Every review has a primary category.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>
                <th scope="col">Review</th>
                <th scope="col">Category</th>
                <th scope="col">Subcategory</th>
                <th scope="col" className="num">Confidence</th>
                <th scope="col">Reason</th>
                <th scope="col">Override</th>
                <th scope="col">Decision</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const returnTo = `/admin/categorization${view === "all" ? "?view=all" : ""}`;
                return (
                  <tr key={a.id}>
                    <td data-label="Review">
                      <Link href={`/admin/reviews/${a.review.id}`}>{a.review.canonicalTitle}</Link>
                      <div className="small muted">
                        {a.review.productName} · <Badge value={a.review.status} />
                      </div>
                    </td>
                    <td data-label="Category">{categoryName(a.categoryTag.slug)}</td>
                    <td data-label="Subcategory">{subcategoryName(a.categoryTag.slug, a.review.subcategorySlug) ?? "—"}</td>
                    <td data-label="Confidence" className="num">
                      {a.confidence < threshold ? <Badge value={pct(a.confidence)} tone="warn" /> : pct(a.confidence)}
                    </td>
                    <td data-label="Reason" className="small muted">{a.reason}</td>
                    <td data-label="Override">{a.isOverride ? <Badge value={a.overrideSource ?? "override"} tone="info" /> : <OverrideForm reviewId={a.review.id} returnTo={returnTo} />}</td>
                    <td data-label="Decision">
                      {a.reviewState === "UNREVIEWED" && !a.isOverride ? (
                        <div className="btnrow" style={{ margin: 0 }}>
                          <ActionForm action="/api/admin/assignments" fields={{ id: a.id, decision: "ACCEPTED" }} label="Accept" returnTo={returnTo} />
                          <ActionForm action="/api/admin/assignments" fields={{ id: a.id, decision: "REJECTED" }} label="Reject" returnTo={returnTo} className="btn small danger" />
                        </div>
                      ) : (
                        <Badge value={a.reviewState} />
                      )}
                    </td>
                  </tr>
                );
              })}
              {!rows.length && (
                <tr>
                  <td colSpan={7}>Nothing needs review.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function OverrideForm({ reviewId, returnTo }: { reviewId: string; returnTo: string }) {
  const id = `cat-${reviewId}`;
  return (
    <form className="inline-form" action="/api/admin/reviews" method="post">
      <input type="hidden" name="id" value={reviewId} />
      <input type="hidden" name="action" value="override-category" />
      <input type="hidden" name="returnTo" value={returnTo} />
      <label htmlFor={id} className="visually-hidden">
        Category
      </label>
      <select id={id} name="category" required defaultValue="">
        <option value="" disabled>
          Category…
        </option>
        {CATEGORIES.map((c) => (
          <option key={c.slug} value={c.slug}>
            {c.name}
          </option>
        ))}
      </select>
      <button className="btn small" type="submit">
        Set
      </button>
    </form>
  );
}
