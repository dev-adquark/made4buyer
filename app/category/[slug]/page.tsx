import type { Prisma, TagType } from "@prisma/client";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Breadcrumbs, { breadcrumbJsonLd, type Crumb } from "@/components/breadcrumbs";
import JsonLd from "@/components/json-ld";
import ReviewCard from "@/components/review-card";
import SponsoredSlot from "@/components/sponsored-slot";
import TrackOnce from "@/components/track-once";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { cardSelect, categoryCounts } from "@/lib/public/queries";
import { CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 24;
type Search = { sub?: string; intent?: string; platform?: string; tier?: string; page?: string };
const FILTERS: Array<{ key: keyof Search; type: TagType; label: string }> = [
  { key: "sub", type: "SUBCATEGORY", label: "Type" },
  { key: "intent", type: "INTENT", label: "Best for" },
  { key: "platform", type: "PLATFORM", label: "Platform" },
  { key: "tier", type: "PRICE_TIER", label: "Price" },
];

function clean(v?: string) {
  return v && /^[a-z0-9-]{1,60}$/.test(v) ? v : undefined;
}

export async function generateMetadata({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Search> }): Promise<Metadata> {
  const { slug } = await params;
  const sp = await searchParams;
  const def = CATEGORY_BY_SLUG.get(slug);
  if (!def) return { title: "Category not found", robots: { index: false } };
  const count = (await categoryCounts()).find((c) => c.slug === slug)?.count ?? 0;
  const filtered = FILTERS.some((f) => sp[f.key]) || (sp.page && sp.page !== "1");
  return {
    title: `${def.name} reviews`,
    description: `${def.description} Buyer-focused reviews with verified offers.`,
    alternates: { canonical: `/category/${slug}` },
    openGraph: { title: `${def.name} reviews`, description: def.description, url: `/category/${slug}` },
    // Empty or filtered listing pages are not indexed (avoids thin/duplicate pages).
    robots: count === 0 || filtered ? { index: false, follow: true } : undefined,
  };
}

export default async function CategoryPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Search> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const def = CATEGORY_BY_SLUG.get(slug);
  if (!def) notFound();

  const active = Object.fromEntries(FILTERS.map((f) => [f.key, clean(sp[f.key])])) as Record<string, string | undefined>;
  const page = Math.max(1, Math.min(500, Number(sp.page) || 1));
  const where: Prisma.NormalizedReviewWhereInput = {
    status: "PUBLISHED",
    categorySlug: slug,
    ...(active.sub ? { subcategorySlug: active.sub } : {}),
    AND: FILTERS.filter((f) => f.key !== "sub" && active[f.key]).map((f) => ({ assignments: { some: { active: true, tagType: f.type, categoryTag: { slug: active[f.key]! } } } })),
  };

  const [total, reviews, facetRows, counts] = await Promise.all([
    db.normalizedReview.count({ where }),
    db.normalizedReview.findMany({ where, orderBy: [{ publishedAt: "desc" }, { id: "asc" }], skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE, select: cardSelect }),
    db.reviewCategoryAssignment.findMany({
      where: { active: true, tagType: { in: FILTERS.map((f) => f.type) }, review: { status: "PUBLISHED", categorySlug: slug } },
      distinct: ["categoryTagId"],
      select: { tagType: true, categoryTag: { select: { slug: true, name: true, sortOrder: true } } },
    }),
    categoryCounts(),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hrefWith = (key: string, value?: string) => {
    const q = new URLSearchParams();
    for (const f of FILTERS) {
      const v = f.key === key ? value : active[f.key];
      if (v) q.set(f.key, v);
    }
    const s = q.toString();
    return `/category/${slug}${s ? `?${s}` : ""}`;
  };
  const crumbs: Crumb[] = [{ name: "Home", href: "/" }, { name: def.name, href: `/category/${slug}` }];
  const others = counts.filter((c) => c.slug !== slug && c.count > 0);

  return (
    <main className="section">
      <JsonLd data={breadcrumbJsonLd(crumbs, config.siteUrl())} />
      <TrackOnce event="category_view" categorySlug={slug} metadata={{ filters: active }} />
      <div className="container">
        <Breadcrumbs items={crumbs} />
        <div className="eyebrow">Category</div>
        <h1>{def.name}</h1>
        <p className="muted">{def.description}</p>
        <SponsoredSlot position="CATEGORY_TOP" categorySlug={slug} />
        {FILTERS.map((f) => {
          const options = facetRows.filter((r) => r.tagType === f.type).sort((a, b) => a.categoryTag.sortOrder - b.categoryTag.sortOrder || a.categoryTag.name.localeCompare(b.categoryTag.name));
          if (!options.length) return null;
          return (
            <nav key={f.key} aria-label={`Filter by ${f.label.toLowerCase()}`}>
              <ul className="chips">
                <li className="small muted" style={{ alignSelf: "center", fontWeight: 700 }}>
                  {f.label}:
                </li>
                <li>
                  <Link className="chip neutral" href={hrefWith(f.key)} aria-current={!active[f.key] ? "true" : undefined}>
                    All
                  </Link>
                </li>
                {options.map((o) => (
                  <li key={o.categoryTag.slug}>
                    <Link className="chip neutral" href={hrefWith(f.key, o.categoryTag.slug)} aria-current={active[f.key] === o.categoryTag.slug ? "true" : undefined}>
                      {o.categoryTag.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          );
        })}
        <p className="small muted" aria-live="polite">
          {total === 1 ? "1 review" : `${total} reviews`}
        </p>
        {reviews.length ? (
          <div className="grid">
            {reviews.map((r, i) => (
              <ReviewCard key={r.id} review={r} eager={i < 3} />
            ))}
          </div>
        ) : (
          <p className="notice">No published reviews match{FILTERS.some((f) => active[f.key]) ? " these filters" : " yet"}. Reviews appear once they pass editorial QA.</p>
        )}
        {pages > 1 && (
          <nav className="pagination" aria-label="Pagination">
            {page > 1 ? <Link className="btn" href={`${hrefWith("")}${hrefWith("").includes("?") ? "&" : "?"}page=${page - 1}`}>Previous</Link> : null}
            <span className="muted">
              Page {page} of {pages}
            </span>
            {page < pages ? <Link className="btn" href={`${hrefWith("")}${hrefWith("").includes("?") ? "&" : "?"}page=${page + 1}`}>Next</Link> : null}
          </nav>
        )}
        {others.length > 0 && (
          <nav aria-labelledby="other-cats">
            <h2 id="other-cats">Other categories</h2>
            <ul className="chips">
              {others.map((c) => (
                <li key={c.slug}>
                  <Link className="chip" href={`/category/${c.slug}`}>
                    {c.name}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </div>
    </main>
  );
}
