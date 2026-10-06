/**
 * Field-level product facts with provenance. Every value Made4Buyers shows about a product is
 * traceable to the source that stated it and when; nothing is guessed. Shared by the page
 * extractor (lib/products/page-extract.ts), the resolver (lib/products/facts.ts) and the
 * enrichment job (lib/products/enrich.ts).
 */

/** Where a fact came from, strongest authority first (see SOURCE_AUTHORITY). */
export type FactSource =
  | "MANUFACTURER" // the brand's own product page / specifications
  | "STRUCTURED_FEED" // approved product API or feed (e.g. Sovrn price comparison, retailer API)
  | "RETAILER" // a retailer's product page (structured data)
  | "REVIEW_SOURCE" // the publication that reviewed the product (its structured data)
  | "SOVRN" // Sovrn commerce data (coupons, affiliate links)
  | "SECONDARY"; // any other legitimate page

export const SOURCE_AUTHORITY: Record<FactSource, number> = {
  MANUFACTURER: 100,
  STRUCTURED_FEED: 80,
  RETAILER: 60,
  REVIEW_SOURCE: 40,
  SOVRN: 40,
  SECONDARY: 20,
};

/** Resolution state of one field. Internal; shown in Admin, never as a score to readers. */
export type FactStatus = "VERIFIED" | "SUPPORTED" | "CONFLICTING" | "STALE" | "UNKNOWN" | "UNAVAILABLE" | "NOT_APPLICABLE";

export type FactField =
  | "brand"
  | "productName"
  | "model"
  | "mpn"
  | "sku"
  | "gtin"
  | "productType"
  | "category"
  | "manufacturer"
  | "description"
  | "price"
  | "listPrice"
  | "currency"
  | "availability"
  | "retailer"
  | "retailerUrl"
  | "officialUrl"
  | "rating"
  | "reviewCount"
  | "pros"
  | "cons"
  | "color"
  | "weight"
  | "dimensions"
  | "material"
  | "capacity"
  | "warranty"
  | "compatibility"
  | "features"
  | "platform";

/** How a field ages: price-like data goes stale in hours, identity in months. */
export type Volatility = "HIGH" | "MEDIUM" | "LOW";

/** One value for one field, as one source stated it. */
export type Fact = {
  field: FactField;
  /** string | number | string[]; prices are numbers in `currency` (a separate fact, or `unit`). */
  value: string | number | string[];
  /** Unit or currency for numeric values, e.g. "USD", "kg", "L". */
  unit?: string | null;
  source: FactSource;
  sourceName: string;
  sourceUrl: string | null;
  /** When the source stated it (crawl/fetch time of that page; never "now" for old data). */
  observedAt: Date;
  /** Why we believe this page is the same product: "gtin", "mpn", "model", "brand+name", "review-source". */
  matchBasis: string;
};

export type ResolvedFact = {
  field: FactField;
  status: FactStatus;
  /** The value to use, or null when UNKNOWN / UNAVAILABLE / NOT_APPLICABLE / unresolved CONFLICTING. */
  value: string | number | string[] | null;
  unit?: string | null;
  /** The winning fact (null when none). */
  chosen: Fact | null;
  /** Every other fact seen for this field (for Admin). */
  alternatives: Fact[];
  /** Plain-language reason, e.g. "manufacturer and retailer agree", "price older than 48 h". */
  note: string;
};

/** Normalised product data read from one product page's structured data. Absent fields are omitted. */
export type ExtractedProduct = {
  url: string;
  name?: string;
  brand?: string;
  manufacturer?: string;
  model?: string;
  mpn?: string;
  sku?: string;
  gtin?: string;
  description?: string;
  category?: string;
  color?: string;
  material?: string;
  weight?: { value: number; unit: string } | string;
  dimensions?: string;
  capacity?: string;
  warranty?: string;
  compatibility?: string[];
  features?: string[];
  price?: number;
  listPrice?: number;
  currency?: string;
  availability?: string;
  seller?: string;
  rating?: number;
  ratingScale?: number;
  reviewCount?: number;
  /** Other name/value specs from additionalProperty, kept verbatim. */
  specs?: Array<{ name: string; value: string }>;
  /** Which structured source produced it: "json-ld", "microdata", "meta". */
  extractedFrom: string[];
};

/** The product an entity is known to be, for exact matching before copying any data. */
export type ProductIdentity = {
  brand?: string | null;
  name: string;
  model?: string | null;
  mpn?: string | null;
  sku?: string | null;
  gtin?: string | null;
};

export type MatchResult = { match: boolean; basis: string; reason: string };
