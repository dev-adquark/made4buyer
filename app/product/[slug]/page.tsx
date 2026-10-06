import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import Breadcrumbs, { breadcrumbJsonLd } from "@/components/breadcrumbs";
import EmptyState from "@/components/empty-state";
import JsonLd from "@/components/json-ld";
import { ReviewGrid } from "@/components/review-card";
import SectionHeader from "@/components/section-header";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { displayText } from "@/lib/public/display";
import { cardSelect, LATEST_FIRST } from "@/lib/public/queries";
import { categoryName, subcategoryName } from "@/lib/taxonomy/definitions";
import { themeStyle } from "@/lib/taxonomy/themes";

/**
 * Cached on first request (nothing is prebuilt, so builds never need the database); regenerated
 * at most every 5 minutes and purged when linked content is published or changes.
 */
export const revalidate = 300;

export function generateStaticParams(): Array<{ slug: string }> {
  return [];
}

/** Product/service hub: everything published about one entity, built from content ↔ entity links. */
const load = cache(async (slug: string) => {
  if (!/^[a-z0-9-]{1,90}$/.test(slug)) return null;
  const entity = await db.productEntity.findUnique({ where: { slug } });
  if (!entity) return null;
  const content = await db.normalizedReview.findMany({
    where: {
      status: "PUBLISHED",
      contentEntities: { some: { productEntityId: entity.id } },
    },
    orderBy: LATEST_FIRST,
    take: 60,
    select: cardSelect,
  });
  // Products this one is compared with, ranked by how often.
  const peers = await db.contentEntity.groupBy({
    by: ["productEntityId"],
    where: {
      productEntityId: { not: entity.id },
      review: {
        status: "PUBLISHED",
        kind: "COMPARISON",
        contentEntities: { some: { productEntityId: entity.id } },
      },
    },
    _count: { _all: true },
    orderBy: { _count: { productEntityId: "desc" } },
    take: 12,
  });
  const peerEntities = peers.length
    ? await db.productEntity.findMany({
        where: { id: { in: peers.map((p) => p.productEntityId) } },
        select: { id: true, name: true, slug: true },
      })
    : [];
  const comparedWith = peers.flatMap((p) =>
    peerEntities.filter((e) => e.id === p.productEntityId),
  );
  return { entity, content, comparedWith };
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const data = await load(slug);
  if (!data) return { title: "Product not found", robots: { index: false } };
  const { entity, content } = data;
  return {
    title: `${entity.name}: reviews, comparisons and guides`,
    description: `Everything Made4Buyers has filed about ${entity.name}${entity.brand && !entity.name.startsWith(entity.brand) ? ` by ${entity.brand}` : ""}: source reviews, comparisons and buying guides.`,
    alternates: { canonical: `/product/${slug}` },
    // No published content yet: a thin page, not indexed.
    robots: content.length ? undefined : { index: false, follow: true },
  };
}

export default async function ProductPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const data = await load(slug);
  if (!data) notFound();
  const { entity, content, comparedWith } = data;
  const reviews = content.filter((c) => c.kind === "REVIEW");
  const comparisons = content.filter((c) => c.kind === "COMPARISON");
  const guides = content.filter(
    (c) => c.kind === "BUYING_GUIDE" || c.kind === "AI_GUIDE",
  );
  const cat = entity.categorySlug;
  const aliases = entity.aliases.map((a) => displayText(a)).filter((a): a is string => Boolean(a) && a !== entity.name);
  const crumbs = [
    { name: "Home", href: "/" },
    ...(cat
      ? [{ name: categoryName(cat) ?? cat, href: `/category/${cat}` }]
      : []),
    { name: entity.name, href: `/product/${slug}` },
  ];
  return (
    <main style={themeStyle(cat) as React.CSSProperties}>
      <JsonLd data={breadcrumbJsonLd(crumbs, config.siteUrl())} />
      <section className="page-hero">
        <div className="wrap">
          <Breadcrumbs items={crumbs} />
          <h1>{entity.name}</h1>
          <p className="lede">
            {[
              displayText(entity.brand) && !entity.name.startsWith(entity.brand!)
                ? `By ${entity.brand}.`
                : null,
              cat
                ? `Filed under ${categoryName(cat)}${entity.subcategorySlug ? ` → ${subcategoryName(cat, entity.subcategorySlug) ?? entity.subcategorySlug}` : ""}.`
                : null,
              content.length
                ? `${content.length} published ${content.length === 1 ? "piece" : "pieces"} about it.`
                : "Nothing published about it yet.",
            ]
              .filter(Boolean)
              .join(" ")}
          </p>
          {aliases.length > 0 && (
            <p className="small muted">
              Also written as: {aliases.join(", ")}
            </p>
          )}
        </div>
      </section>
      {!content.length && (
        <section className="section">
          <div className="wrap">
            <EmptyState
              title={`Nothing published about ${entity.name} yet.`}
              headingLevel={2}
              action={
                cat ? (
                  <Link className="btn" href={`/category/${cat}`}>
                    Browse {categoryName(cat)}
                  </Link>
                ) : (
                  <Link className="btn" href="/reviews">
                    Browse all reviews
                  </Link>
                )
              }
            >
              It appears in an article that is still in editorial QA.
            </EmptyState>
          </div>
        </section>
      )}
      {[
        ["Reviews", reviews],
        ["Comparisons", comparisons],
        ["Guides", guides],
      ].map(([label, rows]) =>
        (rows as typeof content).length ? (
          <section
            className="section"
            key={label as string}
            aria-labelledby={`p-${label}`}
          >
            <div className="wrap">
              <SectionHeader
                id={`p-${label}`}
                label={`${(rows as typeof content).length}`}
                title={`${label} of ${entity.name}`}
              />
              <ReviewGrid reviews={rows as typeof content} headingLevel={3} />
            </div>
          </section>
        ) : null,
      )}
      {comparedWith.length > 0 && (
        <section className="section" aria-labelledby="p-peers">
          <div className="wrap">
            <SectionHeader
              id="p-peers"
              label="Compared with"
              title={`Products compared with ${entity.name}`}
            />
            <ul className="entity-list">
              {comparedWith.map((p) => (
                <li key={p.slug}>
                  <Link href={`/product/${p.slug}`}>{p.name}</Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </main>
  );
}
