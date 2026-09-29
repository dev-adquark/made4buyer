import type { Prisma, ReviewStatus } from "@prisma/client";
import Link from "next/link";
import { Badge, Pager, pct, when } from "@/components/admin-ui";
import { param, requireAdminPage, type SearchParams } from "@/lib/admin/guard";
import { db } from "@/lib/db";
import { CATEGORIES, categoryName } from "@/lib/taxonomy/definitions";

export const dynamic = "force-dynamic";
export const metadata = { title: "All reviews" };

const STATUSES: ReviewStatus[] = ["NEEDS_REVIEW", "QUEUED", "PUBLISHED", "UNPUBLISHED", "REJECTED"];
const PAGE = 50;

/** Searchable index of every review regardless of status. */
export default async function ReviewsIndex({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const q = (param(sp, "q") ?? "").slice(0, 100);
  const status = STATUSES.includes(param(sp, "status") as ReviewStatus) ? (param(sp, "status") as ReviewStatus) : undefined;
  const category = CATEGORIES.some((c) => c.slug === param(sp, "category")) ? param(sp, "category") : undefined;
  const page = Math.max(1, Number(param(sp, "page")) || 1);
  const where: Prisma.NormalizedReviewWhereInput = {
    ...(status ? { status } : {}),
    ...(category ? { categorySlug: category } : {}),
    ...(q ? { OR: [{ canonicalTitle: { contains: q, mode: "insensitive" } }, { productName: { contains: q, mode: "insensitive" } }, { brand: { contains: q, mode: "insensitive" } }, { slug: { contains: q } }, { sourceId: { contains: q } }] } : {}),
  };
  const [total, rows] = await Promise.all([
    db.normalizedReview.count({ where }),
    db.normalizedReview.findMany({ where, orderBy: { updatedAt: "desc" }, skip: (page - 1) * PAGE, take: PAGE, select: { id: true, canonicalTitle: true, productName: true, brand: true, categorySlug: true, status: true, dealStatus: true, confidence: true, classificationConfidence: true, entityConfidence: true, updatedAt: true, publishedAt: true, slug: true } }),
  ]);
  const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}), ...(category ? { category } : {}) }).toString();
  return (
    <>
      <h1>All reviews</h1>
      <form className="toolbar" action="/admin/reviews">
        <div className="field">
          <label htmlFor="r-q">Search</label>
          <input id="r-q" name="q" defaultValue={q} placeholder="Title, product, brand, slug, source id" />
        </div>
        <div className="field">
          <label htmlFor="r-status">Status</label>
          <select id="r-status" name="status" defaultValue={status ?? ""}>
            <option value="">Any</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="r-cat">Category</label>
          <select id="r-cat" name="category" defaultValue={category ?? ""}>
            <option value="">Any</option>
            {CATEGORIES.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <button className="btn" type="submit">
          Apply
        </button>
      </form>
      <p className="small muted">{total} review(s)</p>
      <div className="table-wrap">
        <table className="table responsive">
          <thead>
            <tr>
              <th scope="col">Review</th>
              <th scope="col">Category</th>
              <th scope="col">Status</th>
              <th scope="col">Deal</th>
              <th scope="col" className="num">Confidence</th>
              <th scope="col">Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td data-label="Review">
                  <Link href={`/admin/reviews/${r.id}`}>{r.canonicalTitle}</Link>
                  <div className="small muted">{[r.productName, r.brand].filter(Boolean).join(", ")}</div>
                </td>
                <td data-label="Category">{categoryName(r.categorySlug) ?? <Badge value="MISSING" tone="error" />}</td>
                <td data-label="Status">
                  <Badge value={r.status} />
                </td>
                <td data-label="Deal">
                  <Badge value={r.dealStatus} />
                </td>
                <td data-label="Confidence" className="num">
                  {pct(r.classificationConfidence)} / {pct(r.entityConfidence)}
                </td>
                <td data-label="Updated">{when(r.updatedAt)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={6}>No reviews match.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={page} pages={Math.ceil(total / PAGE)} base={`/admin/reviews${qs ? `?${qs}` : ""}`} />
    </>
  );
}
