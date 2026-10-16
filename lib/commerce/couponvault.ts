import { db } from "@/lib/db";
import { config } from "@/lib/config";
import { log } from "@/lib/log";
import { safeFetch } from "@/lib/net/safe-fetch";
import { sourceRunnable } from "./sources";

/**
 * CouponVault (https://couponvault.net): the owner's own coupon-listing site. Read directly, like
 * any other brand page (plain HTTP GET, robots.txt-checked, no API key, no cost) — the same
 * fetchDirectCouponPage (lib/commerce/direct-crawl.ts) and normalizeCoupons (lib/commerce/
 * coupons.ts) pipeline every other promo page uses; this file only resolves WHICH page is a given
 * registry brand's, from CouponVault's own sitemap.
 *
 * CouponVault's own URLs are `/{category}/{domain-with-dashes-for-dots}` (e.g. a store at
 * figma.com is listed at /software/figma-com) — the category is a classification, not a stable
 * identifier, so the sitemap (one file, ~13k <loc> entries, no auth) is the only reliable way to
 * resolve a domain to its page.
 *
 * Trust (owner decision, 2026-10-16): a code CouponVault lists for a registry brand is tier 5,
 * the same trust tier as the Feedico affiliate feed (lib/commerce/deal-status.ts) — public while
 * listed within COUPONVAULT_MAX_AGE_DAYS, labelled "Via CouponVault". The brand's own page still
 * outranks it.
 */

export const COUPONVAULT_SOURCE_SLUG = "couponvault";
export const COUPONVAULT_SOURCE_KIND = "COUPON_FEED";
const COUPONVAULT_SOURCE_NOTES = "The owner's own coupon-listing site (couponvault.net), read directly during the free direct-crawl. Public, labelled \"Via CouponVault\", while listed within COUPONVAULT_MAX_AGE_DAYS days; a code verified on the brand's own page is shown as the official one.";

const SITEMAP_TIMEOUT_MS = 20_000;
const SITEMAP_MAX_BYTES = 8_000_000;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type CouponVaultMap = Map<string, string>;

/** `foo.co.uk` / `WWW.Foo.com` → `foo-co-uk` / `foo-com`: CouponVault's own slugging (every dot becomes a dash). */
export function couponVaultSlug(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "")
    .replace(/\./g, "-");
}

/** Pure: every `<loc>` CouponVault's sitemap.xml lists, keyed by the domain slug in its last path segment (first occurrence kept). `baseUrl` defaults to the live config and is overridable so tests can point at a local stub. */
export function parseCouponVaultSitemap(xml: string, baseUrl = config.couponVault.baseUrl()): CouponVaultMap {
  const map: CouponVaultMap = new Map();
  const locRe = new RegExp(`<loc>(${escapeRe(baseUrl)}/[a-z0-9-]+/[a-z0-9.-]+)</loc>`, "g");
  for (const m of xml.matchAll(locRe)) {
    const url = m[1];
    const slug = url.split("/").pop();
    if (slug && !map.has(slug)) map.set(slug, url);
  }
  return map;
}

/**
 * One fetch of CouponVault's sitemap.xml (a single file listing every store page it has, no
 * pagination, no auth). A failed fetch returns an empty map (no brand is matched that run;
 * nothing else is affected).
 */
export async function fetchCouponVaultMap(): Promise<CouponVaultMap> {
  const res = await safeFetch(`${config.couponVault.baseUrl()}/sitemap.xml`, {
    headers: { Accept: "application/xml,text/xml" },
    timeoutMs: SITEMAP_TIMEOUT_MS,
    maxRedirects: 3,
    readBody: true,
    maxBytes: SITEMAP_MAX_BYTES,
  });
  if (!res.ok || !res.body) {
    log.warn("couponvault sitemap fetch failed", { stage: "COMMERCE", status: res.status, error: res.error?.message });
    return new Map();
  }
  return parseCouponVaultSitemap(res.body);
}

/** The first of `domains` that CouponVault lists a store page for, or null when none of them are listed. */
export function couponVaultUrlFor(map: CouponVaultMap, domains: Iterable<string>): string | null {
  for (const d of domains) {
    const hit = map.get(couponVaultSlug(d));
    if (hit) return hit;
  }
  return null;
}

/** The CouponVault source row (created once, approved and enabled; an admin may disable it later in Admin → Commerce → Coupons → Sources). */
export async function ensureCouponVaultSource() {
  const existing = await db.commerceSource.findUnique({ where: { slug: COUPONVAULT_SOURCE_SLUG } });
  if (existing) return existing;
  return db.commerceSource
    .create({
      data: {
        name: "CouponVault",
        slug: COUPONVAULT_SOURCE_SLUG,
        kind: COUPONVAULT_SOURCE_KIND,
        domain: "couponvault.net",
        enabled: true,
        termsStatus: "APPROVED",
        crawlFrequencyHours: 48,
        notes: COUPONVAULT_SOURCE_NOTES,
      },
    })
    .catch(async (error: unknown) => {
      const row = await db.commerceSource.findUnique({ where: { slug: COUPONVAULT_SOURCE_SLUG } });
      if (row) return row;
      throw error;
    });
}

/** Whether the CouponVault source is enabled and its terms approval stands (admin-controlled kill switch). */
export async function couponVaultRunnable(): Promise<boolean> {
  const source = await ensureCouponVaultSource();
  return sourceRunnable(source);
}
