import type { ExtractedProduct, FactSource, MatchResult, ProductIdentity } from "@/lib/products/types";

/**
 * Server-side product-page reading and strict product matching.
 *
 * - `extractProductFromHtml` reads a product page's own structured data (JSON-LD first, a few meta
 *   tags as fallback) without a DOM. It picks the product the page is *about*; when a page lists
 *   several unrelated products and none clearly is the page's own, it returns null.
 * - `sameProduct` decides whether an extracted product is exactly the product we know. It never
 *   accepts a similar-but-different product (Pro vs Plus, 2nd vs 3rd gen, 128GB vs 256GB …).
 * - `classifySource` labels a URL MANUFACTURER / RETAILER / REVIEW_SOURCE / SECONDARY,
 *   conservatively (unsure → SECONDARY, never MANUFACTURER).
 *
 * Pure functions, no I/O, no dependencies.
 */

// ---------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  reg: "®",
  trade: "™",
  copy: "©",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  times: "×",
  deg: "°",
  eacute: "é",
  egrave: "è",
  aacute: "á",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
};

/** Decodes HTML character references (named subset, decimal and hex). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    const v = NAMED_ENTITIES[ref.toLowerCase()];
    return v ?? m;
  });
}

function stripTags(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]*>/g, " ");
}

function cleanText(s: string): string {
  // Decode twice: double-encoded "&amp;amp;" is common in CMS output.
  return decodeEntities(decodeEntities(stripTags(s))).replace(/\s+/g, " ").trim();
}

/** A trimmed string from a JSON-LD value: string, number, {@value}, {name}, or the first array item. */
function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return cleanText(v) || undefined;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (Array.isArray(v)) {
    for (const x of v) {
      const s = str(x);
      if (s) return s;
    }
    return undefined;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o["@value"] != null) return str(o["@value"]);
    if (o.name != null) return str(o.name);
  }
  return undefined;
}

/** Plain string only (no {name} objects), for code-like fields. */
function scalar(v: unknown): string | undefined {
  if (Array.isArray(v)) return scalar(v[0]);
  if (v && typeof v === "object" && (v as Record<string, unknown>)["@value"] != null)
    return scalar((v as Record<string, unknown>)["@value"]);
  if (typeof v === "string" || typeof v === "number") return str(v);
  return undefined;
}

/** Parses a price-like value: 499, "499.00", "$1,299.99", "1.299,99", "49,95". */
function parseNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  const s = v.replace(/[^\d.,]/g, "");
  if (!s) return undefined;
  let n: number;
  if (/^\d+(\.\d+)?$/.test(s)) n = Number(s);
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) n = Number(s.replace(/,/g, ""));
  else if (/^\d+,\d{1,2}$/.test(s)) n = Number(s.replace(",", "."));
  else if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) n = Number(s.replace(/\./g, "").replace(",", "."));
  else return undefined;
  return Number.isFinite(n) ? n : undefined;
}

function positive(v: unknown): number | undefined {
  const n = parseNumber(v);
  return n != null && n > 0 ? n : undefined;
}

/** "https://schema.org/InStock" → "InStock". */
function stripSchema(v: string): string {
  return v.replace(/^https?:\/\/(www\.)?schema\.org\//i, "").replace(/^schema:/i, "");
}

const asArray = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------------------------------------
// HTML scanning
// ---------------------------------------------------------------------------------------------

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}

function jsonLdBlocks(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const type = (parseAttrs(m[1]).type || "").trim().toLowerCase();
    if (type === "application/ld+json") out.push(m[2]);
  }
  return out;
}

/** Tolerant JSON-LD parse: raw → entity-decoded → cleaned (comments, CDATA, control chars, trailing commas). */
function parseJsonLd(raw: string): unknown | undefined {
  const attempts: Array<(s: string) => string> = [
    (s) => s,
    (s) => decodeEntities(s),
    (s) =>
      decodeEntities(s)
        .replace(/^\s*<!--/, "")
        .replace(/-->\s*$/, "")
        .replace(/<!\[CDATA\[|\]\]>/g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/[\u0000-\u001f]+/g, " ")
        .replace(/,\s*([}\]])/g, "$1")
        .replace(/;\s*$/, ""),
  ];
  for (const fix of attempts) {
    const s = fix(raw).trim();
    if (!s) return undefined;
    try {
      return JSON.parse(s);
    } catch {
      // try the next repair
    }
  }
  return undefined;
}

function readMeta(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<meta\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const a = parseAttrs(m[1]);
    const key = (a.property || a.name || a.itemprop || "").trim().toLowerCase();
    const content = a.content != null ? cleanText(a.content) : "";
    if (key && content && !out.has(key)) out.set(key, content);
  }
  return out;
}

function firstTagText(html: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "i").exec(html);
  return m ? cleanText(m[1]) || undefined : undefined;
}

// ---------------------------------------------------------------------------------------------
// JSON-LD node walk
// ---------------------------------------------------------------------------------------------

