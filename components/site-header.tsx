import Link from "next/link";
import { Logo } from "./brand-mark";
import CommandPalette from "./command-palette";
import MastheadState from "./masthead-state";
import { MainNav, MobileMenu, type NavCategory } from "./site-nav";

export default function SiteHeader({ categories }: { categories: NavCategory[] }) {
  return (
    <>
      <div className="trust-strip">
        <div className="wrap">
          <span>Every offer link is checked before it’s shown</span>
          <span>
            Offer links may earn us a commission. <Link href="/disclosure">How we make money</Link>
          </span>
        </div>
      </div>
      <header className="masthead" data-compact="false">
        <div className="wrap mast-inner">
          <Logo />
          <MainNav categories={categories} />
          <div className="header-tools">
            <CommandPalette categories={categories} />
            <Link className="btn primary match-cta" href="/match" data-cursor="Start">
              Find my match
            </Link>
            <MobileMenu categories={categories} />
          </div>
        </div>
      </header>
      <MastheadState />
    </>
  );
}
