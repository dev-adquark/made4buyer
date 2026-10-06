"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import CategoryIcon from "./category-icon";
import { useClientReady, useFocusTrap, type NavCategory } from "./site-nav";
import type { SearchGroups } from "@/lib/public/queries";
import { categoryName } from "@/lib/taxonomy/definitions";
import { themeStyle } from "@/lib/taxonomy/themes";

type Item = { key: string; href: string; title: string; sub?: string; image?: string; swatch?: string | null; badge?: string };
type Group = { id: string; label: string; items: Item[] };

const RECENT_KEY = "m4b:recent-searches";

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 5) : [];
  } catch {
    return [];
  }
}

function saveRecent(q: string) {
  try {
    const next = [q, ...readRecent().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable (private mode): recent searches are a convenience only.
  }
}

/** Category slug of a `/category/<slug>[?sub=…]` link. */
const categoryOf = (href: string) => href.match(/^\/category\/([^/?#]+)/)?.[1] ?? null;

/** `shown`: category slugs listed in navigation (those with published content); other category suggestions are dropped. */
function toGroups(g: SearchGroups, shown: ReadonlySet<string>): Group[] {
  const review = (s: SearchGroups["reviews"][number], badge?: string): Item => ({ key: `r:${s.slug}:${badge ?? ""}`, href: `/review/${s.slug}${badge === "Current price" ? "#deal" : ""}`, title: s.productName, sub: [categoryName(s.categorySlug), s.brand].filter(Boolean).join(", "), image: s.image, swatch: s.categorySlug, badge });
  return [
    { id: "reviews", label: "Reviews", items: g.reviews.map((s) => review(s)) },
    { id: "comparisons", label: "Comparisons", items: (g.comparisons ?? []).map((s) => ({ ...review(s), key: `cmp:${s.slug}`, title: s.title, badge: "Comparison" })) },
    { id: "products", label: "Products", items: (g.products ?? []).map((p) => ({ key: `p:${p.href}`, href: p.href, title: p.name, sub: p.count === 1 ? "1 article" : `${p.count} articles` })) },
    { id: "guides", label: "Buying guides", items: g.guides.map((s) => ({ ...review(s), key: `g:${s.slug}`, title: s.title, badge: s.kind === "AI_GUIDE" ? "AI guide" : "Source guide" })) },
    { id: "deals", label: "Current prices", items: g.deals.map((s) => review(s, "Current price")) },
    { id: "categories", label: "Categories", items: g.categories.filter((c) => shown.has(categoryOf(c.href) ?? "")).map((c) => ({ key: `c:${c.href}`, href: c.href, title: c.name, sub: c.parent ? `in ${c.parent}` : "Category", swatch: c.slug })) },
    { id: "brands", label: "Brands", items: g.brands.map((b) => ({ key: `b:${b.name}`, href: b.href, title: b.name, sub: b.count === 1 ? "1 result" : `${b.count} results` })) },
  ].filter((x) => x.items.length > 0);
}

/**
 * Site-wide search palette (⌘K / Ctrl+K / "/"). Suggestions come from published content only,
 * grouped by type; arrow keys move through every result, Enter opens it or runs a full search.
 */
export default function CommandPalette({ categories }: { categories: NavCategory[] }) {
  const id = useId();
  const listId = `${id}-list`;
  const router = useRouter();
  const reduce = useReducedMotion();
  const ready = useClientReady();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [result, setResult] = useState<{ term: string; groups: Group[]; error?: boolean } | null>(null);
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useFocusTrap(open, panel, close, trigger);

  const show = useCallback(() => {
    setRecent(readRecent());
    setActive(0);
    setOpen(true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        show();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [show]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  const term = q.trim();
  const shown = useMemo(() => new Set(categories.map((c) => c.slug)), [categories]);
  useEffect(() => {
    if (term.length < 2) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/search/suggest?groups=1&q=${encodeURIComponent(term)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: { groups?: SearchGroups }) => {
          setResult({ term, groups: d.groups ? toGroups(d.groups, shown) : [] });
          setActive(0);
        })
        .catch((e: Error) => e.name !== "AbortError" && setResult({ term, groups: [], error: true }));
    }, 140);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [term, shown]);

  const groups: Group[] = useMemo(() => {
    if (term.length >= 2) return result?.term === term ? result.groups : [];
    const out: Group[] = [];
    if (recent.length) out.push({ id: "recent", label: "Recent searches", items: recent.map((r) => ({ key: `q:${r}`, href: `/search?q=${encodeURIComponent(r)}`, title: r })) });
    if (categories.length) out.push({ id: "browse", label: "Browse categories", items: categories.slice(0, 6).map((c) => ({ key: `c:${c.slug}`, href: `/category/${c.slug}`, title: c.name, sub: c.blurb, swatch: c.slug })) });
    return out;
  }, [term, result, recent, categories]);
  const flat = groups.flatMap((g) => g.items);
  const pending = term.length >= 2 && result?.term !== term;
  const searchHref = `/search?q=${encodeURIComponent(term)}`;

  const go = (href: string) => {
    if (term.length >= 2) saveRecent(term);
    setOpen(false);
    setQ("");
    router.push(href);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (flat.length ? (a + 1) % flat.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (flat.length ? (a - 1 + flat.length) % flat.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (flat[active] && (term.length < 2 || !pending)) go(flat[active].href);
      else if (term.length >= 2) go(searchHref);
    }
  };

  let index = -1;
  const dialog = (
    <AnimatePresence>
      {open && (
        <motion.div className="palette-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <motion.div
            ref={panel}
            className="palette"
            role="dialog"
            aria-modal="true"
            aria-label="Search"
            initial={reduce ? false : { opacity: 0, y: -14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.99 }}
            transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <form
              className="palette-input"
              action="/search"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                if (term.length >= 2) go(searchHref);
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" />
              </svg>
              <label htmlFor={`${id}-q`} className="visually-hidden">
                Search reviews
              </label>
              <input
                ref={input}
                autoFocus
                id={`${id}-q`}
                name="q"
                type="search"
                role="combobox"
                aria-expanded={flat.length > 0}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={flat[active] ? `${listId}-${active}` : undefined}
                autoComplete="off"
                maxLength={100}
                placeholder="Search products, brands, guides and prices"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onKeyDown}
              />
              <button type="button" className="btn small" onClick={() => setOpen(false)}>
                Close
              </button>
            </form>
            <div className="palette-results" id={listId} role="listbox" aria-label="Search suggestions">
              {groups.map((g) => (
                <div key={g.id} className="palette-group" role="group" aria-labelledby={`${listId}-${g.id}`}>
                  <div className="palette-group-label" id={`${listId}-${g.id}`}>
                    {g.label}
                  </div>
                  <ul className="palette-list" role="presentation">
                    {g.items.map((it) => {
                      index++;
                      const i = index;
                      return (
                        <li key={it.key} id={`${listId}-${i}`} className="palette-item" role="option" aria-selected={i === active} style={it.swatch ? themeStyle(it.swatch) : undefined}>
                          <a
                            href={it.href}
                            tabIndex={-1}
                            onMouseEnter={() => setActive(i)}
                            onClick={(e) => {
                              e.preventDefault();
                              go(it.href);
                            }}
                          >
                            {it.image ? (
                              <img src={it.image} alt="" width={48} height={36} loading="lazy" />
                            ) : (
                              <span className="swatch" aria-hidden="true">
                                {it.swatch ? <CategoryIcon slug={it.swatch} size={16} /> : g.id === "recent" ? "↺" : it.title.slice(0, 1)}
                              </span>
                            )}
                            <span>
                              <span className="t">{it.title}</span>
                              {it.sub && <span className="s">{it.sub}</span>}
                            </span>
                            {it.badge && <span className={`pill ${it.badge === "AI guide" ? "ai" : "verified"}`}>{it.badge}</span>}
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
              {term.length >= 2 && !pending && !flat.length && (
                <p className="palette-empty" role="status">
                  {result?.error ? (
                    <>Search is unavailable right now. Press Enter to try the full search page.</>
                  ) : (
                    <>
                      No reviews match “<strong>{term}</strong>”. Try another product, brand or category.
                    </>
                  )}
                </p>
              )}
              {pending && (
                <p className="palette-empty" role="status">
                  Searching…
                </p>
              )}
            </div>
            <div className="palette-foot">
              <span>↑ ↓ to move, Enter to open, Esc to close</span>
              {term.length >= 2 && (
                <a
                  href={searchHref}
                  onClick={(e) => {
                    e.preventDefault();
                    go(searchHref);
                  }}
                >
                  See all results for “{term}”
                </a>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <>
      <button ref={trigger} type="button" className="search-launch" aria-label="Search the site" aria-haspopup="dialog" aria-keyshortcuts="Meta+K Control+K /" onClick={show}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
        <span className="label">Search products and guides</span>
        <kbd aria-hidden="true">⌘K</kbd>
      </button>
      {ready && createPortal(dialog, document.body)}
    </>
  );
}
