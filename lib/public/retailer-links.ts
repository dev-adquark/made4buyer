import net from "node:net";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { registrableDomain } from "@/lib/net/ip";
import { validateOutboundUrl } from "@/lib/net/safe-fetch";
import { canonicalProductUrl, isAffiliateRedirectUrl } from "@/lib/net/product-url";
import { canonicalDestination } from "./display";

/**
 * "Where to buy": plain, direct links to the maker's site or a retailer, built ONLY from URLs
 * already stored for the review (the source's own product link and product facts from the
 * maker's or a retailer's page). Never a price, never a "deal", never an invented merchant.
 * They are plain direct links (no affiliate tracking). Priced offers come from the commerce
 * engine (lib/public/offers.ts) and are shown separately; the page de-duplicates by domain.
 */

export type RetailerLink = {
  url: string;
  label: string;
  /** Registrable domain, e.g. "nordvpn.com". */
  merchant: string;
  kind: "official" | "retailer";
  /** Provenance, e.g. "linked by Cloudwards". Internal/admin use; not stored in the page model. */
  source: string;
};

export type RetailerLinkFact = { field: string; value: unknown; source: string; sourceName: string; observedAt: Date | string | null };

export type RetailerLinkInput = {
  status: string;
  kind?: string;
  brand: string | null;
  sourceUrl: string | null;
  canonicalUrl: string | null;
  /** Display name of the review's source publication. */
  sourceName: string | null;
  sourceProductUrl: string | null;
  /** Facts of the review's PRIMARY product. */
  facts: RetailerLinkFact[];
};

export const MAX_RETAILER_LINKS = 2;

/** Image and asset CDNs: a link there is never a store page. */
const ASSET_HOSTS = [
  /(^|\.)cloudfront\.net$/i,
  /(^|\.)akamaized\.net$/i,
  /(^|\.)akamaihd\.net$/i,
  /(^|\.)cloudinary\.com$/i,
  /(^|\.)imgix\.net$/i,
  /(^|\.)fastly\.net$/i,
  /(^|\.)googleusercontent\.com$/i,
  /(^|\.)ggpht\.com$/i,
  /(^|\.)ssl-images-amazon\.com$/i,
  /(^|\.)media-amazon\.com$/i,
  /(^|\.)images-amazon\.com$/i,
  /(^|\.)pexels\.com$/i,
  /(^|\.)unsplash\.com$/i,
  /(^|\.)wikimedia\.org$/i,
  /(^|\.)staticflickr\.com$/i,
  /(^|\.)shopify\.com$/i, // cdn.shopify.com assets; storefronts use their own domains
  /(^|\.)wp\.com$/i,
  /(^|\.)jsdelivr\.net$/i,
  /(^|\.)cloudflare\.com$/i,
];
const ASSET_SUBDOMAIN = /^(img|image|images|cdn|static|media|assets?|i\d?|s\d?|pics?|photos?)[0-9-]*\./i;
const ASSET_PATH = /\.(jpe?g|png|gif|webp|avif|svg|bmp|ico|tiff?|heic|mp4|webm|pdf|css|js)$/i;

const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** A canonical, public, direct store URL, or undefined when it must not be linked. */
export function linkableUrl(raw: unknown, excludedDomains: Set<string>): { url: string; merchant: string } | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const v = validateOutboundUrl(raw.trim(), { standardPortsOnly: true });
  if (!v.url) return undefined;
  const host = v.url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // A store is never an IP literal or a loopback name (even when tests allow loopback fetches).
  if (net.isIP(host) || host === "localhost" || host.endsWith(".localhost")) return undefined;
  if (isAffiliateRedirectUrl(v.url.toString())) return undefined;
  if (ASSET_HOSTS.some((re) => re.test(host)) || ASSET_SUBDOMAIN.test(host) || ASSET_PATH.test(v.url.pathname)) return undefined;
  const merchant = registrableDomain(host);
  if (merchant.includes("made4buyers") || excludedDomains.has(merchant)) return undefined;
  const url = canonicalProductUrl(v.url.toString());
  return url ? { url, merchant } : undefined;
}

function ts(d: Date | string | null): number {
  if (!d) return 0;
  const t = d instanceof Date ? d.getTime() : Date.parse(d);
  return Number.isFinite(t) ? t : 0;
}

