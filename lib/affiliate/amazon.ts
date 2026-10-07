import { bareHost, env, parseHttpUrl, wellFormedAffiliateUrl, type AffiliateProvider } from "./types";

/**
 * Amazon Associates (US store, amazon.com) — tag-based links. No Product Advertising API is
 * needed to build a link: Amazon's documented link format is the product page with the
 * Associates tracking ID as `tag`. This provider:
 *  - wraps ONLY amazon.com / www.amazon.com product URLs that already contain an ASIN in a known
 *    product path (/dp/, /gp/product/, /gp/aw/d/, /exec/obidos/ASIN/, /o/ASIN/). It never looks
 *    an ASIN up, never invents one, and never wraps short links (a.co, amzn.to) or other stores;
 *  - builds https://www.amazon.com/dp/<ASIN>?tag=<AMAZON_ASSOCIATES_TAG> and verifies it;
 *  - requires AMAZON_ASSOCIATES_TAG in the US store format (`<id>-20`).
 */

const TAG = /^[a-z0-9][a-z0-9-]{0,62}-20$/i;
const ASIN = /^[A-Z0-9]{10}$/;
const PATHS = [/^\/(?:[^/]+\/)?dp\/([A-Za-z0-9]{10})(?:[/?]|$)/, /^\/gp\/product\/([A-Za-z0-9]{10})(?:[/?]|$)/, /^\/gp\/aw\/d\/([A-Za-z0-9]{10})(?:[/?]|$)/, /^\/exec\/obidos\/(?:ASIN|asin)\/([A-Za-z0-9]{10})(?:[/?]|$)/, /^\/o\/ASIN\/([A-Za-z0-9]{10})(?:[/?]|$)/];

export function amazonTag(): string | undefined {
  const t = env("AMAZON_ASSOCIATES_TAG");
  return t && TAG.test(t) ? t : undefined;
}

/** The ASIN already present in an amazon.com product URL, else undefined. */
export function asinFromAmazonUrl(raw: string): string | undefined {
  const u = parseHttpUrl(raw);
  if (!u || bareHost(u) !== "amazon.com") return undefined;
  for (const re of PATHS) {
    const m = re.exec(u.pathname);
    if (m) {
      const asin = m[1].toUpperCase();
      return ASIN.test(asin) ? asin : undefined;
    }
  }
  return undefined;
}

export const amazonProvider: AffiliateProvider = {
  name: "amazon",
  requiredEnv: ["AMAZON_ASSOCIATES_TAG"],
  get active() {
    return Boolean(amazonTag());
  },
  missingEnv: () => (amazonTag() ? [] : ["AMAZON_ASSOCIATES_TAG"]),
  supports: (url) => Boolean(asinFromAmazonUrl(url)),
  async wrap(destinationUrl) {
    const tag = amazonTag();
    if (!tag) return { status: "UNAVAILABLE", reason: "AMAZON_ASSOCIATES_TAG is not set or not a US (-20) tracking ID" };
    const asin = asinFromAmazonUrl(destinationUrl);
    if (!asin) return { status: "NOT_AFFILIATABLE", reason: "not an amazon.com product URL with an ASIN" };
    const built = `https://www.amazon.com/dp/${asin}?tag=${encodeURIComponent(tag)}`;
    const u = wellFormedAffiliateUrl(built);
    if (!u || u.hostname !== "www.amazon.com" || u.pathname !== `/dp/${asin}` || u.searchParams.get("tag") !== tag) return { status: "UNAVAILABLE", reason: "generated Amazon link failed verification" };
    return { status: "AFFILIATED", affiliateUrl: u.toString(), provider: "amazon" };
  },
};
