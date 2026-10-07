import type { CommerceBrand, Prisma } from "@prisma/client";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { safeFetch } from "@/lib/net/safe-fetch";
import { normalizeUrl, robotsAllows } from "@/lib/pipeline/apify";
import { HIDDEN_LINK_STATUSES } from "./link-check";
import { onDomain } from "./urls";

/**
 * Price re-checks of existing offers. Public prices must stay ≤ 48 h fresh (PRODUCT_PRICE_MAX_AGE_HOURS),
 * but sitemap discovery is changed-first and capped, so a page that already carries an offer is not
 * necessarily re-crawled. A brand's run therefore starts with its offer pages whose price was last
 * observed more than COMMERCE_OFFER_RECHECK_HOURS ago (default 20): public deal candidates
 * (listPrice > price) first, then matched products, oldest first. Only then is the rest of the run
 * filled with newly discovered URLs.
 *
 * Re-check URLs bypass the sitemap, never the rules: each must be on the brand's official domain and
 * allowed by that host's robots.txt (read once per host; unreadable = not crawled). The crawl upserts
 * the same CommerceProduct (canonical URL) and the same offer rows (unique productId + destinationUrl).
 */

function envNum(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw == null || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Hours after which an offer's page is re-crawled for its price (COMMERCE_OFFER_RECHECK_HOURS, default 20). */
export const offerRecheckHours = () => envNum("COMMERCE_OFFER_RECHECK_HOURS", 20, 1, 24 * 30);
/** A FRESH public offer older than this would go stale (48 h) before the brand's next windowed crawl: crawl now. */
export const URGENT_RECHECK_HOURS = 36;
/** Cost guard: an urgent re-check never starts a brand crawl more often than this. */
export const URGENT_MIN_INTERVAL_HOURS = 6;

const HOUR = 3_600_000;
const userAgent = () => `Made4BuyersBot/1.0 (+${config.siteUrl()})`;

/** An offer that would show as a deal: a stated price below a stated list price. */
export function isDealOffer(o: { price: number | null; listPrice: number | null }): boolean {
  return typeof o.price === "number" && o.price > 0 && typeof o.listPrice === "number" && o.listPrice > o.price;
}

/** Offers that can appear publicly once fresh: FRESH or STALE, destination not known to be dead or off-site. */
export function publicCandidateOfferWhere(extra: Prisma.CommerceOfferWhereInput = {}): Prisma.CommerceOfferWhereInput {
  return { status: { in: ["FRESH", "STALE"] }, linkStatus: { notIn: [...HIDDEN_LINK_STATUSES] }, ...extra };
}

export type RecheckResult = { urls: string[]; due: number; skipped: Array<{ url: string; reason: string }> };

type RobotsEntry = { body: string | null; status: number; error?: string };

async function robotsFor(origin: string, cache: Map<string, Promise<RobotsEntry>>): Promise<RobotsEntry> {
  let p = cache.get(origin);
  if (!p) {
    p = safeFetch(`${origin}/robots.txt`, { timeoutMs: 8_000, maxRedirects: 3, readBody: true, maxBytes: 500_000, standardPortsOnly: true, headers: { "User-Agent": userAgent(), Accept: "text/plain,*/*;q=0.5" } }).then(
      (r) => ({ body: r.ok ? (r.body ?? "") : null, status: r.status, error: r.error?.kind }),
      (e: unknown) => ({ body: null, status: 0, error: String(e).slice(0, 80) }),
    );
    cache.set(origin, p);
  }
  return p;
}

/** Same rules as discovery: 4xx = the site publishes no rules; unreachable/5xx = do not crawl until it can be read. */
async function robotsVerdict(url: string, cache: Map<string, Promise<RobotsEntry>>): Promise<string | null> {
  const u = new URL(url);
  const r = await robotsFor(u.origin, cache);
  if (r.body != null) return robotsAllows(r.body, u.pathname + u.search) ? null : `disallowed by robots.txt (${u.pathname})`;
  if (r.status >= 400 && r.status < 500) return null;
  return `robots.txt could not be read (${r.status || r.error}); not crawling until it can`;
}

/**
 * The brand's offer pages due for a price re-check, best first, at most `limit` URLs.
 * Order: public deal candidates, then matched products, then the rest; oldest observation first.
 */
export async function recheckCandidates(brand: Pick<CommerceBrand, "id" | "officialDomain">, now: Date, limit: number, opts: { olderThanHours?: number } = {}): Promise<RecheckResult> {
  const cutoff = new Date(now.getTime() - (opts.olderThanHours ?? offerRecheckHours()) * HOUR);
  const rows = await db.commerceOffer.findMany({
    where: publicCandidateOfferWhere({ observedAt: { lt: cutoff }, product: { brandId: brand.id } }),
    select: { destinationUrl: true, price: true, listPrice: true, observedAt: true, product: { select: { canonicalUrl: true, identityStatus: true } } },
    orderBy: { observedAt: "asc" },
    take: 1000,
  });
  const score = (r: (typeof rows)[number]) => (isDealOffer(r) ? 0 : 2) + (r.product.identityStatus === "MATCHED" ? 0 : 1);
  const sorted = [...rows].sort((a, b) => score(a) - score(b) || a.observedAt.getTime() - b.observedAt.getTime());

  const urls: string[] = [];
  const skipped: RecheckResult["skipped"] = [];
  const robots = new Map<string, Promise<RobotsEntry>>();
  const seen = new Set<string>();
  for (const r of sorted) {
    if (urls.length >= Math.max(1, limit)) break;
    // The product page itself (it states every offer of the product); the offer URL only when the page's own URL is not usable.
    const candidates = [r.product.canonicalUrl, r.destinationUrl].map((u) => normalizeUrl(u)).filter((u): u is string => !!u);
    const url = candidates.find((u) => onDomain(u, brand.officialDomain));
    if (!url) {
      skipped.push({ url: r.destinationUrl, reason: `not on the official domain ${brand.officialDomain}` });
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    const blocked = await robotsVerdict(url, robots);
    if (blocked) {
      skipped.push({ url, reason: blocked });
      continue;
    }
    urls.push(url);
  }
  return { urls, due: rows.length, skipped: skipped.slice(0, 20) };
}

/**
 * Brands with a FRESH public offer (price stated, destination not dead) observed more than
 * URGENT_RECHECK_HOURS ago: without a crawl now it goes stale and the deal disappears.
 */
export async function urgentRecheckBrandIds(now: Date): Promise<string[]> {
  const cutoff = new Date(now.getTime() - URGENT_RECHECK_HOURS * HOUR);
  const rows = await db.commerceProduct.findMany({
    where: { brandId: { not: null }, offers: { some: { status: "FRESH", linkStatus: { notIn: [...HIDDEN_LINK_STATUSES] }, price: { not: null }, observedAt: { lt: cutoff } } } },
    select: { brandId: true },
    distinct: ["brandId"],
  });
  return rows.map((r) => r.brandId!).filter(Boolean);
}
