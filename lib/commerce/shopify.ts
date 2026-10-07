/**
 * Shopify product JSON (`/products/<handle>.js`, the public product data every Shopify theme reads).
 *
 * The product page function fetches it same-origin, only on a Shopify store (window.Shopify) and only
 * when robots.txt allows the .js path, and stores it raw as `shopifyProduct`. This module reads it:
 *
 *  - Prices are in cents (`price`, `compare_at_price`) in the store's active presentment currency
 *    (window.Shopify.currency.active, stored as `shopifyCurrency`).
 *  - One variant only, never a mix: the URL's `?variant=` when present (and nothing when that id is
 *    not one of the product's variants), else the first AVAILABLE variant, else none.
 *  - compare_at_price above price is the merchant's own "compare at" price → listPrice with
 *    listPriceType "CompareAtPrice". Equal, lower or absent: no list price.
 *  - The barcode becomes a GTIN only when it is a valid GTIN-8/12/13/14 (check digit verified).
 */

export type ShopifyVariant = {
  id: string;
  title: string | null;
  sku: string | null;
  gtin: string | null;
  /** Dollars (not cents). */
  price: number;
  compareAtPrice: number | null;
  available: boolean | null;
};

export type ShopifyOffer = {
  name: string;
  variant: ShopifyVariant;
  variantCount: number;
  /** How the variant was chosen. */
  chosenBy: "url" | "first-available";
  price: number;
  listPrice?: number;
  listPriceType?: "CompareAtPrice";
  availability?: "InStock" | "OutOfStock";
};

export type ShopifyReadResult = { ok: true; offer: ShopifyOffer } | { ok: false; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : null);

/** Shopify money in cents (integer, or an integer string) → dollars; null when absent or not a positive whole number of cents. */
export function centsToAmount(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return Math.round(n) / 100;
}

/** True when `digits` is a GTIN-8/12/13/14 with a correct GS1 check digit (and not all zeros). */
export function isValidGtin(raw: string | null | undefined): boolean {
  const d = (raw ?? "").trim();
  if (!/^\d+$/.test(d) || ![8, 12, 13, 14].includes(d.length) || /^0+$/.test(d)) return false;
  const digits = d.split("").map(Number);
  const check = digits.pop()!;
  // Weights 3,1,3,1… from the rightmost data digit.
  let sum = 0;
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += digits[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}

/** The barcode as a GTIN, only when it validates; spaces/hyphens are tolerated, nothing else. */
export function gtinFromBarcode(barcode: unknown): string | null {
  const s = str(barcode);
  if (!s) return null;
  const d = s.replace(/[\s-]/g, "");
  return isValidGtin(d) ? d : null;
}

export function readVariants(product: unknown): ShopifyVariant[] {
  if (!isObj(product) || !Array.isArray(product.variants)) return [];
  const out: ShopifyVariant[] = [];
  for (const v of product.variants) {
    if (!isObj(v)) continue;
    const id = str(v.id);
    const price = centsToAmount(v.price);
    if (!id || price == null) continue;
    out.push({
      id,
      title: str(v.title),
      sku: str(v.sku),
      gtin: gtinFromBarcode(v.barcode),
      price,
      compareAtPrice: centsToAmount(v.compare_at_price),
      available: typeof v.available === "boolean" ? v.available : null,
    });
  }
  return out;
}

/** `?variant=<id>` of the page URL, when present. */
export function variantParam(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const v = new URL(url).searchParams.get("variant");
    return v && /^\d+$/.test(v.trim()) ? v.trim() : null;
  } catch {
    return null;
  }
}

/** The URL's variant if present (none when it is not a variant of this product), else the first available variant, else none. */
export function chooseVariant(variants: ShopifyVariant[], pageUrl: string | null | undefined): { variant: ShopifyVariant; chosenBy: ShopifyOffer["chosenBy"] } | null {
  const wanted = variantParam(pageUrl);
  if (wanted) {
    const v = variants.find((x) => x.id === wanted);
    return v ? { variant: v, chosenBy: "url" } : null;
  }
  const first = variants.find((x) => x.available === true);
  return first ? { variant: first, chosenBy: "first-available" } : null;
}

/** Reads the stored Shopify product JSON for the page URL. Never guesses: anything unclear is a reason, not a value. */
export function readShopifyProduct(product: unknown, pageUrl: string | null | undefined): ShopifyReadResult {
  if (!isObj(product)) return { ok: false, reason: "no Shopify product JSON" };
  const title = str(product.title);
  if (!title) return { ok: false, reason: "Shopify product JSON has no title" };
  const variants = readVariants(product);
  if (!variants.length) return { ok: false, reason: "Shopify product JSON has no priced variant" };
  const chosen = chooseVariant(variants, pageUrl);
  if (!chosen) return { ok: false, reason: variantParam(pageUrl) ? `variant ${variantParam(pageUrl)} is not a variant of this product` : "no available variant (none chosen)" };
  const { variant, chosenBy } = chosen;
  const variantTitle = variant.title && variant.title !== "Default Title" ? variant.title : null;
  const name = variants.length > 1 && variantTitle ? `${title} – ${variantTitle}` : title;
  const offer: ShopifyOffer = { name, variant, variantCount: variants.length, chosenBy, price: variant.price };
  if (variant.compareAtPrice != null && variant.compareAtPrice > variant.price) {
    offer.listPrice = variant.compareAtPrice;
    offer.listPriceType = "CompareAtPrice";
  }
  if (variant.available === true) offer.availability = "InStock";
  else if (variant.available === false) offer.availability = "OutOfStock";
  return { ok: true, offer };
}
