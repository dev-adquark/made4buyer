"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS: Array<[string, string]> = [
  ["/admin", "Overview"],
  ["/admin/qa", "Content status"],
  ["/admin/reviews", "All reviews"],
  ["/admin/entities", "Entities"],
  ["/admin/products", "Product data"],
  // Commerce: overview, then Sources (the brand registry; /admin/commerce/brands forwards there), Products, Deals, Coupons, Runs.
  ["/admin/commerce", "Commerce engine"],
  ["/admin/commerce/sources", "Commerce sources"],
  ["/admin/commerce/products", "Commerce products"],
  ["/admin/commerce/deals", "Commerce deals"],
  ["/admin/commerce/coupons", "Coupons"],
  ["/admin/commerce/runs", "Commerce runs"],
  ["/admin/guides", "AI guides"],
  ["/admin/coverage", "Coverage & calendar"],
  ["/admin/automation", "Automation"],
  ["/admin/keywords", "Keywords"],
  ["/admin/sources", "Sources"],
  ["/admin/ingestion", "Ingestion"],
  ["/admin/categorization", "Categorization"],
  ["/admin/deals", "Deals"],
  ["/admin/links", "Retailer links"],
  ["/admin/images", "Images"],
  ["/admin/csv", "CSV import"],
  ["/admin/analytics", "Analytics"],
  ["/admin/sponsored", "Sponsored"],
  ["/admin/reports", "Day-30 report"],
  ["/admin/jobs", "Jobs & runs"],
  ["/admin/schedules", "Schedules"],
  ["/admin/failures", "Failures"],
  ["/admin/data-audit", "Data audit"],
  ["/admin/audit", "Audit log"],
  ["/admin/gsc", "Search Console"],
  ["/admin/go-live", "Go-live checks"],
];

const EXACT = new Set(["/admin", "/admin/reviews", "/admin/commerce"]);

export default function AdminNav({ email }: { email: string }) {
  const path = usePathname();
  return (
    <nav className="admin-nav" aria-label="Admin">
      <ul>
        {LINKS.map(([href, label]) => {
          // Section roots that have their own nested entries match exactly; others match their subtree.
          const current = EXACT.has(href) ? path === href : path === href || path.startsWith(`${href}/`);
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
