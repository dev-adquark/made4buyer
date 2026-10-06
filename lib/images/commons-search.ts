import { config } from "@/lib/config";
import { safeFetch } from "@/lib/net/safe-fetch";
import { conflictingVersion, distinctiveTokens } from "@/lib/pipeline/pexels";
import { isCommonsFileUrl, isFreeLicence, type CommonsImage } from "@/lib/products/commons-image";
import { tokenize } from "@/lib/util/text";

/**
 * Free fallback for an exact-product photo: a Wikimedia Commons file search. A file qualifies only
 * when its own title names the product exactly (the brand and every distinctive token of the
 * product name, with no different version number), it is a photo (JPEG/PNG/WebP, at least 800 px
 * wide) and it carries a free licence. Anything less is not presented as the product.
 */

const commonsApi = () => process.env.COMMONS_API_URL || "https://commons.wikimedia.org/w/api.php";
export const commonsSearchEnabled = () => !["0", "false", "off", "no"].includes((process.env.COMMONS_SEARCH_ENABLED ?? "").trim().toLowerCase());

type Page = { title?: string; imageinfo?: Array<{ url?: string; descriptionurl?: string; mime?: string; width?: number; extmetadata?: Record<string, { value?: string }> }> };

/** True when a Commons file title names exactly this product. */
export function fileTitleMatches(fileTitle: string, productName: string, brand: string | null | undefined): boolean {
  if (!brand) return false;
  const title = ` ${tokenize(fileTitle.replace(/^file:/i, "").replace(/\.[a-z0-9]+$/i, "").replace(/_/g, " ")).join(" ")} `;
  const brandTokens = tokenize(brand);
  if (!brandTokens.length || !title.includes(` ${brandTokens.join(" ")} `)) return false;
  const tokens = distinctiveTokens(productName, brand);
  if (!tokens.length || !tokens.every((t) => title.includes(` ${t} `))) return false;
  // Numbers in the product name (model, generation, size) must all appear too.
  const numbers = tokenize(productName).filter((t) => /\d/.test(t));
  if (!numbers.every((n) => title.includes(` ${n} `))) return false;
  return !conflictingVersion(title, productName, brand, tokens);
}

export async function searchCommonsProductPhoto(input: { productName: string; brand?: string | null; productEntityId?: string | null }, now = new Date()): Promise<CommonsImage | null> {
  if (!commonsSearchEnabled() || !input.brand) return null;
  const name = input.productName.toLowerCase().startsWith(input.brand.toLowerCase()) ? input.productName : `${input.brand} ${input.productName}`;
  const q = new URLSearchParams({ action: "query", generator: "search", gsrnamespace: "6", gsrsearch: `${name} filetype:bitmap`, gsrlimit: "12", prop: "imageinfo", iiprop: "url|mime|size|extmetadata", format: "json" });
  const res = await safeFetch(`${commonsApi()}?${q}`, { timeoutMs: 12_000, maxRedirects: 2, readBody: true, maxBytes: 3_000_000, standardPortsOnly: true, headers: { Accept: "application/json", "User-Agent": `Made4BuyersBot/1.0 (${config.siteUrl()}; product images)` } });
  if (!res.ok || !res.body) return null;
  let pages: Page[] = [];
  try {
    pages = Object.values((JSON.parse(res.body) as { query?: { pages?: Record<string, Page> } }).query?.pages ?? {});
  } catch {
    return null;
  }
  for (const p of pages) {
    const info = p.imageinfo?.[0];
    if (!p.title || !info?.url || !info.descriptionurl) continue;
    if (!/^image\/(jpeg|png|webp)$/.test(info.mime ?? "") || (info.width ?? 0) < 800) continue;
    if (!isCommonsFileUrl(info.url)) continue;
    const license = info.extmetadata?.LicenseShortName?.value?.trim() ?? "";
    if (!isFreeLicence(license)) continue;
    if (!fileTitleMatches(p.title, input.productName, input.brand)) continue;
    const artist = info.extmetadata?.Artist?.value?.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    return {
      url: info.url,
      license,
      attribution: `${artist ? `${artist} / ` : ""}Wikimedia Commons, ${license}`,
      filePageUrl: info.descriptionurl,
      matchBasis: "commons:file-title",
      matchConfidence: 0.8,
      productEntityId: input.productEntityId ?? "",
      productName: input.productName,
      observedAt: now,
    };
  }
  return null;
}
