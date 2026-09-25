"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS: Array<[string, string]> = [
  ["/admin", "Overview"],
  ["/admin/qa", "QA queue"],
  ["/admin/reviews", "All reviews"],
  ["/admin/entities", "Entities"],
  ["/admin/ingestion", "Ingestion"],
  ["/admin/categorization", "Categorization"],
  ["/admin/deals", "Deals"],
  ["/admin/links", "Link health"],
  ["/admin/images", "Images"],
  ["/admin/csv", "CSV import"],
  ["/admin/analytics", "Analytics"],
  ["/admin/sponsored", "Sponsored"],
  ["/admin/reports", "Day-30 report"],
  ["/admin/jobs", "Jobs & runs"],
  ["/admin/failures", "Failures"],
  ["/admin/audit", "Audit log"],
  ["/admin/gsc", "Search Console"],
];

export default function AdminNav({ email }: { email: string }) {
  const path = usePathname();
  return (
    <nav className="admin-nav" aria-label="Admin">
      <ul>
        {LINKS.map(([href, label]) => {
          const current = href === "/admin" ? path === "/admin" : href === "/admin/reviews" ? path === "/admin/reviews" : path.startsWith(href);
          return (
            <li key={href}>
              <Link href={href} aria-current={current ? "page" : undefined}>
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="small muted" style={{ marginTop: 16, padding: "0 10px" }}>
        Signed in as {email}
      </div>
      <form action="/api/admin/logout" method="post" style={{ padding: "8px 10px" }}>
        <button className="btn small" type="submit">
          Sign out
        </button>
      </form>
    </nav>
  );
}
