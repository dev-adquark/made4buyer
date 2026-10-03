"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Wordmark } from "./brand-mark";
import CategoryIcon from "./category-icon";
import SearchCombobox from "./search-combobox";
import type { NavFeed } from "@/lib/public/queries";
import { themeStyle } from "@/lib/taxonomy/themes";

export type NavCategory = { slug: string; name: string; blurb: string; issue: number; department: string; departmentName: string; subs: Array<{ slug: string; name: string }> };

/** Groups categories by department, keeping first-seen department order and category order. */
export function byDepartment(categories: NavCategory[]) {
  const groups: Array<{ slug: string; name: string; items: NavCategory[] }> = [];
  for (const c of categories) {
    let g = groups.find((x) => x.slug === c.department);
    if (!g) groups.push((g = { slug: c.department, name: c.departmentName, items: [] }));
    g.items.push(c);
  }
  return groups;
}

// Order: Reviews · Categories (menu) · Deals · Compare · Guides
const BEFORE: Array<[string, string]> = [["/reviews", "Reviews"]];
const LINKS: Array<[string, string, boolean?]> = [
  ["/deals", "Deals"],
  ["/compare", "Compare"],
  ["/guides", "Guides"],
];

function money(price: number | null, currency: string | null) {
  if (price === null) return null;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD", maximumFractionDigits: 0 }).format(price);
  } catch {
    return null;
  }
}

function Chevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** Category mega-menu content. Everything shown comes from /api/nav (published data only). */
function MegaPanel({ category, feed, failed }: { category: NavCategory; feed: NavFeed | undefined; failed: boolean }) {
  const loading = !feed && !failed;
  return (
    <div className="mega-panel" style={themeStyle(category.slug)} aria-busy={loading}>
      <div>
        <h2>{category.name}</h2>
        <p>{category.blurb}.</p>
        <Link className="btn light small" href={`/category/${category.slug}`}>
          {feed?.total ? `See all ${feed.total} in ${category.name}` : `Open ${category.name}`}
        </Link>
        {category.subs.length > 0 && (
          <>
            <h3>Types</h3>
            <ul className="mega-links">
              {category.subs.map((s) => (
                <li key={s.slug}>
                  <Link href={`/category/${category.slug}?sub=${s.slug}`}>
                    {s.name}
                    {feed?.counts[s.slug] ? <span className="visually-hidden">, {feed.counts[s.slug]} reviews</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <div>
        <h3>Latest reviews</h3>
        {loading ? (
          <div className="skeleton" style={{ height: 150, background: "rgba(255,255,255,0.06)" }} />
        ) : feed?.latest.length ? (
          <ul className="mega-feature">
            {feed.latest.map((r) => (
              <li key={r.slug}>
                <Link href={`/review/${r.slug}`}>
                  <img src={r.image} alt="" width={76} height={52} loading="lazy" />
                  <span>
                    <strong>{r.title}</strong>
                    {r.verifiedOffer && <span className="pill verified">Verified offer</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mega-empty">{failed ? "Couldn’t load the latest reviews. Open the category to see them." : `No ${category.name.toLowerCase()} reviews are published yet.`}</p>
        )}
        {feed && (feed.trending.length > 0 || feed.guides.length > 0 || feed.deals.length > 0) && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
            {feed.trending.length > 0 && (
              <div>
                <h3>Trending this week</h3>
                <ul className="mega-links">
                  {feed.trending.map((t) => (
                    <li key={t.slug}>
                      <Link href={`/review/${t.slug}`}>{t.title}</Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {feed.guides.length > 0 && (
              <div>
                <h3>Buying guides</h3>
                <ul className="mega-links">
                  {feed.guides.map((g) => (
                    <li key={g.slug}>
                      <Link href={`/review/${g.slug}`}>{g.title}</Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {feed.deals.length > 0 && (
              <div>
                <h3>Verified deals</h3>
                <ul className="mega-links">
                  {feed.deals.map((d) => (
                    <li key={d.slug + (d.merchant ?? "")}>
                      <Link href={`/review/${d.slug}#deal`}>
                        {d.productName}
                        {money(d.price, d.currency) ? `, ${money(d.price, d.currency)}` : ""}
                        {d.merchant ? ` at ${d.merchant}` : ""}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Desktop navigation: category mega-menu plus section links. */
export function MainNav({ categories }: { categories: NavCategory[] }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(categories[0]?.slug);
  const [feeds, setFeeds] = useState<Record<string, NavFeed>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const requested = useRef(new Set<string>());
  const pathname = usePathname();
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const reduce = useReducedMotion();

  const load = useCallback((slug: string) => {
    if (requested.current.has(slug)) return;
    requested.current.add(slug);
    fetch(`/api/nav/${slug}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((feed: NavFeed) => setFeeds((f) => ({ ...f, [slug]: feed })))
      .catch(() => {
        requested.current.delete(slug);
        setFailed((f) => ({ ...f, [slug]: true }));
      });
  }, []);

  const choose = (slug: string) => {
    setCurrent(slug);
    load(slug);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selected = categories.find((c) => c.slug === current) ?? categories[0];
  return (
    <nav className="primary-nav" aria-label="Main" ref={wrap} onClick={(e) => (e.target as HTMLElement).closest("a") && setOpen(false)}>
      {BEFORE.map(([href, label]) => (
        <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined}>
          {label}
        </Link>
      ))}
      <button
        ref={trigger}
        type="button"
        className="nav-trigger"
        aria-expanded={open}
        aria-controls="mega-categories"
        onClick={() => {
          setOpen((o) => !o);
          if (selected) load(selected.slug);
        }}
        onPointerEnter={() => selected && load(selected.slug)}
      >
        Categories
        <Chevron />
      </button>
      {LINKS.map(([href, label, optional]) => (
        <Link key={href} href={href} className={optional ? "optional" : undefined} aria-current={pathname === href ? "page" : undefined}>
          {label}
        </Link>
      ))}
      <AnimatePresence>
        {open && selected && (
          <motion.div
            id="mega-categories"
            className="mega on-ink"
            initial={reduce ? false : { opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduce ? 0 : -6 }}
            transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <div className="container mega-inner">
              <div className="mega-cats">
                {byDepartment(categories).map((g) => (
                  <div key={g.slug} className="mega-dept">
                    <h2 className="mega-dept-name" id={`dept-${g.slug}`}>
                      {g.name}
                    </h2>
                    <ul aria-labelledby={`dept-${g.slug}`}>
                      {g.items.map((c) => (
                        <li key={c.slug} style={themeStyle(c.slug)}>
                          <button type="button" aria-pressed={c.slug === selected.slug} onClick={() => choose(c.slug)} onPointerEnter={() => choose(c.slug)} onFocus={() => choose(c.slug)}>
                            <span className="num" aria-hidden="true">
                              {String(c.issue).padStart(2, "0")}
                            </span>
                            {c.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              <MegaPanel category={selected} feed={feeds[selected.slug]} failed={Boolean(failed[selected.slug])} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </nav>
  );
}

function useFocusTrap(open: boolean, panel: React.RefObject<HTMLElement | null>, onClose: () => void, returnTo: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const back = returnTo.current;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onPop = () => onClose();
    window.addEventListener("popstate", onPop);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && panel.current) {
        const f = [...panel.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input, summary")].filter((el) => el.offsetParent !== null);
        if (!f.length) return;
        const [a, z] = [f[0], f[f.length - 1]];
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault();
          z.focus();
        } else if (!e.shiftKey && document.activeElement === z) {
          e.preventDefault();
          a.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("popstate", onPop);
      back?.focus();
    };
  }, [open, panel, onClose, returnTo]);
}

/** Full-screen mobile navigation: modal dialog with focus trap, Escape to close, scroll lock. */
export function MobileMenu({ categories }: { categories: NavCategory[] }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const reduce = useReducedMotion();
  const close = useCallback(() => setOpen(false), []);
  useFocusTrap(open, panel, close, trigger);
  const mounted = useClientReady();
  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>("button")?.focus();
  }, [open]);

  const sheet = (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={panel}
          id="mobile-menu"
          className="sheet on-ink"
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
          onClick={(e) => (e.target as HTMLElement).closest("a") && setOpen(false)}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: -16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -12 }}
          transition={{ duration: 0.26, ease: [0.2, 0.8, 0.2, 1] }}
        >
          <div className="sheet-head">
            <span className="brand">
              <Wordmark />
            </span>
            <button type="button" className="btn icon ghost-ink" aria-label="Close menu" onClick={() => setOpen(false)}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          <div className="sheet-body">
            <SearchCombobox variant="wide" label="Search" />
            <nav aria-label="Mobile">
              <ul className="sheet-quick">
                {[...BEFORE, ...LINKS, ["/match", "Find my match"] as [string, string]].map(([href, label]) => (
                  <li key={href}>
                    <Link href={href}>{label}</Link>
                  </li>
                ))}
              </ul>
              {byDepartment(categories).map((g) => (
              <ul key={g.slug} className="sheet-cats" aria-label={g.name}>
                <li className="sheet-dept" aria-hidden="true">
                  {g.name}
                </li>
                {g.items.map((c) => (
                  <li key={c.slug} style={themeStyle(c.slug)}>
                    <div className="sheet-cat-row">
                      <Link href={`/category/${c.slug}`}>
                        <span className="swatch">
                          <CategoryIcon slug={c.slug} size={16} />
                        </span>
                        {c.name}
                      </Link>
                      {c.subs.length > 0 && (
                        <button type="button" className="btn icon ghost-ink small" aria-expanded={expanded === c.slug} aria-controls={`subs-${c.slug}`} aria-label={`${c.name} types`} onClick={() => setExpanded((x) => (x === c.slug ? null : c.slug))}>
                          <Chevron />
                        </button>
                      )}
                    </div>
                    {expanded === c.slug && (
                      <ul id={`subs-${c.slug}`}>
                        {c.subs.map((s) => (
                          <li key={s.slug}>
                            <Link href={`/category/${c.slug}?sub=${s.slug}`}>{s.name}</Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
              ))}
            </nav>
            <p className="small" style={{ color: "var(--on-ink-muted)" }}>
              <Link href="/about" style={{ color: "#fff" }}>How we review</Link> and <Link href="/disclosure" style={{ color: "#fff" }}>how we make money</Link>
            </p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <>
      <button ref={trigger} type="button" className="btn icon menu-toggle" aria-expanded={open} aria-controls="mobile-menu" aria-label="Open menu" onClick={() => setOpen(true)}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M4 7h16M4 12h10M4 17h16" />
        </svg>
      </button>
      {mounted && createPortal(sheet, document.body)}
    </>
  );
}

const noop = () => () => undefined;
/** True after hydration (portals need document.body). */
export function useClientReady() {
  return useSyncExternalStore(noop, () => true, () => false);
}

export { useFocusTrap };
