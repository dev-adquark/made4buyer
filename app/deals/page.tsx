import type { Metadata } from "next";
import Link from "next/link";
import Breadcrumbs from "@/components/breadcrumbs";
import EmptyState from "@/components/empty-state";
import { ReviewGrid } from "@/components/review-card";
import { reviewsWithDeals } from "@/lib/public/queries";
import { CATEGORIES, CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";
import { themeStyle } from "@/lib/taxonomy/themes";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Verified deals", description: "Reviewed products with an offer link we have checked.", alternates: { canonical: "/deals" } };

export default async function Deals({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
  const { category } = await searchParams;
  const active = category && CATEGORY_BY_SLUG.has(category) ? category : undefined;
  const [deals, all] = await Promise.all([reviewsWithDeals(60, active), active ? reviewsWithDeals(200) : Promise.resolve(null)]);
  const counts = new Map<string, number>();
  for (const r of all ?? deals) if (r.categorySlug) counts.set(r.categorySlug, (counts.get(r.categorySlug) ?? 0) + 1);
  return (
    <main>
      <section className="cat-hero" style={themeStyle(active) as React.CSSProperties}>
        <div className="container">
          <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Verified deals", href: "/deals" }]} />
          <h1>Verified deals</h1>
          <p className="lede">Only offers whose link we followed to the retailer and confirmed. Prices and availability are the retailer’s and can change.</p>
          <nav aria-label="Filter deals by category">
            <ul className="chips">
              <li>
                <Link className="chip neutral" href="/deals" aria-current={!active ? "true" : undefined}>
                  All
                </Link>
              </li>
              {CATEGORIES.filter((c) => counts.get(c.slug)).map((c) => (
                <li key={c.slug} style={themeStyle(c.slug) as React.CSSProperties}>
                  <Link className="chip neutral" href={`/deals?category=${c.slug}`} aria-current={active === c.slug ? "true" : undefined}>
                    {c.name} ({counts.get(c.slug)})
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </section>
      <section className="section">
        <div className="container">
          {deals.length ? (
            <ReviewGrid reviews={deals} eagerCount={3} headingLevel={2} />
          ) : (
            <EmptyState title="No verified offer is available right now." action={<Link className="btn" href="/reviews">Browse all reviews</Link>}>
              We list a deal only after checking its link. Reviews without a verified offer are still available.
            </EmptyState>
          )}
        </div>
      </section>
    </main>
  );
}
