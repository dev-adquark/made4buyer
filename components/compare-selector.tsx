"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

type Item = { id: string; slug: string; title: string; productName: string; brand: string | null; categoryName: string | null };

/** Product picker with search. Selecting builds a /compare?ids= link (max three products). */
export default function CompareSelector({ items, initial, heading = "Pick up to three products" }: { items: Item[]; initial: string[]; heading?: string }) {
  const [selected, setSelected] = useState<string[]>(initial.slice(0, 3));
  const [q, setQ] = useState("");
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 3 ? s : [...s, id]));
  const href = selected.length ? `/compare?ids=${selected.join(",")}` : "/compare";
  const ready = selected.length >= 2;
  const names = selected.map((id) => items.find((i) => i.id === id)?.productName).filter(Boolean);
  const visible = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return items;
    return items.filter((i) => terms.every((t) => `${i.productName} ${i.brand ?? ""} ${i.categoryName ?? ""}`.toLowerCase().includes(t)));
  }, [items, q]);
  return (
    <section aria-labelledby="compare-pick" style={{ marginTop: 28 }}>
      <h2 id="compare-pick">{heading}</h2>
      <div className="panel" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }} role="region" aria-label="Selected products">
        <div aria-live="polite">
          <strong>{selected.length} of 3 selected</strong>
          {names.length > 0 && <div className="small muted">{names.join(", ")}</div>}
        </div>
        {ready ? (
          <Link className="btn primary" href={href}>
            Compare selected
          </Link>
        ) : (
          <button className="btn" type="button" disabled aria-disabled="true" title="Select at least two products">
            Compare selected
          </button>
        )}
      </div>
      {items.length ? (
        <>
          <div className="field" style={{ maxWidth: 420 }}>
            <label htmlFor="compare-filter">Find a product</label>
            <input id="compare-filter" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a product, brand or category" autoComplete="off" />
          </div>
          <ul className="option-grid" aria-label="Products you can compare">
            {visible.map((r) => {
              const checked = selected.includes(r.id);
              return (
                <li key={r.id}>
                  <button type="button" aria-pressed={checked} disabled={!checked && selected.length >= 3} title={!checked && selected.length >= 3 ? "Remove a product first (maximum three)" : undefined} onClick={() => toggle(r.id)}>
                    <strong>{r.productName}</strong>
                    <span>{[r.categoryName, r.brand].filter(Boolean).join(", ") || "Not categorised"}</span>
                    <span>{checked ? "Selected" : "Add to comparison"}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {!visible.length && <p className="muted">No published product matches “{q}”.</p>}
        </>
      ) : (
        <div className="empty" role="status">
          <h3>Nothing to compare yet.</h3>
          <p>Comparison uses published reviews. Check back when reviews are live.</p>
        </div>
      )}
    </section>
  );
}
