import Link from "next/link";
import SearchCombobox from "./search-combobox";
import { MainNav, MobileMenu, type NavCategory } from "./site-nav";

export function Logo() {
  return (
    <Link className="logo" href="/" aria-label="Made4Buyers home">
      <span className="logo-mark" aria-hidden="true" />
      Made4Buyers
    </Link>
  );
}

export default function SiteHeader({ categories }: { categories: NavCategory[] }) {
  return (
    <header className="site-header">
      <div className="container header-inner">
        <Logo />
        <MainNav categories={categories} />
        <div className="header-actions">
          <SearchCombobox variant="header" />
          <Link className="btn icon menu-button" href="/search" aria-label="Search">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
          </Link>
          <MobileMenu categories={categories} />
        </div>
      </div>
    </header>
  );
}
