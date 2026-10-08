"use client";

import Link from "next/link";
import { useState } from "react";
import SafeImg from "./safe-img";

export type CompareColumn = { id: string; slug: string; name: string; image: string; alternates?: string[]; fallback: string; categoryName: string; facts: Record<string, string | null> };
export type CompareSection = { title: string; rows: string[] };

/**
 * Comparison board: sticky product headers, collapsible sections, rows whose known values
 * differ are marked "Differs". A row no product has a value for is left out; a value one product
 * lacks is marked "Not stated", never guessed.
 */
export default function CompareTable({ columns, sections, removeHref, addSlot }: { columns: CompareColumn[]; sections: CompareSection[]; removeHref: Record<string, string>; addSlot?: React.ReactNode }) {
  const [onlyDiff, setOnlyDiff] = useState(false);
  const cols = { "--cols": columns.length } as React.CSSProperties;
  const differs = (label: string) => {
    const known = columns.map((c) => c.facts[label]).filter((v): v is string => Boolean(v));
    return known.length > 1 && new Set(known).size > 1;
  };
  const diffCount = sections.flatMap((s) => s.rows).filter(differs).length;
  return (
    <>
      <div className="compare-toolbar">
        <p className="muted" style={{ margin: 0 }} aria-live="polite">
          {diffCount === 1 ? "1 fact differs" : `${diffCount} facts differ`} between these products.
        </p>
        <label className="check">
          <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} />
          Show only differences
        </label>
      </div>
      <section className="compare-shell" aria-label={`Comparing ${columns.map((c) => c.name).join(", ")}`}>
        <div className="compare-head" style={cols}>
          <div>
            <span className="small muted">{columns.length} of 3 products</span>
          </div>
          {columns.map((c) => (
            <div key={c.id}>
              <SafeImg src={c.image} alternates={c.alternates} fallback={c.fallback} alt="" width={180} height={112} loading="lazy" />
              <Link className="name" href={`/review/${c.slug}`}>
                {c.name}
              </Link>
              {c.categoryName && <span className="small muted">{c.categoryName}</span>}
              <div>
                <Link className="btn small remove" href={removeHref[c.id]}>
                  Remove<span className="visually-hidden"> {c.name}</span>
                </Link>
              </div>
            </div>
          ))}
        </div>
        {sections.map((s) => {
          // A row with no value for any product says nothing: leave it out.
          const known = s.rows.filter((label) => columns.some((c) => c.facts[label]));
          const rows = onlyDiff ? known.filter(differs) : known;
          if (!rows.length) return null;
          return (
            <details key={s.title} className="compare-section" open>
              <summary>{s.title}</summary>
              <div>
                {rows.map((label) => (
                  <div key={label} className={`compare-row${differs(label) ? " differs" : ""}`} style={cols}>
                    <div>{label}</div>
                    {columns.map((c) => (
                      <div key={c.id}>
                        <span className="visually-hidden">{c.name}: </span>
                        {c.facts[label] || <span className="na">Not stated</span>}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </details>
          );
        })}
      </section>
      {addSlot}
    </>
  );
}
