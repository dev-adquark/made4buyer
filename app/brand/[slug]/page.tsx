import type { Metadata } from "next";
import { notFound } from "next/navigation";
import LogoChip from "@/components/brand-logo-chip";
import Breadcrumbs, { breadcrumbJsonLd } from "@/components/breadcrumbs";
import JsonLd from "@/components/json-ld";
import { displayText } from "@/lib/public/display";
import { ReviewGrid } from "@/components/review-card";
import { brandLogoMap, lookupLogo } from "@/lib/commerce/brand-logo-public";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { brandPageEligible, cardSelect, LATEST_FIRST } from "@/lib/public/queries";

/**
 * Cached on first request (nothing is prebuilt, so builds never need the database); regenerated
 * at most every 5 minutes and purged when one of the brand's reviews is published or changes.
 */
export const revalidate = 300;

export function generateStaticParams(): Array<{ slug: string }> {
  return [];
}

/** Brand hub pages exist only when a brand has enough published reviews (no thin pages). */
async function load(slug: string) {
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) return null;
  const { eligible } = await brandPageEligible(slug);
  if (!eligible) return null;
  const reviews = await db.normalizedReview.findMany({ where: { status: "PUBLISHED", brandSlug: slug }, orderBy: LATEST_FIRST, take: 60, select: cardSelect });
  // The brand's stored name; the slug is only a last resort (never "null" or an empty name).
  return { brand: reviews.map((r) => displayText(r.brand)).find(Boolean) ?? slug, reviews };
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const data = await load(slug);
  if (!data) return { title: "Brand not found", robots: { index: false } };
  return { title: `${data.brand} reviews`, description: `All published ${data.brand} reviews on Made4Buyers.`, alternates: { canonical: `/brand/${slug}` } };
}

export default async function BrandPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await load(slug);
  if (!data) notFound();
  const crumbs = [{ name: "Home", href: "/" }, { name: data.brand, href: `/brand/${slug}` }];
  // The commerce brand's verified official logo, matched by slug, else by a unique brand name.
  const logo = lookupLogo(await brandLogoMap(), slug, data.brand);
  return (
    <main>
      <JsonLd data={breadcrumbJsonLd(crumbs, config.siteUrl())} />
      <section className="page-hero">
        <div className="wrap">
          <Breadcrumbs items={crumbs} />
          <h1>
            {logo && <LogoChip logo={logo} name={data.brand} height={32} />}
            {data.brand} reviews
          </h1>
          <p className="lede">{data.reviews.length === 1 ? "1 published review" : `${data.reviews.length} published reviews and guides`} of {data.brand} products.</p>
        </div>
      </section>
      <section className="section">
        <div className="wrap">
          <ReviewGrid reviews={data.reviews} eagerCount={3} headingLevel={2} />
        </div>
      </section>
    </main>
  );
}
