import type { Metadata } from "next";
import Breadcrumbs from "@/components/breadcrumbs";
import CompareSelector from "@/components/compare-selector";
import CompareTable, { type CompareColumn, type CompareSection } from "@/components/compare-table";
import TrackOnce from "@/components/track-once";
import { db } from "@/lib/db";
import { LATEST_FIRST } from "@/lib/public/queries";
import { placeholderPath, publicImageUrl } from "@/lib/pipeline/images";
import { verifiedDeals } from "@/lib/pipeline/render-model";
import { categoryName, subcategoryName } from "@/lib/taxonomy/definitions";
import { availabilityLabel, money, shortDate } from "@/lib/util/format";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Compare products", robots: { index: false, follow: true }, alternates: { canonical: "/compare" } };

const SECTIONS: CompareSection[] = [
  { title: "Overview", rows: ["Brand", "Category", "Type", "Model"] },
  { title: "Who it’s for", rows: ["Best for", "Platform", "Price tier"] },
  { title: "Verified offer", rows: ["Verified offer", "Price", "Merchant", "Availability", "Link last checked"] },
];

export default async function ComparePage({ searchParams }: { searchParams: Promise<{ ids?: string }> }) {
  const { ids: raw } = await searchParams;
  const ids = [...new Set((raw ?? "").split(",").map((x) => x.trim()).filter((x) => /^[a-z0-9]{10,40}$/i.test(x)))].slice(0, 3);
  const [selectedRaw, options] = await Promise.all([
    ids.length
      ? db.normalizedReview.findMany({
          where: { id: { in: ids }, status: "PUBLISHED" },
          include: {
            entities: true,
            images: { where: { isPrimary: true }, take: 1 },
            assignments: { where: { active: true, tagType: { in: ["PRICE_TIER", "INTENT", "PLATFORM"] } }, include: { categoryTag: { select: { name: true } } }, orderBy: [{ isPrimary: "desc" }, { confidence: "desc" }] },
          },
        })
      : Promise.resolve([]),
    db.normalizedReview.findMany({ where: { status: "PUBLISHED" }, orderBy: LATEST_FIRST, take: 60, select: { id: true, slug: true, canonicalTitle: true, productName: true, brand: true, categorySlug: true } }),
  ]);
  const selected = ids.map((id) => selectedRaw.find((r) => r.id === id)).filter((r): r is (typeof selectedRaw)[number] => Boolean(r));
  const deals = await Promise.all(selected.map((r) => verifiedDeals(r.id)));
  const columns: CompareColumn[] = selected.map((r, i) => {
    const best = deals[i].find((d) => d.isBest) ?? deals[i][0];
    const tags = (type: string) => r.assignments.filter((a) => a.tagType === type).map((a) => a.categoryTag.name);
    return {
      id: r.id,
      slug: r.slug,
      name: r.productName,
      image: publicImageUrl(r.images[0], r.categorySlug).url,
      fallback: placeholderPath(r.categorySlug),
      categoryName: categoryName(r.categorySlug) ?? "Technology",
      facts: {
        Brand: r.brand,
        Category: categoryName(r.categorySlug) ?? null,
        Type: subcategoryName(r.categorySlug, r.subcategorySlug) ?? r.entities?.deviceType ?? null,
        Model: r.entities?.modelNumber ?? null,
        "Best for": tags("INTENT").slice(0, 3).join(", ") || r.entities?.useCase || null,
        Platform: tags("PLATFORM").slice(0, 3).join(", ") || r.entities?.platform || null,
        "Price tier": tags("PRICE_TIER")[0] ?? null,
        "Verified offer": best ? "Yes" : "No verified offer currently available",
        Price: best ? money(best.price, best.currency) : null,
        Merchant: best?.merchant ?? null,
        Availability: best ? availabilityLabel(best.availability) : null,
        "Link last checked": best ? shortDate(best.verifiedAt) : null,
      },
    };
  });
  const removeHref = Object.fromEntries(columns.map((c) => [c.id, `/compare${columns.length > 1 ? `?ids=${columns.filter((x) => x.id !== c.id).map((x) => x.id).join(",")}` : ""}`]));
  const pickerItems = options.map((o) => ({ id: o.id, slug: o.slug, title: o.canonicalTitle, productName: o.productName, brand: o.brand, categoryName: categoryName(o.categorySlug) ?? null }));

  return (
    <main>
      <section className="page-hero">
        <div className="wrap">
          <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Compare", href: "/compare" }]} />
          <h1>Compare products</h1>
          <p className="lede">Side by side, using only stored review data and verified offers. Anything we don’t know is marked as not available.</p>
        </div>
      </section>
      <section className="section">
        <div className="wrap">
          {columns.length >= 2 && (
            <>
              <TrackOnce event="comparison" metadata={{ ids: columns.map((c) => c.id) }} categorySlug={selected[0].categorySlug} />
              <CompareTable columns={columns} sections={SECTIONS} removeHref={removeHref} />
            </>
          )}
          {columns.length === 1 && (
            <p className="notice" role="status">
              {columns[0].name} is ready. Add at least one more product to compare.
            </p>
          )}
          <CompareSelector key={ids.join(",")} items={pickerItems} initial={selected.map((s) => s.id)} heading={columns.length >= 2 ? (columns.length < 3 ? "Add or swap products" : "Swap products") : "Pick up to three products"} />
        </div>
      </section>
    </main>
  );
}
