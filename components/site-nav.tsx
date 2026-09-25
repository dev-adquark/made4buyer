"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import CategoryIcon from "./category-icon";
import SearchCombobox from "./search-combobox";
import { themeStyle } from "@/lib/taxonomy/themes";

export type NavCategory = { slug: string; name: string; blurb: string };

const LINKS: Array<[string, string]> = [
  ["/reviews", "Reviews"],
  ["/deals", "Deals"],
  ["/compare", "Compare"],
];

/** Desktop navigation with a categories disclosure panel. */
export function MainNav({ categories }: { categories: NavCategory[] }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const wrap = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <nav className="main-nav" aria-label="Main" onClick={(e) => (e.target as HTMLElement).closest("a") && setOpen(false)}>
      {LINKS.slice(0, 1).map(([href, label]) => (
        <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined}>
          {label}
        </Link>
      ))}
      <div className="nav-categories" ref={wrap}>
        <button type="button" className="nav-trigger" aria-expanded={open} aria-controls="mega-categories" onClick={() => setOpen((o) => !o)}>
          Categories
        </button>
        <AnimatePresence>
          {open && (
            <motion.ul id="mega-categories" className="mega" initial={reduce ? false : { opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduce ? 0 : -8 }} transition={{ duration: 0.18 }}>
              {categories.map((c) => (
                <li key={c.slug} style={themeStyle(c.slug)}>
                  <Link href={`/category/${c.slug}`}>
                    <span className="mega-icon">
                      <CategoryIcon slug={c.slug} />
                    </span>
                    <span>
                      <strong>{c.name}</strong>
                      <span className="small">{c.blurb}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </motion.ul>
          )}
        </AnimatePresence>
      </div>
      {LINKS.slice(1).map(([href, label]) => (
        <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined}>
          {label}
        </Link>
      ))}
    </nav>
  );
}

/** Mobile navigation drawer: modal dialog with focus trap, Escape to close, scroll lock. */
export function MobileMenu({ categories }: { categories: NavCategory[] }) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!open) return;
    const button = trigger.current;
    const onPop = () => setOpen(false);
    window.addEventListener("popstate", onPop);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const first = panel.current?.querySelector<HTMLElement>("button, a, input");
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      if (e.key === "Tab" && panel.current) {
        const f = [...panel.current.querySelectorAll<HTMLElement>("a[href], button, input")].filter((el) => !el.hasAttribute("disabled"));
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
      button?.focus();
    };
  }, [open]);

  return (
    <>
      <button ref={trigger} type="button" className="btn icon menu-button" aria-expanded={open} aria-controls="mobile-menu" aria-label="Open menu" onClick={() => setOpen(true)}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      <AnimatePresence>
        {open && (
          <>
            <motion.div className="drawer-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setOpen(false)} />
            <motion.div
              ref={panel}
              id="mobile-menu"
              className="drawer"
              role="dialog"
              aria-modal="true"
              aria-label="Menu"
              onClick={(e) => (e.target as HTMLElement).closest("a") && setOpen(false)}
              initial={reduce ? { opacity: 0 } : { x: "100%" }}
              animate={reduce ? { opacity: 1 } : { x: 0 }}
              exit={reduce ? { opacity: 0 } : { x: "100%" }}
              transition={{ type: "tween", duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="drawer-head">
                <span className="logo">
                  <span className="logo-mark" aria-hidden="true" />
                  Made4Buyers
                </span>
                <button type="button" className="btn icon" aria-label="Close menu" onClick={() => setOpen(false)}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
              <SearchCombobox variant="wide" label="Search reviews" />
              <nav aria-label="Mobile">
                <ul>
                  {[["/", "Home"], ...LINKS].map(([href, label]) => (
                    <li key={href}>
                      <Link href={href}>{label}</Link>
                    </li>
                  ))}
                </ul>
                <div className="drawer-section">Categories</div>
                <ul>
                  {categories.map((c) => (
                    <li key={c.slug} style={themeStyle(c.slug)}>
                      <Link href={`/category/${c.slug}`}>
                        <span className="mega-icon" style={{ width: 32, height: 32, borderRadius: 9 }}>
                          <CategoryIcon slug={c.slug} size={18} />
                        </span>
                        {c.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
