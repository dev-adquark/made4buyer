"use client";

import { useEffect, useState } from "react";

type Option = { value: string; label: string; count: number };

/**
 * Category and brand filters for the cached /deals page. The page is rendered once (ISR) with
 * every deal; this narrows what is visible in the browser and keeps the choice in the URL
 * (?category=…&brand=…). Without JavaScript every deal stays visible.
 */
export default function DealsFilter({ categories, brands, scope = "deals-root" }: { categories: Option[]; brands: Option[]; scope?: string }) {
  const [category, setCategory] = useState("");
  const [brand, setBrand] = useState("");

  // Initial values from the URL (e.g. links from a category page: /deals?category=laptops).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const c = p.get("category") ?? "";
    const b = p.get("brand") ?? "";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of the URL after hydration
    if (categories.some((o) => o.value === c)) setCategory(c);
    if (brands.some((o) => o.value === b)) setBrand(b);
  }, [categories, brands]);

  useEffect(() => {
    const root = document.getElementById(scope);
    if (!root) return;
    for (const el of root.querySelectorAll<HTMLElement>("[data-deal]")) {
      const cats = (el.dataset.categories ?? "").split(" ");
      el.hidden = Boolean((category && !cats.includes(category)) || (brand && el.dataset.brand !== brand));
    }
    for (const section of root.querySelectorAll<HTMLElement>("[data-deal-section]")) {
      const any = [...section.querySelectorAll<HTMLElement>("[data-deal]")].some((el) => !el.hidden);
      const empty = section.querySelector<HTMLElement>("[data-deal-empty]");
      if (empty) empty.hidden = any;
    }
    const url = new URL(window.location.href);
    for (const [k, v] of [["category", category], ["brand", brand]] as const) {
      if (v) url.searchParams.set(k, v);
      else url.searchParams.delete(k);
    }
    window.history.replaceState(null, "", url.toString());
  }, [category, brand, scope]);

  if (!categories.length && !brands.length) return null;
  return (
    <div className="deals-filter" role="group" aria-label="Filter deals">
      {categories.length > 1 && (
        <>
          <label htmlFor="deal-category" className="visually-hidden">
            Category
          </label>
          <select id="deal-category" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label} ({o.count})
              </option>
            ))}
          </select>
        </>
      )}
      {brands.length > 1 && (
        <>
          <label htmlFor="deal-brand" className="visually-hidden">
            Brand
          </label>
          <select id="deal-brand" value={brand} onChange={(e) => setBrand(e.target.value)}>
            <option value="">All brands</option>
            {brands.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label} ({o.count})
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}
