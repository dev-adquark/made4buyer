"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

type Item = { id: string; slug: string; title: string; productName: string; brand: string | null };

export default function CompareSelector({ items, initial }: { items: Item[]; initial: string[] }) {
  const [selected, setSelected] = useState<string[]>(initial.slice(0, 3));
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 3 ? s : [...s, id]));
  const href = useMemo(() => (selected.length ? `/compare?ids=${selected.join(",")}` : "/compare"), [selected]);
  const ready = selected.length >= 2;
  return (
    <section aria-labelledby="compare-pick">
      <h2 id="compare-pick">Pick up to three products</h2>
      <div className="btnrow">
        <span className="muted" aria-live="polite">
          {selected.length}/3 selected
        </span>
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
      <ul className="grid" style={{ listStyle: "none", padding: 0 }}>
        {items.map((r) => {
          const checked = selected.includes(r.id);
          const inputId = `cmp-${r.id}`;
          return (
            <li className="card" key={r.id}>
              <div className="card-body">
                <input id={inputId} type="checkbox" checked={checked} disabled={!checked && selected.length >= 3} onChange={() => toggle(r.id)} />{" "}
                <label htmlFor={inputId} style={{ display: "inline" }}>
                  {r.productName}
                </label>
                <div className="meta">{r.brand ?? ""}</div>
                <p className="small muted">{r.title}</p>
                <Link href={`/review/${r.slug}`}>Read the {r.productName} review</Link>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
