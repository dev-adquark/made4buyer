import { validateOutboundUrl } from "@/lib/net/safe-fetch";
import { isProviderAffiliateUrl, type NormalizedOffer } from "./offers";

/**
 * Stage AFFILIATE_LINK. Affiliate URLs come only from the provider:
 *  1. the offer's own Sovrn deeplink (PROVIDER_DEEPLINK), or
 *  2. the merchant URL wrapped with the configured Sovrn link wrapper + site key (LINK_WRAPPER).
 * Without either, generation fails with AFFILIATE_URL_INVALID — no link is invented.
 */

export type GeneratedLink =
  | { ok: true; affiliateUrl: string; destinationUrl: string; method: "PROVIDER_DEEPLINK" | "LINK_WRAPPER" }
  | { ok: false; reason: string };

export function generateAffiliateUrl(offer: Pick<NormalizedOffer, "offerUrl" | "providerAffiliateUrl">, opts: { wrapperUrl?: string; siteKey?: string }): GeneratedLink {
  const destination = validateOutboundUrl(offer.offerUrl, { standardPortsOnly: true });
  if (!destination.url) return { ok: false, reason: `offer URL rejected: ${destination.error?.message}` };

  if (offer.providerAffiliateUrl) {
    const deeplink = validateOutboundUrl(offer.providerAffiliateUrl, { standardPortsOnly: true });
    if (!deeplink.url) return { ok: false, reason: `provider deeplink rejected: ${deeplink.error?.message}` };
    return { ok: true, affiliateUrl: deeplink.url.toString(), destinationUrl: destination.url.toString(), method: "PROVIDER_DEEPLINK" };
  }

  if (isProviderAffiliateUrl(offer.offerUrl)) {
    return { ok: true, affiliateUrl: destination.url.toString(), destinationUrl: destination.url.toString(), method: "PROVIDER_DEEPLINK" };
  }

  if (!opts.siteKey || !opts.wrapperUrl) {
    return { ok: false, reason: "offer has no provider deeplink and SOVRN_SITE_KEY is not configured for link wrapping" };
  }
  let wrapper: URL;
  try {
    wrapper = new URL(opts.wrapperUrl);
  } catch {
    return { ok: false, reason: "SOVRN_LINK_WRAPPER_URL is invalid" };
  }
  if (wrapper.protocol !== "https:") return { ok: false, reason: "SOVRN_LINK_WRAPPER_URL must use https" };
  wrapper.searchParams.set("key", opts.siteKey);
  wrapper.searchParams.set("u", destination.url.toString());
  return { ok: true, affiliateUrl: wrapper.toString(), destinationUrl: destination.url.toString(), method: "LINK_WRAPPER" };
}