/** Pure: up to two honest "where to buy" links, official site first, then retailers. */
export function retailerLinksFor(review: RetailerLinkInput, opts: { siteUrl?: string } = {}): RetailerLink[] {
  if (review.status !== "PUBLISHED") return [];
  if (review.kind && review.kind !== "REVIEW") return [];

  const excluded = new Set<string>();
  for (const u of [review.sourceUrl, review.canonicalUrl, opts.siteUrl]) {
    const h = hostOf(u);
    if (h) excluded.add(registrableDomain(h));
  }
  const publisher = review.sourceName?.trim() || (hostOf(review.sourceUrl ?? review.canonicalUrl) ? registrableDomain(hostOf(review.sourceUrl ?? review.canonicalUrl)!) : null);

  const officialFacts = review.facts.filter((f) => f.field === "officialUrl" && f.source === "MANUFACTURER").sort((a, b) => ts(b.observedAt) - ts(a.observedAt));
  const retailerFacts = review.facts.filter((f) => f.field === "retailerUrl" && f.source === "RETAILER").sort((a, b) => ts(b.observedAt) - ts(a.observedAt));
  const officialDomains = new Set(officialFacts.map((f) => linkableUrl(f.value, excluded)?.merchant).filter((m): m is string => Boolean(m)));
  const brandKey = review.brand ? alnum(review.brand) : "";

  type Cand = { raw: unknown; kind: "official" | "retailer"; source: string };
  const official: Cand[] = officialFacts.map((f) => ({ raw: f.value, kind: "official", source: `maker's product page (${f.sourceName})` }));
  const retailer: Cand[] = retailerFacts.map((f) => ({ raw: f.value, kind: "retailer", source: `retailer product page (${f.sourceName})` }));

  // The source's own product link: official when it is the maker's domain, otherwise a retailer.
  const sp = linkableUrl(review.sourceProductUrl, excluded);
  if (sp) {
    const label = alnum(sp.merchant.split(".")[0]);
    const isOfficial = officialDomains.has(sp.merchant) || (brandKey.length >= 3 && label === brandKey);
    const cand: Cand = { raw: review.sourceProductUrl, kind: isOfficial ? "official" : "retailer", source: publisher ? `linked by ${publisher}` : "linked by the review source" };
    if (isOfficial) official.push(cand);
    else retailer.unshift(cand);
  }

  const out: RetailerLink[] = [];
  const seenUrls = new Set<string>();
  const seenMerchants = new Set<string>();
  for (const c of [...official, ...retailer]) {
    if (out.length >= MAX_RETAILER_LINKS) break;
    const l = linkableUrl(c.raw, excluded);
    // One link per canonical destination (fragment, tracking and repeated parameters ignored) and per merchant.
    const key = l ? canonicalDestination(l.url) : null;
    if (!l || !key || seenUrls.has(key) || seenMerchants.has(l.merchant)) continue;
    seenUrls.add(key);
    seenMerchants.add(l.merchant);
    out.push({ url: l.url, merchant: l.merchant, kind: c.kind, label: c.kind === "official" ? "Official site" : `View at ${l.merchant}`, source: c.source });
  }
  return out;
}

/** Loads the review and its PRIMARY product's URL facts, then applies retailerLinksFor. */
export async function loadRetailerLinks(reviewId: string): Promise<RetailerLink[]> {
  const review = await db.normalizedReview.findUnique({
    where: { id: reviewId },
    select: {
      status: true,
      kind: true,
      brand: true,
      source: true,
      sourceUrl: true,
      canonicalUrl: true,
      sourceProductUrl: true,
      entities: { select: { source: true } },
      contentEntities: { where: { role: "PRIMARY" }, take: 1, select: { productEntityId: true } },
    },
  });
  if (!review || review.status !== "PUBLISHED") return [];
  const primary = review.contentEntities[0];
  const facts = primary
    ? await db.productFact.findMany({
        where: { productEntityId: primary.productEntityId, field: { in: ["officialUrl", "retailerUrl"] } },
        select: { field: true, value: true, source: true, sourceName: true, observedAt: true },
      })
    : [];
  return retailerLinksFor(
    { status: review.status, kind: review.kind, brand: review.brand, sourceUrl: review.sourceUrl, canonicalUrl: review.canonicalUrl, sourceName: review.entities?.source ?? null, sourceProductUrl: review.sourceProductUrl, facts },
    { siteUrl: config.siteUrl() },
  );
}