const PRODUCT_TYPES = new Set([
  "product",
  "productmodel",
  "individualproduct",
  "softwareapplication",
  "mobileapplication",
  "webapplication",
]);

function typesOf(n: Record<string, unknown>): string[] {
  return asArray(n["@type"]).map((t) =>
    String(t)
      .replace(/^https?:\/\/(www\.)?schema\.org\//i, "")
      .replace(/^schema:/i, "")
      .toLowerCase(),
  );
}

type Candidate = { node: Record<string, unknown>; nested: boolean };

/** Every product-type node at any depth; `nested` marks products inside another product (related, isVariantOf …). */
function collectProducts(roots: unknown[]): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<object>();
  const walk = (v: unknown, insideProduct: boolean, depth: number) => {
    if (!v || typeof v !== "object" || depth > 12) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, insideProduct, depth + 1);
      return;
    }
    if (seen.has(v)) return;
    seen.add(v);
    const n = v as Record<string, unknown>;
    const isProduct = typesOf(n).some((t) => PRODUCT_TYPES.has(t));
    if (isProduct) out.push({ node: n, nested: insideProduct });
    for (const k of Object.keys(n)) if (k !== "@context") walk(n[k], insideProduct || isProduct, depth + 1);
  };
  for (const r of roots) walk(r, false, 0);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------------------------

const UNIT_CODES: Record<string, string> = {
  KGM: "kg",
  GRM: "g",
  MGM: "mg",
  LBR: "lb",
  ONZ: "oz",
  CMT: "cm",
  MMT: "mm",
  MTR: "m",
  INH: "in",
  FOT: "ft",
  LTR: "L",
  MLT: "mL",
  WTT: "W",
};

function unitOf(o: Record<string, unknown>): string | undefined {
  const text = str(o.unitText);
  if (text) return text;
  const code = str(o.unitCode);
  return code ? (UNIT_CODES[code.toUpperCase()] ?? code) : undefined;
}

/** QuantitativeValue → {value, unit}; a plain string stays a string. */
function quantity(v: unknown): { value: number; unit: string } | string | undefined {
  const first = Array.isArray(v) ? v[0] : v;
  if (isObj(first)) {
    const value = parseNumber(first.value);
    const unit = unitOf(first) ?? "";
    if (value != null && value > 0) return { value, unit };
    return str(first.value);
  }
  return str(first);
}

function dimensionsOf(n: Record<string, unknown>): string | undefined {
  const w = quantity(n.width);
  const h = quantity(n.height);
  const d = quantity(n.depth);
  if (!w || !h || !d) return undefined;
  const parts = [w, h, d];
  if (parts.every((p) => typeof p === "object")) {
    const qs = parts as Array<{ value: number; unit: string }>;
    const units = new Set(qs.map((q) => q.unit));
    if (units.size === 1) return `${qs.map((q) => q.value).join(" x ")}${qs[0].unit ? ` ${qs[0].unit}` : ""}`;
    return qs.map((q) => `${q.value}${q.unit ? ` ${q.unit}` : ""}`).join(" x ");
  }
  return parts.map((p) => (typeof p === "object" ? `${p.value}${p.unit ? ` ${p.unit}` : ""}` : p)).join(" x ");
}

/** brand / manufacturer: string, {name}, or array; empty {} ignored. */
function orgName(v: unknown): string | undefined {
  for (const x of asArray(v)) {
    const s = typeof x === "string" ? cleanText(x) : isObj(x) ? str(x.name) : undefined;
    if (s) return s;
  }
  return undefined;
}

function normalizeGtinValue(v: unknown): string | undefined {
  const s = scalar(v);
  if (!s) return undefined;
  const digits = s.replace(/\D/g, "");
  return [8, 12, 13, 14].includes(digits.length) && !/^0+$/.test(digits) ? digits : undefined;
}

