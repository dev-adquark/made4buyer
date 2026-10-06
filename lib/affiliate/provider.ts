import { config } from "@/lib/config";

/**
 * Provider-independent affiliate interface.
 *
 * Retailer links are plain links to the retailer's own page unless a real affiliate provider
 * is configured. The commerce engine only ever calls `getAffiliateProvider().wrap(url)` and
 * stores what comes back:
 *  - `{ status: "AFFILIATED", affiliateUrl }` → stored as CommerceOffer.affiliateUrl (the link
 *    the provider generated, never one we build ourselves);
 *  - anything else → the offer keeps its plain destinationUrl and affiliateUrl stays null.
 *
 * Adding a provider: implement `AffiliateProvider` in its own file (e.g. lib/affiliate/<name>.ts),
 * call the provider's real API inside `wrap`, and register it in PROVIDERS below. Select it with
 * AFFILIATE_PROVIDER=<name>. Nothing in the engine, the pages or the /go redirect changes.
 *
 * Rules every provider must follow: never fabricate tracking parameters, never guess that a
 * merchant is affiliatable, and return UNAVAILABLE (not a plain URL dressed as affiliated) when
 * the provider cannot answer.
 */

export type AffiliateWrapResult = { affiliateUrl: string; status: "AFFILIATED" } | { status: "NOT_AFFILIATABLE" | "UNAVAILABLE"; reason: string };

export interface AffiliateProvider {
  /** Stable identifier stored with each offer (CommerceOffer.affiliateProvider). */
  readonly name: string;
  /** Whether this provider can generate affiliate links at all (false for "none"). */
  readonly active: boolean;
  wrap(destinationUrl: string): Promise<AffiliateWrapResult>;
}

/** The default: no affiliate provider. Every URL stays exactly as the retailer published it. */
export const noneProvider: AffiliateProvider = {
  name: "none",
  active: false,
  async wrap() {
    return { status: "UNAVAILABLE", reason: "no affiliate provider is configured (AFFILIATE_PROVIDER=none)" };
  },
};

const PROVIDERS: Record<string, AffiliateProvider> = { none: noneProvider };

/** The configured provider. An unknown name falls back to "none" (links stay plain). */
export function getAffiliateProvider(): AffiliateProvider {
  return PROVIDERS[config.affiliate.provider()] ?? noneProvider;
}

/** True only when a real provider is configured; the disclosure page says so honestly. */
export function affiliateProviderActive(): boolean {
  return getAffiliateProvider().active;
}
