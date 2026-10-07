import { config } from "@/lib/config";
import { safeFetch } from "@/lib/net/safe-fetch";
import { stripLeadingBrand } from "@/lib/pipeline/brands";
import { conflictingVersion, distinctiveTokens } from "@/lib/pipeline/pexels";
import { isCommonsFileUrl, isFreeLicence, type CommonsImage } from "@/lib/products/commons-image";
import { parseCommons } from "@/lib/util/image-url";
import { tokenize } from "@/lib/util/text";

/**
 * Free fallback for an exact-product photo: a Wikimedia Commons file search. A file qualifies only
 * when its own title names the product exactly (the brand and every distinctive token of the
 * product name, with no different version number), it is a photo (JPEG/PNG/WebP, at least 800 px
 * wide) and it carries a free licence. Anything less is not presented as the product.
 * The product's own name must appear as one phrase (its words in order, nothing in between).
 *
 * A file whose title names several products ("SAMSUNG Galaxy Z Fold 8 Ultra, SAMSUNG Galaxy Z
 * Fold 8 & SAMSUNG Galaxy Z Flip 8") is a group shot, never one product's exact photo, even when
 * the product's own name is in it (namesSeveralProducts).
 */

const commonsApi = () => process.env.COMMONS_API_URL || "https://commons.wikimedia.org/w/api.php";
export const commonsSearchEnabled = () => !["0", "false", "off", "no"].includes((process.env.COMMONS_SEARCH_ENABLED ?? "").trim().toLowerCase());

type Page = { title?: string; imageinfo?: Array<{ url?: string; descriptionurl?: string; mime?: string; width?: number; extmetadata?: Record<string, { value?: string }> }> };

const cleanTitle = (fileTitle: string) => fileTitle.replace(/^file:/i, "").replace(/\.[a-z0-9]+$/i, "").replace(/_/g, " ");

/** The Commons file title of an upload.wikimedia.org URL (original or thumbnail), or of a File: page URL. */
export function commonsFileTitle(url: string | null | undefined): string | null {
  if (!url) return null;
  const decode = (v: string) => {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };
  const file = parseCommons(url);
  if (file) return decode(file.name);
  const page = /\/wiki\/(File:[^?#]+)/i.exec(url);
  return page ? decode(page[1]) : null;
}

// Where a title lists several things: "A, B & C", "A and B", "A vs B", "A + B", "A / B", "A with B".
const LIST_SEPARATOR = /\s*(?:,|;|&|\+|\/|\band\b|\bvs\.?(?=\s|$)|\bversus\b|\bwith\b|\bnext to\b|\bbeside\b)\s*/i;
// Camera file names ("IMG 1234", "DSC01234", "PXL 2024…") and years are not model numbers.
const CAMERA_PREFIX = new Set(["img", "dsc", "dscn", "dscf", "dcim", "pxl", "imgp", "mvimg", "photo", "pic", "p", "gopr", "dji"]);
const isModelToken = (t: string, prev: string | undefined) =>
  /\d/.test(t) && !/^(19|20)\d{2}$/.test(t) && !/^\d{5,}$/.test(t) && !/^(img|dsc|dscn|dscf|pxl|imgp|gopr|dji)\d+$/.test(t) && !(prev && CAMERA_PREFIX.has(prev));

/**
 * True when a Commons file title names more than one product: two list items each mention the
 * brand, a distinctive word of the product name or a model number, or the brand / the product's
 * first distinctive word appears twice. Such a file is a group shot, not this product.
 */
export function namesSeveralProducts(fileTitle: string, productName: string, brand: string | null | undefined): boolean {
  const raw = cleanTitle(fileTitle);
  const brandTokens = tokenize(brand ?? "");
  const brandPhrase = brandTokens.join(" ");
  const distinctive = distinctiveTokens(productName, brand);
  const count = (hay: string, needle: string) => (needle ? hay.split(` ${needle} `).length - 1 : 0);
  const whole = ` ${tokenize(raw).join(" ")} `;
  if (brandPhrase && count(whole, brandPhrase) > 1) return true;
  if (distinctive[0] && count(whole, distinctive[0]) > 1) return true;
  // Each list item that names a product (the brand, a distinctive word, a model number) is one product.
  const segments = raw.split(LIST_SEPARATOR).map((part) => tokenize(part)).filter((seg) => seg.length);
  const naming = segments.filter((seg) => {
    const text = ` ${seg.join(" ")} `;
    return (brandPhrase && text.includes(` ${brandPhrase} `)) || distinctive.some((t) => text.includes(` ${t} `)) || seg.some((t, j) => isModelToken(t, seg[j - 1]));
  });
  return naming.length > 1;
}

/** True when a Commons file title names exactly this product (and only it). */
export function fileTitleMatches(fileTitle: string, productName: string, brand: string | null | undefined): boolean {
  if (!brand) return false;
  const title = ` ${tokenize(cleanTitle(fileTitle)).join(" ")} `;
  const brandTokens = tokenize(brand);
  if (!brandTokens.length || !title.includes(` ${brandTokens.join(" ")} `)) return false;
  const tokens = distinctiveTokens(productName, brand);
  if (!tokens.length || !tokens.every((t) => title.includes(` ${t} `))) return false;
  // Numbers in the product name (model, generation, size) must all appear too.
  const numbers = tokenize(productName).filter((t) => /\d/.test(t));
  if (!numbers.every((n) => title.includes(` ${n} `))) return false;
  // …as the product's own phrase, in order: "Google Pixel Fold, shown in Shibuya Stream 11" has
  // "pixel" and "11" but is not a photo of the Pixel 11.
  const phrase = tokenize(stripLeadingBrand(productName, brand)).join(" ");
  if (!phrase || !title.includes(` ${phrase} `)) return false;
  if (conflictingVersion(title, productName, brand, tokens)) return false;
  return !namesSeveralProducts(fileTitle, productName, brand);
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
