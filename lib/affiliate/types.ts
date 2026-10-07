export type AffiliateWrapResult = { status: "AFFILIATED"; affiliateUrl: string; provider?: string } | { status: "NOT_AFFILIATABLE" | "UNAVAILABLE"; reason: string };

export interface AffiliateProvider {
  /** Stable identifier stored with each offer (CommerceOffer.affiliateProvider). */
  readonly name: string;
  /** Env var NAMES this provider needs (never values). */
  readonly requiredEnv: readonly string[];
  /** True only when every required env var is set and valid (false for "none"). */
  readonly active: boolean;
  /** Required env vars that are missing or malformed (names only). */
  missingEnv(): string[];
  /** Cheap, offline check: could this provider possibly wrap the URL (host / shape)? */
  supports(destinationUrl: string): boolean;
  wrap(destinationUrl: string): Promise<AffiliateWrapResult>;
}

/** Env var value, trimmed; undefined when empty. */
export function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

export function parseHttpUrl(raw: string): URL | undefined {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u : undefined;
  } catch {
    return undefined;
  }
}

/** Host without "www." and trailing dot, lower case. */
export function bareHost(u: URL): string {
  return u.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

/** host is `domain` or a subdomain of it. */
export function onDomain(host: string, domain: string): boolean {
  const d = domain.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return host === d || host.endsWith(`.${d}`);
}

/** Basic shape every generated affiliate URL must have: absolute https, bounded, no credentials or fragment. */
export function wellFormedAffiliateUrl(raw: unknown): URL | undefined {
  if (typeof raw !== "string" || raw.length > 2048) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || u.hash || !u.hostname.includes(".")) return undefined;
    return u;
  } catch {
    return undefined;
  }
}
