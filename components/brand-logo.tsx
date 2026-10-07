import LogoChip from "@/components/brand-logo-chip";
import { brandLogoMap, lookupLogo } from "@/lib/commerce/brand-logo-public";

/** Server component: the brand's verified official logo chip (looked up by commerce brand slug, else a unique name), or nothing. */
export default async function BrandLogo({ slug, name, height, monogram, className }: { slug?: string | null; name: string; height?: number; monogram?: boolean; className?: string }) {
  const logo = lookupLogo(await brandLogoMap(), slug, slug ? null : name);
  return <LogoChip logo={logo} name={name} height={height} monogram={monogram} className={className} />;
}
