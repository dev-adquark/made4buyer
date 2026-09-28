import Link from "next/link";
import { Logo } from "./brand-mark";
import CommandPalette from "./command-palette";
import { MainNav, MobileMenu, type NavCategory } from "./site-nav";

export default function SiteHeader({ categories }: { categories: NavCategory[] }) {
  return (
    <>
      <div className="trust-strip">
        <div className="container">
          <span>Every offer link is checked before it’s shown</span>
          <span>
            We may earn a commission from offer links. <Link href="/disclosure">How we make money</Link>
          </span>
        </div>
      </div>
      <header className="site-header">
        <div className="container header-inner">
          <Logo />
          <MainNav categories={categories} />
          <div className="header-tools">
            <CommandPalette categories={categories} />
            <Link className="btn primary match-cta" href="/match">
              Find my match
            </Link>
            <MobileMenu categories={categories} />
          </div>
        </div>
      </header>
    </>
  );
}