function listOf(v: string): string[] {
  return v
    .split(/\s*[,;|•\n]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

type OfferInfo = { price?: number; listPrice?: number; currency?: string; availability?: string; seller?: string };

function listPriceFromSpec(spec: unknown): number | undefined {
  for (const s of asArray(spec)) {
    if (!isObj(s)) continue;
    const t = stripSchema(str(s.priceType) ?? "").toLowerCase();
    if (t === "listprice" || t === "strikethroughprice" || t === "msrp") {
      const p = positive(s.price);
      if (p) return p;
    }
  }
  return undefined;
}

function salePriceFromSpec(spec: unknown): { price?: number; currency?: string } {
  for (const s of asArray(spec)) {
    if (!isObj(s)) continue;
    const t = stripSchema(str(s.priceType) ?? "").toLowerCase();
    if (t && t !== "saleprice") continue;
    const p = positive(s.price);
    if (p) return { price: p, currency: str(s.priceCurrency) };
  }
  return {};
}

function readOffer(o: Record<string, unknown>): OfferInfo {
  const types = typesOf(o);
  const aggregate = types.includes("aggregateoffer");
  const info: OfferInfo = {};
  if (aggregate) {
    info.price = positive(o.lowPrice) ?? positive(o.price);
    // highPrice in an AggregateOffer is the dearest seller, not a list price: never used as one.
    if (info.price == null) {
      // Some AggregateOffers carry their own Offer list.
      for (const sub of asArray(o.offers)) {
        if (!isObj(sub)) continue;
        const s = readOffer(sub);
        if (s.price != null) {
          Object.assign(info, { ...s, seller: undefined });
          break;
        }
      }
    }
  } else {
    info.price = positive(o.price);
    if (info.price == null) {
      const sp = salePriceFromSpec(o.priceSpecification);
      info.price = sp.price;
      if (sp.currency) info.currency = sp.currency;
    }
    const high = positive(o.highPrice);
    if (high != null && info.price != null && high > info.price) info.listPrice = high;
  }
  const lp = listPriceFromSpec(o.priceSpecification);
  if (lp != null && (info.price == null || lp >= info.price)) info.listPrice = lp;
  const cur = str(o.priceCurrency) ?? info.currency;
  if (cur && /^[a-z]{3}$/i.test(cur)) info.currency = cur.toUpperCase();
  else delete info.currency;
  const av = str(o.availability);
  if (av) info.availability = stripSchema(av);
  const seller = orgName(o.seller);
  if (seller) info.seller = seller;
  return info;
}

function offersOf(n: Record<string, unknown>): OfferInfo | undefined {
  const offers = asArray(n.offers).filter(isObj);
  if (!offers.length) return undefined;
  const infos = offers.map(readOffer);
  return infos.find((i) => i.price != null) ?? infos[0];
}

function mapNode(n: Record<string, unknown>, pageUrl: string): ExtractedProduct {
  const p: ExtractedProduct = { url: pageUrl, extractedFrom: ["json-ld"] };
  const set = <K extends keyof ExtractedProduct>(k: K, v: ExtractedProduct[K] | undefined) => {
    if (v != null && v !== "" && !(Array.isArray(v) && v.length === 0)) p[k] = v;
  };
  set("name", str(n.name));
  set("brand", orgName(n.brand));
  set("manufacturer", orgName(n.manufacturer));
  set("model", str(n.model));
  set("mpn", scalar(n.mpn));
  set("sku", scalar(n.sku));
  set(
    "gtin",
    normalizeGtinValue(n.gtin14) ??
      normalizeGtinValue(n.gtin13) ??
      normalizeGtinValue(n.gtin12) ??
      normalizeGtinValue(n.gtin8) ??
      normalizeGtinValue(n.gtin),
  );
  const desc = str(n.description);
  if (desc) set("description", desc.length > 1000 ? `${desc.slice(0, 999).trimEnd()}…` : desc);
  const cat = asArray(n.category)
    .map((c) => str(c))
    .filter((c): c is string => !!c);
  set("category", cat.length ? cat.join(" > ") : undefined);
  set("color", str(n.color));
  set("material", str(n.material));
  set("weight", quantity(n.weight));
  set("dimensions", dimensionsOf(n));

  const specs: Array<{ name: string; value: string }> = [];
  for (const prop of asArray(n.additionalProperty)) {
    if (!isObj(prop)) continue;
    const name = str(prop.name) ?? str(prop.propertyID);
    const raw = asArray(prop.value)
      .map((v) => str(v))
      .filter((v): v is string => !!v)
      .join(", ");
    if (!name || !raw) continue;
    const unit = unitOf(prop);
    const value = unit && !raw.toLowerCase().endsWith(unit.toLowerCase()) ? `${raw} ${unit}` : raw;
    specs.push({ name, value });
    const key = name.toLowerCase();
    if (!p.capacity && /\b(capacity|volume)\b/.test(key)) p.capacity = value;
    else if (!p.warranty && /\bwarrant/.test(key)) p.warranty = value;
    else if (!p.compatibility && /\bcompatib/.test(key)) p.compatibility = listOf(value);
    else if (!p.features && /^(key |special |product )?features?$/.test(key)) p.features = listOf(value);
  }
  set("specs", specs);

  const offer = offersOf(n);
  if (offer) {
    set("price", offer.price);
    set("listPrice", offer.listPrice);
    set("currency", offer.currency);
    set("availability", offer.availability);
    set("seller", offer.seller);
  }

  const agg = isObj(n.aggregateRating) ? n.aggregateRating : undefined;
  if (agg) {
    set("rating", positive(agg.ratingValue));
    if (p.rating != null) set("ratingScale", positive(agg.bestRating));
    set("reviewCount", positive(agg.reviewCount) ?? positive(agg.ratingCount));
  }
  return p;
}

// ---------------------------------------------------------------------------------------------
// Picking the page's own product
// ---------------------------------------------------------------------------------------------

/** entityKey-like identity key (case, accents, spacing, punctuation ignored). */
function nameKey(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9+#]+/g, "");
}

const TRACKING = /^(utm_\w+|gclid|fbclid|msclkid|srsltid|ref|ref_|tag|cid|affid|irclickid)$/i;

function normUrl(u: string, base?: string): string | undefined {
  try {
    const url = new URL(u, base);
    if (!/^https?:$/.test(url.protocol)) return undefined;
    const params = [...url.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort();
    const q = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join("&")}` : "";
    const path = url.pathname.replace(/\/+$/, "").toLowerCase();
    return `${url.hostname.toLowerCase().replace(/^www\./, "")}${path}${q}`;
  } catch {
    return undefined;
  }
}

function urlMatches(n: Record<string, unknown>, pageUrl: string): boolean {
  const page = normUrl(pageUrl);
  if (!page) return false;
  return [n.url, n["@id"]].some((v) => {
    const s = scalar(v);
    return !!s && normUrl(s, pageUrl) === page;
  });
}

function richness(p: ExtractedProduct): number {
  return (p.price != null ? 100 : 0) + Object.keys(p).length;
}

function sameCodes(a: ExtractedProduct, b: ExtractedProduct): boolean {
  if (a.gtin && b.gtin && a.gtin.padStart(14, "0") !== b.gtin.padStart(14, "0")) return false;
  if (a.mpn && b.mpn && codeKey(a.mpn) !== codeKey(b.mpn)) return false;
  if (a.sku && b.sku && codeKey(a.sku) !== codeKey(b.sku)) return false;
  return true;
}

/** Merges duplicate descriptions of one product (same name, no conflicting codes) into the richest one. */
function mergeGroup(group: ExtractedProduct[]): ExtractedProduct | null {
  const sorted = [...group].sort((a, b) => richness(b) - richness(a));
  const best = { ...sorted[0] };
  for (const other of sorted.slice(1)) {
    if (!sameCodes(best, other)) return null; // same name, different codes: variants → ambiguous
    for (const [k, v] of Object.entries(other) as Array<[keyof ExtractedProduct, unknown]>) {
      if (k === "extractedFrom" || k === "url") continue;
      if (best[k] == null) (best as Record<string, unknown>)[k] = v;
    }
  }
  return best;
}

function titleSegments(html: string, meta: Map<string, string>): string[] {
  const raw = [meta.get("og:title"), meta.get("twitter:title"), firstTagText(html, "h1"), firstTagText(html, "title")];
  const out = new Set<string>();
  for (const t of raw) {
    if (!t) continue;
    out.add(nameKey(t));
    for (const seg of t.split(/\s+[|–—-]\s+|\s*:\s+/)) if (seg.trim()) out.add(nameKey(seg));
  }
  out.delete("");
  return [...out];
}

function pickProduct(html: string, pageUrl: string, cands: Candidate[], meta: Map<string, string>): ExtractedProduct | null {
  const mapped = cands
    .map((c) => ({ ...c, p: mapNode(c.node, pageUrl), urlHit: urlMatches(c.node, pageUrl) }))
    .filter((c) => c.p.name);
  if (!mapped.length) return null;

  const fromGroup = (list: typeof mapped): ExtractedProduct | null => {
    const keys = new Set(list.map((c) => nameKey(c.p.name!)));
    if (keys.size !== 1) return null;
    // Include every same-named description on the page (e.g. a second block carrying the offers).
    const key = [...keys][0];
    return mergeGroup(mapped.filter((c) => nameKey(c.p.name!) === key).map((c) => c.p));
  };

  // 1. Only one product described (possibly several times).
  const single = fromGroup(mapped);
  if (single) return single;
  // 2. The node that says it is this page.
  const byUrl = mapped.filter((c) => c.urlHit);
  if (byUrl.length) return fromGroup(byUrl);
  // 3. One top-level product; the rest are nested inside it (related / accessories / variants of).
  const roots = mapped.filter((c) => !c.nested);
  if (roots.length && roots.length < mapped.length) {
    const r = fromGroup(roots);
    if (r) return r;
  }
  // 4. The product the page's title / h1 names, exactly.
  const titles = titleSegments(html, meta);
  if (titles.length) {
    const hits = mapped.filter((c) => titles.includes(nameKey(c.p.name!)));
    return hits.length ? fromGroup(hits) : null;
  }
  // 5. No title to check against: only when exactly one product carries offers.
  const withOffers = mapped.filter((c) => c.node.offers != null);
  return withOffers.length ? fromGroup(withOffers) : null;
}

function metaAvailability(v: string): string {
  const k = v.toLowerCase().replace(/[^a-z]/g, "");
  const map: Record<string, string> = {
    instock: "InStock",
    available: "InStock",
    oos: "OutOfStock",
    outofstock: "OutOfStock",
    preorder: "PreOrder",
    backorder: "BackOrder",
    discontinued: "Discontinued",
    limitedavailability: "LimitedAvailability",
  };
  return map[k] ?? stripSchema(v);
}

/**
 * Reads the page's own product from its structured data. Returns null when no product name can be
 * established or when the page lists several products and none is clearly the page's own.
 */
export function extractProductFromHtml(html: string, pageUrl: string): ExtractedProduct | null {
  if (!html) return null;
  const roots = jsonLdBlocks(html)
    .map(parseJsonLd)
    .filter((v) => v !== undefined);
  const cands = collectProducts(roots);
  const meta = readMeta(html);

  let product: ExtractedProduct | null = null;
  if (cands.length) {
    product = pickProduct(html, pageUrl, cands, meta);
    if (!product) return null; // products present but ambiguous: never guess
  } else {
    const ogType = (meta.get("og:type") || "").toLowerCase();
    if (ogType === "product" || ogType === "product.item" || ogType === "og:product") {
      let name = meta.get("og:title");
      const site = meta.get("og:site_name");
      if (name && site) {
        const esc = site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        name = name.replace(new RegExp(`\\s*[|–—-]\\s*${esc}\\s*$`, "i"), "").trim();
      }
      if (name) product = { url: pageUrl, name, extractedFrom: [] };
    }
  }
  if (!product || !product.name) return null;

  let usedMeta = false;
  if (product.price == null) {
    const price = positive(meta.get("product:price:amount") ?? meta.get("og:price:amount"));
    if (price != null) {
      product.price = price;
      usedMeta = true;
      if (!product.currency) {
        const cur = meta.get("product:price:currency") ?? meta.get("og:price:currency");
        if (cur && /^[a-z]{3}$/i.test(cur)) product.currency = cur.toUpperCase();
      }
    }
  }
  if (!product.availability) {
    const av = meta.get("product:availability") ?? meta.get("og:availability");
    if (av) {
      product.availability = metaAvailability(av);
      usedMeta = true;
    }
  }
  if (!product.brand) {
    const brand = meta.get("product:brand");
    if (brand) {
      product.brand = brand;
      usedMeta = true;
    }
  }
  if (usedMeta || !product.extractedFrom.length) product.extractedFrom = [...product.extractedFrom, "meta"];
  return product;
}

// ---------------------------------------------------------------------------------------------
// Strict matching
// ---------------------------------------------------------------------------------------------

/** Case/space/hyphen/punctuation-insensitive code key for MPN / model / SKU. */
function codeKey(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]/g, "");
}

export function normalizeGtin(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = v.replace(/\D/g, "");
  if (![8, 12, 13, 14].includes(d.length) || /^0+$/.test(d)) return null;
  return d.padStart(14, "0");
}

const LEGAL_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "co",
  "corp",
  "corporation",
  "company",
  "gmbh",
  "ag",
  "sa",
  "sas",
  "srl",
  "spa",
  "plc",
  "bv",
  "nv",
  "pty",
  "kk",
  "oy",
  "ab",
  "as",
  "the",
]);

function baseNorm(s: string): string {
  return decodeEntities(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’‘`´]/g, "");
}

/** "De'Longhi" = "DeLonghi" = "De Longhi" = "De’Longhi S.p.A." → "delonghi". */
export function brandKey(brand: string | null | undefined): string {
  if (!brand) return "";
  const words = baseNorm(brand)
    .replace(/&/g, " and ")
    .replace(/\./g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) words.pop();
  while (words.length > 1 && words[0] === "the") words.shift();
  return words.join("");
}

const UNIT_ALIASES: Record<string, string> = {
  gb: "gb",
  tb: "tb",
  mb: "mb",
  l: "l",
  liter: "l",
  liters: "l",
  litre: "l",
  litres: "l",
  ml: "ml",
  oz: "oz",
  ounce: "oz",
  ounces: "oz",
  cup: "cup",
  cups: "cup",
  in: "in",
  inch: "in",
  inches: "in",
  mm: "mm",
  cm: "cm",
  w: "w",
  watt: "w",
  watts: "w",
  mah: "mah",
  qt: "qt",
  quart: "qt",
  quarts: "qt",
  hz: "hz",
  lb: "lb",
  lbs: "lb",
  kg: "kg",
  pack: "pack",
  pc: "pc",
  pcs: "pc",
  piece: "pc",
  pieces: "pc",
  ft: "ft",
  v: "v",
};

const STOPWORDS = new Set(["the", "a", "an", "and", "with", "for", "by", "of", "in", "on", "to", "from", "new"]);

/** Name tokens with ordinals, generations, versions and number+unit pairs canonicalised. */
function nameTokens(s: string): string[] {
  const raw =
    baseNorm(s)
      .replace(/\+/g, " plus ")
      .replace(/&/g, " and ")
      .replace(/(\d)\s*"/g, "$1in")
      .match(/[a-z0-9]+(?:\.[0-9]+[a-z]*)?/g) ?? [];
  const out: string[] = [];
  for (let t of raw) {
    const ord = /^(\d+)(st|nd|rd|th)$/.exec(t);
    if (ord) t = ord[1];
    if (t === "generation") t = "gen";
    if (t === "version" || t === "ver") t = "v";
    const glued = /^(\d+(?:\.\d+)?)([a-z]+)$/.exec(t);
    if (glued && UNIT_ALIASES[glued[2]]) t = glued[1] + UNIT_ALIASES[glued[2]];
    const prev = out[out.length - 1];
    if (prev && /^\d+(\.\d+)?$/.test(prev) && UNIT_ALIASES[t] && t !== "v") {
      out[out.length - 1] = prev + UNIT_ALIASES[t];
      continue;
    }
    if (prev && (prev === "gen" || prev === "v") && /^\d+$/.test(t)) {
      out[out.length - 1] = prev + t;
      continue;
    }
    if (t === "gen" && prev && /^\d+$/.test(prev)) {
      out[out.length - 1] = `gen${prev}`;
      continue;
    }
    out.push(t);
  }
  return out.filter((t) => !STOPWORDS.has(t));
}

const VARIANT_WORDS = new Set([
  "pro",
  "plus",
  "max",
  "mini",
  "ultra",
  "lite",
  "se",
  "xl",
  "xxl",
  "xs",
  "s",
  "fe",
  "air",
  "neo",
  "nano",
  "micro",
  "go",
  "slim",
  "compact",
  "deluxe",
  "premium",
  "elite",
  "edge",
  "note",
  "flip",
  "fold",
  "duo",
  "dual",
  "twin",
  "touch",
  "impress",
  "express",
  "oracle",
  "sport",
  "studio",
  "kids",
  "junior",
  "jr",
  "gen",
  "generation",
  "v",
  "mk",
  "mark",
  "refurbished",
  "renewed",
  "used",
  "bundle",
  "combo",
  "kit",
  "pack",
  "set",
]);

/** Words that describe a product without making it a different product. */
const DESCRIPTOR_WORDS = new Set([
  // kitchen / home
  "espresso", "coffee", "machine", "maker", "grinder", "burr", "kettle", "toaster", "blender", "mixer", "stand",
  "oven", "fryer", "cooker", "pressure", "slow", "rice", "microwave", "dishwasher", "refrigerator", "fridge",
  "freezer", "washer", "dryer", "vacuum", "cleaner", "robot", "cordless", "stick", "upright", "purifier",
  "humidifier", "dehumidifier", "fan", "heater", "frother", "milk", "steam", "wand", "drip", "pod", "capsule",
  "single", "serve", "programmable", "countertop", "kitchen", "home", "appliance", "electric", "automatic",
  "manual", "semi", "portable", "cookware", "pan", "skillet", "pot", "knife", "mattress", "pillow", "chair",
  "desk", "sofa", "bed", "frame", "lamp", "light",
  // electronics
  "headphones", "headphone", "earbuds", "earphones", "headset", "speaker", "speakers", "soundbar", "wireless",
  "wired", "wi", "fi", "usb", "bluetooth", "noise", "cancelling", "canceling", "over", "ear", "smartphone", "phone", "unlocked",
  "laptop", "notebook", "tablet", "monitor", "tv", "television", "smart", "camera", "mirrorless", "dslr",
  "digital", "lens", "watch", "smartwatch", "tracker", "fitness", "router", "mesh", "wifi", "keyboard", "mouse",
  "gaming", "controller", "console", "printer", "drive", "ssd", "hdd", "external", "charger", "cable", "case",
  "4k", "8k", "hd", "uhd", "oled", "qled", "led", "lcd", "hdr",
  // outdoors / apparel / tools
  "shoe", "shoes", "running", "jacket", "backpack", "bag", "tent", "sleeping", "stroller", "mower", "lawn",
  "drill", "saw", "tool", "driver", "impact", "brushless",
  // materials / finishes / colours
  "stainless", "steel", "brushed", "aluminum", "aluminium", "plastic", "glass", "ceramic", "cast", "iron",
  "nonstick", "non", "black", "white", "silver", "gray", "grey", "red", "blue", "green", "gold", "rose", "pink",
  "purple", "yellow", "orange", "brown", "beige", "navy", "graphite", "midnight", "starlight", "space",
  "titanium", "sage", "cream", "truffle", "oyster", "charcoal", "slate", "matte", "gloss", "glossy", "satin",
  "color", "colour", "finish", "chrome", "copper", "bronze", "sea", "salt", "damson", "almond", "nut",
  // filler
  "model", "series", "official", "genuine", "original", "edition", "brand",
]);

function isVariantToken(t: string): boolean {
  if (VARIANT_WORDS.has(t)) return true;
  if (t.length === 1) return true; // "S", "X", "E" suffixes
  if (/^\d+(\.\d+)?$/.test(t)) return true; // generation / version / year / size numbers
  if (/^\d+(\.\d+)?[a-z]+$/.test(t)) return true; // capacities & sizes: 128gb, 1.5l, 12cup, 65in
  if (/^(gen|v|mk)\d+$/.test(t)) return true;
  return false;
}

function isCodeToken(t: string): boolean {
  return t.length >= 4 && /[a-z]/.test(t) && /\d/.test(t);
}

function nameCheck(identity: ProductIdentity, candidate: ExtractedProduct): { ok: boolean; reason: string } {
  const brandTokens = new Set<string>();
  const brandKeys: string[] = [];
  for (const b of [identity.brand, candidate.brand]) {
    if (!b) continue;
    for (const t of nameTokens(b)) brandTokens.add(t);
    const k = brandKey(b);
    if (k) brandKeys.push(k);
  }
  const strip = (ts: string[]) => {
    // Brand written as split words inside the name, e.g. "de longhi" for "DeLonghi".
    const drop = new Set<number>();
    for (const k of brandKeys) {
      for (let i = 0; i < ts.length; i++) {
        let joined = "";
        for (let j = i; j < ts.length && joined.length < k.length; j++) {
          joined += ts[j];
          if (joined === k) for (let x = i; x <= j; x++) drop.add(x);
        }
      }
    }
    return ts.filter((t, i) => !drop.has(i) && !brandTokens.has(t));
  };
  const idAll = nameTokens(identity.name);
  const id = strip(idAll);
  const cand = strip(nameTokens(candidate.name ?? ""));
  if (!id.length) return { ok: false, reason: `identity name "${identity.name}" has no product words beyond the brand` };
  const candSet = new Set(cand);
  const missing = id.filter((t) => !candSet.has(t));
  if (missing.length) {
    return { ok: false, reason: `candidate "${candidate.name}" lacks "${missing.join(" ")}" from "${identity.name}"` };
  }
  const idSet = new Set(id);
  const codes = [identity.model, identity.mpn, identity.sku].filter((c): c is string => !!c).map(codeKey);
  for (const t of cand) {
    if (idSet.has(t)) continue;
    if (!VARIANT_WORDS.has(t) && DESCRIPTOR_WORDS.has(t)) continue;
    if (isVariantToken(t)) {
      return { ok: false, reason: `candidate "${candidate.name}" has variant token "${t}" that "${identity.name}" lacks` };
    }
    if (isCodeToken(t)) {
      if (!codes.length || codes.some((c) => c === t || c.startsWith(t) || t.startsWith(c))) continue;
      return { ok: false, reason: `candidate "${candidate.name}" names model code "${t}", not ${codes.join("/")}` };
    }
    return { ok: false, reason: `candidate "${candidate.name}" has unexplained extra word "${t}" not in "${identity.name}"` };
  }
  return { ok: true, reason: `all of "${identity.name}" appears in "${candidate.name}" with no variant differences` };
}

/** Identity brand appears in the candidate's name (used when the candidate has no brand field). */
function brandInName(brand: string, name: string): boolean {
  const k = brandKey(brand);
  if (!k) return false;
  const toks = nameTokens(name);
  if (toks.includes(k)) return true;
  // split spellings: "de longhi" → "delonghi"
  for (let i = 0; i < toks.length; i++) {
    let joined = "";
    for (let j = i; j < toks.length && joined.length < k.length; j++) {
      joined += toks[j];
      if (joined === k) return true;
    }
  }
  return false;
}

type BrandState = "equal" | "conflict" | "unknown";

function brandState(identity: ProductIdentity, candidate: ExtractedProduct): BrandState {
  const a = brandKey(identity.brand);
  const b = brandKey(candidate.brand);
  if (a && b) return a === b ? "equal" : "conflict";
  return "unknown";
}

/**
 * Strict "is this exactly our product" check. Order: GTIN → MPN → model → brand + name.
 * A conflicting identifier is always a non-match; nothing similar-but-different ever matches.
 */
export function sameProduct(identity: ProductIdentity, candidate: ExtractedProduct): MatchResult {
  const brands = brandState(identity, candidate);
  const brandConflict = `brands differ ("${identity.brand}" vs "${candidate.brand}")`;

  // 1. GTIN
  const ga = normalizeGtin(identity.gtin);
  const gb = normalizeGtin(candidate.gtin);
  if (ga && gb) {
    if (ga !== gb) return { match: false, basis: "gtin", reason: `GTIN ${ga} ≠ ${gb}` };
    if (brands === "conflict") return { match: false, basis: "gtin", reason: `GTIN matches but ${brandConflict}` };
    return { match: true, basis: "gtin", reason: `GTIN ${ga} matches` };
  }

  // 2. MPN, then model number
  for (const field of ["mpn", "model"] as const) {
    const a = identity[field] ? codeKey(identity[field]!) : "";
    const b = candidate[field] ? codeKey(candidate[field]!) : "";
    if (!a || !b) continue;
    if (a !== b) return { match: false, basis: field, reason: `${field.toUpperCase()} "${identity[field]}" ≠ "${candidate[field]}"` };
    if (brands === "conflict") return { match: false, basis: field, reason: `${field.toUpperCase()} matches but ${brandConflict}` };
    // The other code, when both sides state it, must agree too.
    const other = field === "mpn" ? "model" : "mpn";
    if (identity[other] && candidate[other] && codeKey(identity[other]!) !== codeKey(candidate[other]!)) {
      return { match: false, basis: field, reason: `${field.toUpperCase()} matches but ${other} "${identity[other]}" ≠ "${candidate[other]}"` };
    }
    if (brands === "equal") return { match: true, basis: field, reason: `brand and ${field.toUpperCase()} "${identity[field]}" match` };
    // Brand unverifiable: only a distinctive code (letters + digits, ≥ 5 chars) is trusted on its own.
    if (a.length >= 5 && /\d/.test(a) && /[a-z]/.test(a)) {
      const idBrand = identity.brand;
      if (idBrand && !candidate.brand && candidate.name && !brandInName(idBrand, candidate.name)) {
        return { match: false, basis: field, reason: `${field.toUpperCase()} matches but brand "${idBrand}" is not stated on the candidate` };
      }
      return { match: true, basis: field, reason: `distinctive ${field.toUpperCase()} "${identity[field]}" matches` };
    }
    return { match: false, basis: field, reason: `${field.toUpperCase()} "${identity[field]}" is too generic to match without a confirmed brand` };
  }

  // 3. Brand + name
  if (!candidate.name) return { match: false, basis: "brand+name", reason: "candidate has no name" };
  if (brands === "conflict") return { match: false, basis: "brand+name", reason: brandConflict };
  if (identity.brand && brands === "unknown" && !candidate.brand) {
    if (!brandInName(identity.brand, candidate.name)) {
      return { match: false, basis: "brand+name", reason: `candidate has no brand and its name does not include "${identity.brand}"` };
    }
    const idTokens = nameTokens(identity.name);
    const candTokens = new Set(nameTokens(candidate.name));
    const missing = idTokens.filter((t) => !candTokens.has(t) && !brandInName(t, candidate.name!));
    if (missing.length) {
      return { match: false, basis: "brand+name", reason: `candidate has no brand and lacks "${missing.join(" ")}" from "${identity.name}"` };
    }
  }
  const nc = nameCheck(identity, candidate);
  return { match: nc.ok, basis: "brand+name", reason: nc.reason };
}

// ---------------------------------------------------------------------------------------------
// Source classification
// ---------------------------------------------------------------------------------------------

const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "com.au", "net.au", "co.nz", "co.jp", "co.in", "com.br", "com.mx", "com.sg",
  "co.za", "com.tr", "com.ar", "co.kr", "com.cn", "com.hk", "com.tw", "co.il",
]);

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/** "shop.breville.com.au" → "breville.com.au". */
export function registrableDomain(host: string): string {
  const labels = host.replace(/^www\./, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const last2 = labels.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(last2) ? labels.slice(-3).join(".") : last2;
}

const BUILTIN_RETAILERS = [
  "amazon.*",
  "bestbuy.com",
  "walmart.com",
  "target.com",
  "newegg.com",
  "bhphotovideo.com",
  "adorama.com",
  "costco.com",
  "homedepot.com",
  "lowes.com",
  "wayfair.com",
  "currys.co.uk",
  "argos.co.uk",
  "johnlewis.com",
  "crutchfield.com",
  "rei.com",
  "williams-sonoma.com",
  "crateandbarrel.com",
  "kohls.com",
  "macys.com",
  "ebay.com",
];

function hostMatches(host: string, entry: string): boolean {
  const e = entry.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  if (!e) return false;
  const reg = registrableDomain(host);
  if (e.endsWith(".*")) return reg.split(".")[0] === e.slice(0, -2);
  return host === e || host.endsWith(`.${e}`) || reg === e;
}

/**
 * MANUFACTURER only when the registrable domain's leading label is the brand itself
 * (breville.com for "Breville", delonghi.com for "De'Longhi"); otherwise RETAILER / REVIEW_SOURCE
 * for known hosts, else SECONDARY.
 */
export function classifySource(
  url: string,
  brand: string | null | undefined,
  opts?: { retailers?: string[]; reviewHosts?: string[] },
): FactSource {
  const host = hostOf(url);
  if (!host) return "SECONDARY";
  const reg = registrableDomain(host);
  const label = reg.split(".")[0];
  const slug = brandKey(brand);
  if (slug.length >= 2 && (label === slug || label.replace(/-/g, "") === slug)) return "MANUFACTURER";
  if ([...BUILTIN_RETAILERS, ...(opts?.retailers ?? [])].some((e) => hostMatches(host, e))) return "RETAILER";
  if ((opts?.reviewHosts ?? []).some((e) => hostMatches(host, e))) return "REVIEW_SOURCE";
  return "SECONDARY";
}
