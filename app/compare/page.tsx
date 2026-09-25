import type { Metadata } from "next";
import Link from "next/link";
import CompareSelector from "@/components/compare-selector";
import TrackOnce from "@/components/track-once";
import { db } from "@/lib/db";
import { verifiedDeals } from "@/lib/pipeline/render-model";
import { categoryName, subcategoryName } from "@/lib/taxonomy/definitions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Compare products", robots: { index: false, follow: true }, alternates: { canonical: "/compare" } };

export default async function ComparePage({ searchParams }: { searchParams: Promise<{ ids?: string }> }) {
  const { ids: raw } = await searchParams;
  const ids = (raw ?? "").split(",").map((x) => x.trim()).filter((x) => /^[a-z0-9]{10,40}$/i.test(x)).slice(0, 3);
  const [selected, options] = await Promise.all([
    ids.length ? db.normalizedReview.findMany({ where: { id: { in: ids }, status: "PUBLISHED" }, include: { entities: true } }) : Promise.resolve([]),
    db.normalizedReview.findMany({ where: { status: "PUBLISHED" }, orderBy: { publishedAt: "desc" }, take: 48, select: { id: true, slug: true, canonicalTitle: true, productName: true, brand: true } }),
  ]);
  const deals = await Promise.all(selected.map((r) => verifiedDeals(r.id)));
  const rows: Array<[string, (i: number) => string]> = [
    ["Brand", (i) => selected[i].brand ?? "—"],
    ["Category", (i) => categoryName(selected[i].categorySlug) ?? "—"],
    ["Type", (i) => subcategoryName(selected[i].categorySlug, selected[i].subcategorySlug) ?? selected[i].entities?.deviceType ?? "—"],
    ["Platform", (i) => selected[i].entities?.platform ?? "—"],
    ["Model", (i) => selected[i].entities?.modelNumber ?? "—"],
    ["Best for", (i) => selected[i].entities?.useCase ?? "—"],
    ["Verified offers", (i) => String(deals[i].length)],
  ];
  return (
    <main className="section">
      <div className="container">
        <h1>Compare products</h1>
        <p className="muted">Side-by-side comparison using only stored review data and verified offers.</p>
        {selected.length >= 2 && (
          <>
            <TrackOnce event="comparison" metadata={{ ids: selected.map((s) => s.id) }} categorySlug={selected[0].categorySlug} />
            <div className="table-wrap">
              <table className="table">
                <caption>Comparison of {selected.map((s) => s.productName).join(", ")}</caption>
                <thead>
                  <tr>
                    <th scope="col">Attribute</th>
                    {selected.map((s) => (
                      <th scope="col" key={s.id}>
                        <Link href={`/review/${s.slug}`}>{s.productName}</Link>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(([label, get]) => (
                    <tr key={label}>
                      <th scope="row">{label}</th>
                      {selected.map((s, i) => (
                        <td key={s.id}>{get(i)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {selected.length === 1 && <p className="notice">Select at least one more product to compare.</p>}
        <CompareSelector items={options.map((o) => ({ id: o.id, slug: o.slug, title: o.canonicalTitle, productName: o.productName, brand: o.brand }))} initial={selected.map((s) => s.id)} />
      </div>
    </main>
  );
}
