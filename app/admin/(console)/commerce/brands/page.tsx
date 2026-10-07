import { redirect } from "next/navigation";
import { requireAdminPage, type SearchParams } from "@/lib/admin/guard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Commerce brands" };

/**
 * Brands are edited in the source registry (Admin → Commerce → Sources), the one brand editor.
 * This address keeps working: it forwards its filters, ?edit= and flash messages there.
 */
export default async function CommerceBrandsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminPage();
  const sp = await searchParams;
  const q = new URLSearchParams();
  for (const k of ["enabled", "category", "q", "edit", "ok", "error"]) {
    const v = sp[k];
    const s = Array.isArray(v) ? v[0] : v;
    if (s) q.set(k, s.slice(0, 300));
  }
  const qs = q.toString();
  redirect(`/admin/commerce/sources${qs ? `?${qs}` : ""}${q.has("edit") ? "#edit" : ""}`);
}
