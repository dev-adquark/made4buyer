import { validateOutboundUrl } from "@/lib/net/safe-fetch";

/**
 * Product-page URL hygiene shared by product enrichment, "where to buy" links and the commerce
 * display. Provider-independent: nothing here generates or keeps affiliate tracking.
 */

/** Tracking / affiliate query parameters stripped from a product page URL. */
const TRACKING = /^(utm_[a-z]+|gclid|fbclid|msclkid|dclid|yclid|mc_[a-z]+|ref|ref_|tag|ascsubtag|linkcode|linkid|camp|creative|irclickid|irgwc|clickid|cjevent|aff(_?id)?|affiliate(_?id)?|subid|sid|cuid|_ga|_gl|spm|psc)$/i;

/**
 * Hosts of affiliate-network redirectors. A URL on one of them is someone else's tracking link
 * (e.g. copied from a scraped page), never a store page, so it is never linked or stored as one.
 */
const AFFILIATE_REDIRECT_HOSTS = [
  /(^|\.)viglink\.com$/i,
  /(^|\.)sovrn\.co$/i,
  /(^|\.)sovrn\.com$/i,
  /(^|\.)skimresources\.com$/i,
  /(^|\.)skimlinks\.com$/i,
  /(^|\.)linksynergy\.com$/i,
  /(^|\.)awin1\.com$/i,
  /(^|\.)shareasale\.com$/i,
  /(^|\.)anrdoezrs\.net$/i,
  /(^|\.)dpbolvw\.net$/i,
  /(^|\.)jdoqocy\.com$/i,
  /(^|\.)kqzyfj\.com$/i,
  /(^|\.)tkqlhce\.com$/i,
  /(^|\.)prf\.hn$/i,
  /(^|\.)pntra\.com$/i,
  /(^|\.)go2cloud\.org$/i,
  /(^|\.)impact\.com$/i,
];

export function isAffiliateRedirectUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return AFFILIATE_REDIRECT_HOSTS.some((re) => re.test(host));
  } catch {
    return false;
  }
}

/** The canonical product page: http(s), no fragment, no tracking/affiliate parameters, never an affiliate redirector. */
export function canonicalProductUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const v = validateOutboundUrl(url, { standardPortsOnly: true });
  if (!v.url || isAffiliateRedirectUrl(v.url.toString())) return undefined;
  const u = new URL(v.url.toString());
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  return u.toString();
}
