"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Option = { value: string; label: string; count: number };

export type DealsFilterState = { category: string; brand: string; seller: string; discount: string; min: string; max: string; sort: string; verified: string };
const EMPTY: DealsFilterState = { category: "", brand: "", seller: "", discount: "", min: "", max: "", sort: "", verified: "" };
const KEYS = Object.keys(EMPTY) as Array<keyof DealsFilterState>;

const DISCOUNTS = ["10", "20", "30", "50"];
const SORTS: Array<{ value: string; label: string }> = [
  { value: "", label: "Newest first" },
  { value: "saving", label: "Biggest saving" },
  { value: "price", label: "Lowest price" },
];
const KINDS: Array<{ value: string; label: string }> = [
  { value: "", label: "Any (all verified)" },
  { value: "official", label: "Official site" },
  { value: "retailer", label: "Confirmed retailer" },
];

const num = (v: string | undefined) => (v ? Number(v) : NaN);

/** Whether one [data-deal] item passes the filters. An item that does not state a filtered number is hidden by that filter. */
function matches(el: HTMLElement, f: DealsFilterState): boolean {
  const d = el.dataset;
  if (f.category && !(d.categories ?? "").split(" ").includes(f.category)) return false;
  if (f.brand && d.brand !== f.brand) return false;
  if (f.seller && d.seller !== f.seller) return false;
  if (f.verified && d.kind !== f.verified) return false;
  if (f.discount && !(num(d.savingPct) >= Number(f.discount))) return false;
  const min = Number(f.min);
  const max = Number(f.max);
  if (f.min && Number.isFinite(min) && !(num(d.price) >= min)) return false;
  if (f.max && Number.isFinite(max) && !(num(d.price) <= max)) return false;
  return true;
}

/** Sort key: newest / biggest saving first, lowest price first; items that do not state the value go last, in their original order. */
function sortKey(el: HTMLElement, sort: string): number {
  if (sort === "saving") {
    const amount = num(el.dataset.saving);
    if (Number.isFinite(amount)) return amount;
    const pct = num(el.dataset.savingPct);
    return Number.isFinite(pct) ? pct / 1000 : -Infinity;
  }
  if (sort === "price") {
    const price = num(el.dataset.price);
    return Number.isFinite(price) ? -price : -Infinity;
  }
  const checked = num(el.dataset.checked);
  return Number.isFinite(checked) ? checked : -Infinity;
}

function compare(sort: string) {
  return (a: HTMLElement, b: HTMLElement) => {
    const ka = sortKey(a, sort);
    const kb = sortKey(b, sort);
    if (ka !== kb) return kb > ka ? 1 : -1;
    return Number(a.dataset.order) - Number(b.dataset.order);
  };
}

/**
 * Filters and sorting for the cached /deals page. The page is rendered once (ISR) with every verified
 * item, so it stays cacheable; this narrows and orders what is visible in the browser and keeps the
 * choice in the URL (?category=…&brand=…&seller=…&discount=…&min=…&max=…&sort=…&verified=…), so a
 * filtered view can be linked and is restored on load. Without JavaScript every verified item stays
 * visible. A polite live region announces how many items match.
 */
