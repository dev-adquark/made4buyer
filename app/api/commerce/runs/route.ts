import { adminJsonGet } from "@/lib/admin/api";
import { listRuns, pageCount, parsePaging, slugToken, statusToken } from "@/lib/commerce/admin-queries";

export const dynamic = "force-dynamic";

/** GET /api/commerce/runs?page&limit(≤100)&status&purpose&brand(slug) — admin only. */
export const GET = adminJsonGet(async ({ url }) => {
  const q = url.searchParams;
  const paging = parsePaging((k) => q.get(k));
  const filter = { status: statusToken(q.get("status")), purpose: statusToken(q.get("purpose")), brandSlug: slugToken(q.get("brand")) };
  const { total, items } = await listRuns(filter, paging);
  return { page: paging.page, limit: paging.limit, total, pages: pageCount(total, paging.limit), filter, items };
});
