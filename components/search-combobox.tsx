"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { categoryName } from "@/lib/taxonomy/definitions";
import { themeStyle } from "@/lib/taxonomy/themes";

type Suggestion = { slug: string; title: string; productName: string; brand: string | null; categorySlug: string | null; image: string; verifiedOffer: boolean };

/**
 * Accessible search combobox (ARIA 1.2 pattern) with instant suggestions from published
 * reviews. Works without JS as a plain GET form to /search.
 */
export default function SearchCombobox({ variant = "header", defaultValue = "", label = "Search reviews", autoFocus = false }: { variant?: "header" | "wide" | "hero"; defaultValue?: string; label?: string; autoFocus?: boolean }) {
  const id = useId();
  const listId = `${id}-list`;
  const router = useRouter();
  const reduce = useReducedMotion();
  const [q, setQ] = useState(defaultValue);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setLoading(true);
      fetch(`/api/search/suggest?q=${encodeURIComponent(term)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : { suggestions: [] }))
        .then((d: { suggestions: Suggestion[] }) => {
          setItems(d.suggestions ?? []);
          setActive(-1);
          setLoading(false);
        })
        .catch(() => undefined);
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const showList = open && q.trim().length >= 2;
  // Suggestions for a previous (longer) query are hidden once the term is too short.
  const visibleItems = q.trim().length >= 2 ? items : [];
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(-1, a - 1));
    } else if (e.key === "Escape") {
      setOpen(false);
      setActive(-1);
    } else if (e.key === "Enter" && active >= 0 && items[active]) {
      e.preventDefault();
      setOpen(false);
      router.push(`/review/${items[active].slug}`);
    }
  };

  const inputId = `${id}-input`;
  return (
    <div ref={wrap} className={`searchbox ${variant === "header" ? "" : "wide"}`}>
      <form action="/search" role="search" className={variant === "hero" ? "hero-search" : undefined} onSubmit={() => setOpen(false)}>
        <label htmlFor={inputId} className="visually-hidden">
          {label}
        </label>
        {variant !== "hero" && (
          <svg className="search-glyph" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
        )}
        <input
          id={inputId}
          name="q"
          type="search"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          maxLength={100}
          placeholder={variant === "hero" ? "Search laptops, phones, AI tools…" : "Search reviews"}
          value={q}
          autoFocus={autoFocus}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {variant !== "header" && (
          <button className={`btn ${variant === "hero" ? "primary large" : "primary"}`} type="submit">
            Search
          </button>
        )}
      </form>
      <AnimatePresence>
        {showList && (
          <motion.ul
            id={listId}
            role="listbox"
            aria-label="Suggestions"
            className="suggestions"
            initial={reduce ? false : { opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
          >
            {visibleItems.map((s, i) => (
              <motion.li
                key={s.slug}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                style={themeStyle(s.categorySlug)}
                initial={reduce ? false : { opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: reduce ? 0 : i * 0.03 }}
              >
                <a href={`/review/${s.slug}`} tabIndex={-1} onMouseEnter={() => setActive(i)}>
                  <img src={s.image} alt="" width={56} height={40} loading="lazy" />
                  <span>
                    <span className="s-title">{s.productName}</span>
                    <span className="s-meta">
                      {s.categorySlug && <span className="pill">{categoryName(s.categorySlug)}</span>}
                      {s.brand && <span className="pill plain">{s.brand}</span>}
                      {s.verifiedOffer && <span className="pill verified">Verified offer</span>}
                    </span>
                  </span>
                </a>
              </motion.li>
            ))}
            {!visibleItems.length && !loading && (
              <li className="s-empty" role="option" aria-selected={false} aria-disabled="true">
                No reviews match “{q.trim()}”. Try another product, brand or category.
              </li>
            )}
            {loading && !visibleItems.length && (
              <li className="s-empty" role="option" aria-selected={false} aria-disabled="true">
                Searching…
              </li>
            )}
            {visibleItems.length > 0 && (
              <li className="s-all" role="option" aria-selected={false}>
                <a href={`/search?q=${encodeURIComponent(q.trim())}`} tabIndex={-1}>
                  See all results for “{q.trim()}”
                </a>
              </li>
            )}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
