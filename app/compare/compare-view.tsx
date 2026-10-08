import type { Metadata } from "next";
import Breadcrumbs from "@/components/breadcrumbs";
import CompareSelector from "@/components/compare-selector";
import CompareTable, { type CompareColumn, type CompareSection } from "@/components/compare-table";
import TrackOnce from "@/components/track-once";
import { db } from "@/lib/db";
import { LATEST_FIRST, resolveCardImage } from "@/lib/public/queries";
import { placeholderPath } from "@/lib/pipeline/images";
import { freshOffersForReview } from "@/lib/public/offers";
import { categoryName, subcategoryName } from "@/lib/taxonomy/definitions";
import { displayText, displayUrl } from "@/lib/public/display";
import { availabilityLabel, money, shortDate } from "@/lib/util/format";

/*
 * Rendered by page.tsx (the product picker, cached) and q/page.tsx (`?ids=`, rewritten there by
 * proxy.ts; per request, because the table shows live prices).
 */

export const compareMetadata: Metadata = { title: "Compare products", description: "Put two reviewed products side by side: specs, verdicts and recently checked prices from the reviews we publish.", robots: { index: false, follow: true }, alternates: { canonical: "/compare" } };

const SECTIONS: CompareSection[] = [
  { title: "Overview", rows: ["Brand", "Category", "Type", "Model"] },
  { title: "Who it’s for", rows: ["Best for", "Platform", "Price tier"] },
  { title: "Current price", rows: ["Price", "Seller", "Availability", "Price last checked"] },
];

/** The comparison for up to three product ids (validated: lib/public/listing-routes.ts parseCompareIds). */
export async function CompareView({ ids }: { ids: string[] }) {
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
  const [deals, images] = await Promise.all([Promise.all(selected.map((r) => freshOffersForReview(r.id))), Promise.all(selected.map((r) => resolveCardImage(r)))]);
  const columns: CompareColumn[] = selected.map((r, i) => {
    const best = deals[i].find((d) => money(d.price, d.currency) !== null && displayUrl(d.url));
    const tags = (type: string) => r.assignments.filter((a) => a.tagType === type).map((a) => a.categoryTag.name);
    return {
      id: r.id,
      slug: r.slug,
      name: r.productName,
      // Same chain as the review page and cards: a relevant, working image, else the category's photo.
      image: images[i].url,
      alternates: images[i].alternates,
      fallback: placeholderPath(r.categorySlug),
      categoryName: categoryName(r.categorySlug) ?? "",
      facts: {
        Brand: displayText(r.brand),
        Category: categoryName(r.categorySlug) ?? null,
        Type: displayText(subcategoryName(r.categorySlug, r.subcategorySlug)) ?? displayText(r.entities?.deviceType),
        Model: displayText(r.entities?.modelNumber),
        "Best for": displayText(tags("INTENT").slice(0, 3).join(", ")) ?? displayText(r.entities?.useCase),
        Platform: displayText(tags("PLATFORM").slice(0, 3).join(", ")) ?? displayText(r.entities?.platform),
        "Price tier": displayText(tags("PRICE_TIER")[0]),
        // A fresh, verified price or nothing (the row is left out when no product has one).
        Price: best ? money(best.price, best.currency) : null,
        Seller: best ? displayText(best.seller) : null,
        Availability: best ? availabilityLabel(best.availability) : null,
        "Price last checked": best ? shortDate(best.observedAt) : null,
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
          <p className="lede">Side by side, using only stored review data and recently checked prices. Anything we don’t know is marked as not stated.</p>
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
