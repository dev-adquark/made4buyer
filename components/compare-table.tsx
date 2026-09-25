"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import Link from "next/link";

export type CompareColumn = { id: string; slug: string; name: string; image: string; categoryName: string; facts: Record<string, string | null> };

/** Comparison table; columns animate in/out as products are added or removed. Missing facts say so. */
export default function CompareTable({ columns, rows }: { columns: CompareColumn[]; rows: string[] }) {
  const reduce = useReducedMotion();
  const anim = (i: number) => (reduce ? {} : { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0 }, transition: { duration: 0.35, delay: i * 0.06 } });
  return (
    <div className="compare-grid">
      <table>
        <caption>Comparing {columns.map((c) => c.name).join(", ")}</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Attribute</span>
            </th>
            <AnimatePresence initial>
              {columns.map((c, i) => (
                <motion.th key={c.id} scope="col" {...anim(i)}>
                  <img src={c.image} alt="" width={200} height={125} loading="lazy" />
                  <Link href={`/review/${c.slug}`}>{c.name}</Link>
                  <div className="small muted">{c.categoryName}</div>
                </motion.th>
              ))}
            </AnimatePresence>
          </tr>
        </thead>
        <tbody>
          {rows.map((label) => {
            const values = columns.map((c) => c.facts[label]);
            const known = values.filter((v): v is string => Boolean(v));
            const differs = known.length > 1 && new Set(known).size > 1;
            return (
              <tr key={label} className={differs ? "differs" : undefined}>
                <th scope="row">
                  {label}
                  {differs && <span className="differs-tag">Differs</span>}
                </th>
                {columns.map((c, i) => (
                  <motion.td key={c.id} {...anim(i)}>
                    {c.facts[label] ?? <span className="na">Not available</span>}
                  </motion.td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
