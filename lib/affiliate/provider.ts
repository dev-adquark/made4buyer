import { config } from "@/lib/config";
import { amazonProvider } from "./amazon";
import { impactProvider } from "./impact";
import { skimlinksProvider } from "./skimlinks";
import type { AffiliateProvider, AffiliateWrapResult } from "./types";

/**
 * Provider-independent affiliate interface.
 *
 * Retailer links are plain links to the retailer's own page unless a real affiliate provider
 * is configured. The commerce engine only ever calls `getAffiliateProvider().wrap(url)` (via
 * lib/affiliate/apply.ts) and stores what comes back on CommerceOffer:
 *  - `{ status: "AFFILIATED", affiliateUrl, provider }` → affiliateUrl / affiliateProvider /
 *    affiliateStatus="AFFILIATED" (a link the provider's rules or API produced, verified for format);
 *  - anything else → affiliateUrl stays null, affiliateStatus records why, and every page and
 *    /go/<id> keep using the plain destinationUrl.
 *
 * Providers (select with AFFILIATE_PROVIDER; a comma list tries each in order):
 *  - none       (default) nothing is ever wrapped
 *  - amazon     Amazon Associates tag links, ONLY for amazon.com product URLs that already contain
 *               an ASIN (lib/affiliate/amazon.ts)
 *  - skimlinks  Skimlinks redirect links, ONLY for merchants the Skimlinks Merchant API says the
 *               publisher can monetize (lib/affiliate/skimlinks.ts)
 *  - impact     impact.com Tracking Link API, ONLY for merchant domains mapped to an approved
 *               program in IMPACT_PROGRAMS (lib/affiliate/impact.ts)
 *
 * Rules every provider follows: never fabricate tracking parameters or identifiers, never guess
 * that a merchant is affiliatable, verify the generated URL, and return UNAVAILABLE (not a plain
 * URL dressed as affiliated) when the provider cannot answer. A provider whose env vars are
 * missing is inactive, so links stay plain and the disclosure page says so.
 */

export type { AffiliateProvider, AffiliateWrapResult } from "./types";

/** The default: no affiliate provider. Every URL stays exactly as the retailer published it. */
export const noneProvider: AffiliateProvider = {
  name: "none",
  requiredEnv: [],
  get active() {
    return false;
  },
  missingEnv: () => [],
  supports: () => false,
  async wrap() {
    return { status: "UNAVAILABLE", reason: "no affiliate provider is configured (AFFILIATE_PROVIDER=none)" };
  },
};

export const PROVIDERS: Record<string, AffiliateProvider> = { none: noneProvider, amazon: amazonProvider, skimlinks: skimlinksProvider, impact: impactProvider };

/** Names in AFFILIATE_PROVIDER, in order (known and unknown). */
export function selectedProviderNames(): string[] {
  const names = config.affiliate
    .provider()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length ? names : ["none"];
}

/** Configuration problems (unknown names, missing env vars): names only, never values. */
export function affiliateConfigIssues(): { unknown: string[]; missingEnv: string[] } {
  const names = selectedProviderNames().filter((n) => n !== "none");
  return { unknown: names.filter((n) => !PROVIDERS[n]), missingEnv: [...new Set(names.flatMap((n) => PROVIDERS[n]?.missingEnv() ?? []))] };
}

/** Any exception from a provider becomes UNAVAILABLE: the offer keeps its plain link. */
export async function safeWrap(p: AffiliateProvider, url: string): Promise<AffiliateWrapResult> {
  try {
    const r = await p.wrap(url);
    return r.status === "AFFILIATED" ? { ...r, provider: r.provider ?? p.name } : r;
  } catch (error) {
    return { status: "UNAVAILABLE", reason: `${p.name} error: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}` };
  }
}

/** Tries each active provider that supports the URL, in order; the first AFFILIATED result wins. */
function chain(providers: AffiliateProvider[]): AffiliateProvider {
  return {
    name: providers.map((p) => p.name).join("+"),
    requiredEnv: providers.flatMap((p) => p.requiredEnv),
    get active() {
      return providers.some((p) => p.active);
    },
    missingEnv: () => providers.flatMap((p) => p.missingEnv()),
    supports: (url) => providers.some((p) => p.active && p.supports(url)),
    async wrap(url): Promise<AffiliateWrapResult> {
      const reasons: string[] = [];
      let unavailable = false;
      for (const p of providers) {
        if (!p.active || !p.supports(url)) continue;
        const r = await safeWrap(p, url);
        if (r.status === "AFFILIATED") return r;
        unavailable ||= r.status === "UNAVAILABLE";
        reasons.push(`${p.name}: ${r.reason}`);
      }
      return { status: unavailable ? "UNAVAILABLE" : "NOT_AFFILIATABLE", reason: reasons.join("; ") || "no configured provider supports this destination" };
    },
  };
}

/** The configured provider (a chain when several are listed). Unknown names are ignored; nothing known → "none". */
export function getAffiliateProvider(): AffiliateProvider {
  const known = selectedProviderNames()
    .map((n) => PROVIDERS[n])
    .filter((p): p is AffiliateProvider => Boolean(p) && p.name !== "none");
  if (!known.length) return noneProvider;
  return known.length === 1 ? known[0] : chain(known);
}

/** Names of the individual providers behind the configured one (for re-checking offers after a provider change). */
export function activeProviderNames(): string[] {
  return selectedProviderNames().filter((n) => n !== "none" && PROVIDERS[n]?.active);
}

/** True only when a real provider is configured with every env var it needs; the disclosure page says so honestly. */
export function affiliateProviderActive(): boolean {
  return getAffiliateProvider().active;
}
