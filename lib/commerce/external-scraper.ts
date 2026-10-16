/**
 * The "digital_influx/product-data" Apify actor (apify.com/digital_influx/product-data): one call
 * can read many stores' public product pages at once, with real concurrency (up to 10 stores in
 * parallel) and its own documented policy that matches this app's: robots.txt is read first and a
 * Crawl-delay is respected, a blocked or JS-only page is reported (not bypassed) and costs nothing,
 * and it reads the same signals this app's own code already reads elsewhere (schema.org JSON-LD,
 * microdata, OpenGraph product tags, Shopify's product object) — just at Apify's scale instead of
 * our own serverless function's.
 *
 * Its own output (one row per product: name, brand, sku, gtin, price, listPrice, currency,
 * availability, variants, image, platform) is a different shape from PRODUCT_PAGE_FUNCTION's raw
 * page evidence, so rowToRawPayload() below builds an equivalent synthetic JSON-LD Product/Offer
 * page from it — the exact shape lib/commerce/normalize.ts already parses for every other source,
 * so nothing downstream of "here is a raw page" needs to know this run used a different actor.
 */
import type { CommerceBrand } from "@prisma/client";

export const EXTERNAL_SCRAPER_ACTOR_ID = "digital_influx~product-data";

export type ExternalProductRow = {
  type: "product" | "store";
  store?: string;
  url?: string;
  status: "ok" | "blocked_by_robots" | "blocked_by_site" | "not_found" | "no_product_data" | "error" | "invalid";
  name?: string | null;
  brand?: string | null;
  sku?: string | null;
  gtin?: string | null;
  price?: number | null;
  currency?: string | null;
  listPrice?: number | null;
  availability?: string | null;
  image?: string | null;
};

const AVAILABILITY_URL: Record<string, string> = {
  in_stock: "https://schema.org/InStock",
  limited_stock: "https://schema.org/LimitedAvailability",
  out_of_stock: "https://schema.org/OutOfStock",
  pre_order: "https://schema.org/PreOrder",
  back_order: "https://schema.org/BackOrder",
  made_to_order: "https://schema.org/MadeToOrder",
  in_store_only: "https://schema.org/InStoreOnly",
  discontinued: "https://schema.org/Discontinued",
  reserved: "https://schema.org/Reserved",
};

/**
 * One actor output row → a synthetic page in the exact shape PRODUCT_PAGE_FUNCTION returns
 * (lib/commerce/page-functions/product.ts): a single JSON-LD Product/Offer block built from the
 * row's already-clean fields. normalizeCommerceRecord (lib/commerce/normalize.ts) reads it exactly
 * as it reads a real page's JSON-LD — no change there. Returns null for a row this run should not
 * try to use (not a successfully read product, or no price at all).
 */
export function rowToRawPayload(row: ExternalProductRow): Record<string, unknown> | null {
  if (row.type !== "product" || row.status !== "ok" || !row.url || typeof row.price !== "number" || row.price <= 0) return null;
  const offer: Record<string, unknown> = { "@type": "Offer", price: row.price, priceCurrency: row.currency ?? "USD" };
  if (row.availability) offer.availability = AVAILABILITY_URL[row.availability] ?? `https://schema.org/${row.availability}`;
  if (typeof row.listPrice === "number" && row.listPrice > row.price) {
    offer.priceSpecification = [{ "@type": "UnitPriceSpecification", priceType: "https://schema.org/ListPrice", price: row.listPrice, priceCurrency: row.currency ?? "USD" }];
  }
  const jsonLd: Record<string, unknown> = { "@context": "https://schema.org", "@type": "Product", name: row.name ?? undefined, offers: offer };
  // The actor reads the image from the store page's own product data: it is the product's official
  // photo, so it goes where every other source's JSON-LD image is read from (deal-card photos).
  if (row.image) jsonLd.image = row.image;
  if (row.brand) jsonLd.brand = row.brand;
  if (row.sku) jsonLd.sku = row.sku;
  if (row.gtin) jsonLd.gtin13 = row.gtin;
  return {
    m4bCommerce: 1,
    url: row.url,
    requestUrl: row.url,
    crawlLabel: "PRODUCT",
    canonicalUrl: row.url,
    title: row.name ?? null,
    jsonLd: [jsonLd],
    meta: {},
    h1: row.name ?? null,
    breadcrumbs: [],
    specTables: [],
    images: row.image ? [{ src: row.image, alt: null }] : [],
    lang: null,
  };
}

/** Actor input: every brand's bare official domain as a store to read, bounded per store. */
export function buildExternalScraperInput(brands: Pick<CommerceBrand, "officialDomain">[], maxProductsPerStore: number): Record<string, unknown> {
  const storeUrls = [...new Set(brands.map((b) => b.officialDomain.trim().toLowerCase().replace(/^www\./, "")))];
  return {
    storeUrls,
    maxProductsPerStore,
    compareWithPreviousRun: false,
    includeVariants: false,
    includeDescription: false,
    maxConcurrency: 10,
  };
}
