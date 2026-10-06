import Link from "next/link";
import { displayText } from "@/lib/public/display";

export type Crumb = { name: string; href?: string };

/** Crumbs with a real name only (an empty or placeholder name is left out). */
function clean(items: Crumb[]): Crumb[] {
  return items.flatMap((c) => {
    const name = displayText(c.name);
    return name ? [{ ...c, name }] : [];
  });
}

export default function Breadcrumbs({ items: raw }: { items: Crumb[] }) {
  const items = clean(raw);
  if (!items.length) return null;
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <ol>
        {items.map((c, i) => (
          <li key={i}>{c.href && i < items.length - 1 ? <Link href={c.href}>{c.name}</Link> : <span aria-current={i === items.length - 1 ? "page" : undefined}>{c.name}</span>}</li>
        ))}
      </ol>
    </nav>
  );
}

export function breadcrumbJsonLd(raw: Crumb[], siteUrl: string) {
  const items = clean(raw);
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, ...(c.href ? { item: new URL(c.href, siteUrl).toString() } : {}) })),
  };
}
