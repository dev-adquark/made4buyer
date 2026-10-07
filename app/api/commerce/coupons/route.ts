import { adminJsonGet } from "@/lib/admin/api";
import { listCommerceCoupons, pageCount, parsePaging, slugToken, statusToken } from "@/lib/commerce/admin-queries";

export const dynamic = "force-dynamic";

/** GET /api/commerce/coupons?page&limit(≤100)&status&brand(slug) — admin only. */
export const GET = adminJsonGet(async ({ url }) => {
  const q = url.searchParams;
  const paging = parsePaging((k) => q.get(k));
  const filter = { status: statusToken(q.get("status")), brandSlug: slugToken(q.get("brand")) };
  const { total, items } = await listCommerceCoupons(filter, paging);
  return { page: paging.page, limit: paging.limit, total, pages: pageCount(total, paging.limit), filter, items };
});