export default function DealsFilter({ categories, brands, sellers, scope = "deals-root", total }: { categories: Option[]; brands: Option[]; sellers: Option[]; scope?: string; total: number }) {
  const [f, setF] = useState<DealsFilterState>(EMPTY);
  const [shown, setShown] = useState<number | null>(null);
  const ready = useRef(false);

  // Initial values from the URL (e.g. links from a category page: /deals?category=laptops).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const next = { ...EMPTY };
    const valid = (k: keyof DealsFilterState, v: string) => {
      if (k === "category") return categories.some((o) => o.value === v);
      if (k === "brand") return brands.some((o) => o.value === v);
      if (k === "seller") return sellers.some((o) => o.value === v);
      if (k === "discount") return DISCOUNTS.includes(v);
      if (k === "sort") return SORTS.some((o) => o.value === v);
      if (k === "verified") return KINDS.some((o) => o.value === v);
      return /^\d{1,6}(\.\d{1,2})?$/.test(v);
    };
    for (const k of KEYS) {
      const v = (p.get(k) ?? "").trim();
      if (v && valid(k, v)) next[k] = v;
    }
    ready.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of the URL after hydration
    setF(next);
  }, [categories, brands, sellers]);

  const apply = useCallback(
    (state: DealsFilterState) => {
      const root = document.getElementById(scope);
      if (!root) return;
      let visible = 0;
      for (const list of root.querySelectorAll<HTMLElement>("[data-deal-list]")) {
        const items = [...list.querySelectorAll<HTMLElement>(":scope > [data-deal]")];
        items.forEach((el, i) => {
          if (!el.dataset.order) el.dataset.order = String(i);
          el.hidden = !matches(el, state);
          if (!el.hidden) visible++;
        });
        // Reorder in the DOM (not with CSS `order`) so reading and Tab order follow the visual order.
        const sorted = [...items].sort(compare(state.sort));
        if (sorted.some((el, i) => el !== items[i])) for (const el of sorted) list.appendChild(el);
      }
      for (const section of root.querySelectorAll<HTMLElement>("[data-deal-section]")) {
        const items = [...section.querySelectorAll<HTMLElement>("[data-deal]")];
        const empty = section.querySelector<HTMLElement>("[data-deal-empty]");
        if (empty) empty.hidden = !items.length || items.some((el) => !el.hidden);
      }
      setShown(visible);
      const url = new URL(window.location.href);
      for (const k of KEYS) {
        if (state[k]) url.searchParams.set(k, state[k]);
        else url.searchParams.delete(k);
      }
      window.history.replaceState(null, "", url.toString());
    },
    [scope],
  );

  useEffect(() => {
    if (ready.current) apply(f);
  }, [f, apply]);

  const set = (k: keyof DealsFilterState) => (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => {
    const value = e.target.value;
    setF((s) => ({ ...s, [k]: value }));
  };
  const active = KEYS.some((k) => k !== "sort" && f[k]);

  return (
    <form className="deals-filter" role="search" aria-label="Filter and sort deals" action="/deals" onSubmit={(e) => e.preventDefault()}>
      {categories.length > 0 && (
        <div className="df-field">
          <label htmlFor="deal-category">Category</label>
          <select id="deal-category" name="category" value={f.category} onChange={set("category")}>
            <option value="">All categories</option>
            {categories.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label} ({o.count})
              </option>
            ))}
          </select>
        </div>
      )}
      {brands.length > 0 && (
        <div className="df-field">
          <label htmlFor="deal-brand">Brand</label>
          <select id="deal-brand" name="brand" value={f.brand} onChange={set("brand")}>
            <option value="">All brands</option>
            {brands.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label} ({o.count})
              </option>
            ))}
          </select>
        </div>
      )}
      {sellers.length > 0 && (
        <div className="df-field">
          <label htmlFor="deal-seller">Seller</label>
          <select id="deal-seller" name="seller" value={f.seller} onChange={set("seller")}>
            <option value="">All sellers</option>
            {sellers.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label} ({o.count})
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="df-field">
        <label htmlFor="deal-discount">Discount</label>
        <select id="deal-discount" name="discount" value={f.discount} onChange={set("discount")}>
          <option value="">Any discount</option>
          {DISCOUNTS.map((d) => (
            <option key={d} value={d}>
              {d}% or more
            </option>
          ))}
        </select>
      </div>
      <fieldset className="df-field df-range">
        <legend>Price (USD)</legend>
        <div className="df-range-inputs">
          <label htmlFor="deal-min" className="visually-hidden">
            Minimum price in US dollars
          </label>
          <input id="deal-min" name="min" type="number" inputMode="decimal" min={0} step="any" placeholder="Min" value={f.min} onChange={set("min")} />
          <span aria-hidden="true">–</span>
          <label htmlFor="deal-max" className="visually-hidden">
            Maximum price in US dollars
          </label>
          <input id="deal-max" name="max" type="number" inputMode="decimal" min={0} step="any" placeholder="Max" value={f.max} onChange={set("max")} />
        </div>
      </fieldset>
      <div className="df-field">
        <label htmlFor="deal-verified">Verified on</label>
        <select id="deal-verified" name="verified" value={f.verified} onChange={set("verified")}>
          {KINDS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="df-field">
        <label htmlFor="deal-sort">Sort</label>
        <select id="deal-sort" name="sort" value={f.sort} onChange={set("sort")}>
          {SORTS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="df-foot">
        <p className="df-status small muted" role="status" aria-live="polite">
          {shown !== null && active ? `Showing ${shown} of ${total}` : ""}
        </p>
        {active && (
          <button type="button" className="btn small" onClick={() => setF((s) => ({ ...EMPTY, sort: s.sort }))}>
            Clear filters
          </button>
        )}
      </div>
    </form>
  );
}
