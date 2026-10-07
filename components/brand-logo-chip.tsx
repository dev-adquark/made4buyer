import type { BrandLogo } from "@/lib/commerce/brand-logo-public";
import { optimizedImage } from "@/lib/images/delivery";

/**
 * A brand's verified official logo on a small neutral chip (pure; server or client). The chip box is
 * fixed by `height` and the logo's aspect ratio (clamped to 1–4× the height), with explicit
 * width/height, so nothing shifts while it loads. SVG files are linked directly (<img> never runs
 * SVG script); raster files go through the image optimizer when it serves that host. Without a
 * logo it renders the monogram only when asked, else nothing (the brand name text stays).
 */
export function chipBox(logo: { width: number; height: number }, height: number): { width: number; height: number } {
  const aspect = logo.width > 0 && logo.height > 0 ? logo.width / logo.height : 1;
  const width = Math.round(Math.min(height * 4, Math.max(height, height * aspect)));
  return { width, height };
}

const CHIP: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "none",
  boxSizing: "content-box",
  padding: 3,
  marginInlineEnd: 6,
  verticalAlign: "middle",
  background: "#fff",
  border: "1px solid rgba(0,0,0,.08)",
  borderRadius: 6,
  lineHeight: 0,
};

export default function LogoChip({ logo, name, height = 18, monogram = false, className }: { logo: BrandLogo | null; name: string; height?: number; monogram?: boolean; className?: string }) {
  if (!logo) {
    if (!monogram || !name) return null;
    return (
      <span className={className} data-brand-logo="monogram" aria-hidden="true" style={{ ...CHIP, width: height, height, lineHeight: 1, fontWeight: 600, fontSize: Math.round(height * 0.6), color: "#444" }}>
        {name.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  const box = chipBox(logo, height);
  const svg = logo.mime === "image/svg+xml" || /\.svg(\?|$)/i.test(logo.src);
  const d = svg ? { src: logo.src, srcSet: undefined, sizes: undefined } : optimizedImage(logo.src, { width: box.width, height: box.height, responsive: false });
  return (
    <span className={className} data-brand-logo={logo.source} style={{ ...CHIP, width: box.width, height: box.height }}>
      <img src={d.src} srcSet={d.srcSet} sizes={d.srcSet ? d.sizes : undefined} width={box.width} height={box.height} alt={`${name} logo`} loading="lazy" decoding="async" referrerPolicy="no-referrer" draggable={false} style={{ width: box.width, height: box.height, objectFit: "contain" }} />
    </span>
  );
}
