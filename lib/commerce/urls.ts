import { normalizeUrl } from "@/lib/pipeline/apify";
import { registrableDomain } from "@/lib/products/page-extract";

/** Click/session identifiers that never change which page a URL shows (beyond normalizeUrl's utm_*, gclid, fbclid …). */
const EXTRA_TRACKING = /^(msclkid|yclid|dclid|gbraid|wbraid|srsltid|igshid|mkt_tok|_ga|_gl|_hsenc|_hsmi|mc_cid|mc_eid)$/i;

/**
 * Canonical form of an offer destination, used before every write so tracking variants of one page
 * can never create a second offer row (unique productId+destinationUrl): lower-case host, no
 * fragment, no utm_* / gclid / fbclid / other click identifiers, sorted query, no trailing slash.
 */
export function normalizeDestinationUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const base = normalizeUrl(raw);
  if (!base) return null;
  const u = new URL(base);
  for (const k of [...u.searchParams.keys()]) if (EXTRA_TRACKING.test(k)) u.searchParams.delete(k);
  return u.toString();
}

/** True when `url` is on `domain` (the brand's official domain): same host, a subdomain, or the same registrable domain. */
export function onDomain(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const d = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    return !!d && (host === d || host.endsWith(`.${d}`) || registrableDomain(host) === registrableDomain(d));
  } catch {
    return false;
  }
}
