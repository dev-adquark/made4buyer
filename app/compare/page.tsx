import type { Metadata } from "next";
import CompareSelector from "@/components/compare-selector";
import CompareTable, { type CompareColumn } from "@/components/compare-table";
import TrackOnce from "@/components/track-once";
import { db } from "@/lib/db";
import { publicImageUrl } from "@/lib/pipeline/images";
import { verifiedDeals } from "@/lib/pipeline/render-model";
import { categoryName, subcategoryName } from "@/lib/taxonomy/definitions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Compare products", robots: { index: false, follow: true }, alternates: { canonical: "/compare" } };

const ROWS = ["Brand", "Category", "Type", "Platform", "Model", "Best for", "Price tier", "Verified offer", "Price (verified offer)"];

function money(price: number | null, currency: string | null) {
  if (price === null) return null;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).format(price);
  } catch {
    return `${price} ${currency ?? ""}`.trim();
  }
}

export default async function ComparePage({ searchParams }: { searchParams: Promise<{ ids?: string }> }) {
  const { ids: raw } = await searchParams;
  const ids = (raw ?? "").split(",").map((x) => x.trim()).filter((x) => /^[a-z0-9]{10,40}$/i.test(x)).slice(0, 3);
  const [selectedRaw, options] = await Promise.all([
    ids.length
      ? db.normalizedReview.findMany({
          where: { id: { in: ids }, status: "PUBLISHED" },
          include: { entities: true, images: { where: { isPrimary: true }, take: 1 }, assignments: { where: { active: true, tagType: "PRICE_TIER", isPrimary: true }, include: { categoryTag: { select: { name: true } } } } },
        })
      : Promise.resolve([]),
    db.normalizedReview.findMany({ where: { status: "PUBLISHED" }, orderBy: { publishedAt: "desc" }, take: 48, select: { id: true, slug: true, canonicalTitle: true, productName: true, brand: true, categorySlug: true } }),
  ]);
  const selected = ids.map((id) => selectedRaw.find((r) => r.id === id)).filter((r): r is (typeof selectedRaw)[number] => Boolean(r));
  const deals = await Promise.all(selected.map((r) => verifiedDeals(r.id)));
  const columns: CompareColumn[] = selected.map((r, i) => {
    const best = deals[i].find((d) => d.isBest) ?? deals[i][0];
    return {
      id: r.id,
      slug: r.slug,
      name: r.productName,
      image: publicImageUrl(r.images[0], r.categorySlug).url,
      categoryName: categoryName(r.categorySlug) ?? "Technology",
      facts: {
        Brand: r.brand,
        Category: categoryName(r.categorySlug) ?? null,
        Type: subcategoryName(r.categorySlug, r.subcategorySlug) ?? r.entities?.deviceType ?? null,
        Platform: r.entities?.platform ?? null,
        Model: r.entities?.modelNumber ?? null,
        "Best for": r.entities?.useCase ?? null,
        "Price tier": r.assignments[0]?.categoryTag.name ?? null,
        "Verified offer": best ? `Yes${best.merchant ? `, ${best.merchant}` : ""}` : "No verified offer",
        "Price (verified offer)": best ? money(best.price, best.currency) : null,
      },
    };
  });
  return (
    <main>
      <section className="cat-hero">
        <div className="container">
          <h1>Compare products</h1>
          <p className="lede">Side by side, using only stored review data and verified offers. Anything we don’t know is marked as not available.</p>
        </div>
      </section>
      <section className="section">
        <div className="container">
          {columns.length >= 2 && (
            <>
              <TrackOnce event="comparison" metadata={{ ids: columns.map((c) => c.id) }} categorySlug={selected[0].categorySlug} />
              <CompareTable columns={columns} rows={ROWS} />
            </>
          )}
          {columns.length === 1 && <p className="notice">Select at least one more product to compare.</p>}
          <CompareSelector items={options.map((o) => ({ id: o.id, slug: o.slug, title: o.canonicalTitle, productName: o.productName, brand: o.brand, categoryName: categoryName(o.categorySlug) ?? null }))} initial={selected.map((s) => s.id)} />
        </div>
      </section>
    </main>
  );
}
