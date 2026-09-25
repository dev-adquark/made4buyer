import type { Metadata } from "next";
import { redirect } from "next/navigation";
import AdminNav from "@/components/admin-nav";
import { getAdminSession } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: { default: "Admin", template: "%s · Admin" }, robots: { index: false, follow: false } };

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession();
  if (!session) redirect("/admin/login");
  return (
    <div className="admin-shell">
      <AdminNav email={session.email} />
      <main className="admin-main">{children}</main>
    </div>
  );
}
