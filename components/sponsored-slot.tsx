import type { SponsoredPosition } from "@prisma/client";
import { activePlacement } from "@/lib/sponsored";

/** Renders an active sponsored placement, always labelled with its disclosure. Renders nothing otherwise. */
export default async function SponsoredSlot({ position, categorySlug }: { position: SponsoredPosition; categorySlug?: string | null }) {
  const p = await activePlacement(position, categorySlug).catch(() => null);
  if (!p) return null;
  return (
    <aside className="sponsor" aria-label="Sponsored content">
      <div className="sponsor-label">{p.label}</div>
      <a href={p.url} rel="sponsored nofollow noopener" target="_blank">
        <strong>{p.title}</strong>
      </a>
      <div className="small muted">
        {p.advertiser} · {p.disclosure}
      </div>
    </aside>
  );
}
