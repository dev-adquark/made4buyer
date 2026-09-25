"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import { useMemo, useState } from "react";

type Item = { id: string; slug: string; title: string; productName: string; brand: string | null; categoryName: string | null };

export default function CompareSelector({ items, initial }: { items: Item[]; initial: string[] }) {
  const reduce = useReducedMotion();
  const [selected, setSelected] = useState<string[]>(initial.slice(0, 3));
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 3 ? s : [...s, id]));
  const href = useMemo(() => (selected.length ? `/compare?ids=${selected.join(",")}` : "/compare"), [selected]);
  const ready = selected.length >= 2;
  const names = selected.map((id) => items.find((i) => i.id === id)?.productName).filter(Boolean);
  return (
    <section aria-labelledby="compare-pick">
      <h2 id="compare-pick">Pick up to three products</h2>
      <div className="compare-tray" role="region" aria-label="Selected products">
        <div aria-live="polite">
          <strong>{selected.length}/3 selected</strong>
          <AnimatePresence>
            {names.length > 0 && (
              <motion.div className="small muted" initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                {names.join(", ")}
              </motion.div>
            )}
          </AnimatePresence>
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
        <ul className="compare-picks">
          {items.map((r) => {
            const checked = selected.includes(r.id);
            const inputId = `cmp-${r.id}`;
            return (
              <li key={r.id}>
                <div className="pick">
                  <input id={inputId} type="checkbox" checked={checked} disabled={!checked && selected.length >= 3} onChange={() => toggle(r.id)} />
                  <div>
                    <label htmlFor={inputId}>{r.productName}</label>
                    <div className="meta-row" style={{ margin: "4px 0" }}>
                      {r.categoryName && <span className="pill plain">{r.categoryName}</span>}
                      {r.brand && <span className="small muted">{r.brand}</span>}
                    </div>
                    <Link className="small" href={`/review/${r.slug}`}>
                      Read the {r.productName} review
                    </Link>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="empty" role="status">
          <h3 style={{ fontSize: 20 }}>Nothing to compare yet.</h3>
          <p>Comparison uses published reviews. Check back when reviews are live.</p>
        </div>
      )}
    </section>
  );
}
