import type { CommerceOffer } from "@prisma/client";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { registrableDomain } from "@/lib/net/ip";
import { safeFetch, type SafeFetchResult } from "@/lib/net/safe-fetch";
import { robotsAllows } from "@/lib/pipeline/apify";
import { headThenGet, LINK_CHECK_USER_AGENT } from "@/lib/pipeline/verify-link";
import { commerceAudit } from "./audit";
import { revalidateCommerce } from "./revalidate";
import { normalizeDestinationUrl } from "./urls";

/**
 * Offer destination checks (job "commerce-validate-links").
 *
 * Each offer's destinationUrl is requested with the SSRF-safe client (HEAD, then a ranged GET when
 * HEAD is not a clean 2xx; ≤5 redirects; 12 s timeout), one request at a time per host with a small
 * pause between them, and only when the site's robots.txt allows the path. No login, CAPTCHA or
 * anti-bot workaround is ever attempted: a site that refuses an automated check is "BLOCKED" (still
 * displayable), never "BROKEN".
 *
 *   OK                    2xx on the same URL
 *   REDIRECTED_SAME_SITE  2xx after a redirect on the same registrable domain (not home/search/category)
 *   OFF_SITE              redirect to a different site                                   (hidden)
 *   BROKEN                404/410, or redirect to the home page, a search page or a parent
 *                         category page: the product page is gone                         (hidden)
 *   UNREACHABLE           network error / 5xx on 2 consecutive checks; the first failure
 *                         keeps the previous status                                      (hidden)
 *   BLOCKED               robots.txt disallows the URL, or the site refuses automated checks
 *                         (401/403/429, redirect loops). Displayable.
 * Offers are never deleted; the public pages read linkStatus.
 */

export const LINK_STATUSES = ["UNCHECKED", "OK", "REDIRECTED_SAME_SITE", "BROKEN", "OFF_SITE", "BLOCKED", "UNREACHABLE"] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];
/** Statuses that hide an offer publicly. */
export const HIDDEN_LINK_STATUSES: readonly LinkStatus[] = ["BROKEN", "OFF_SITE", "UNREACHABLE"];
const DEFINITIVE_BAD: readonly string[] = ["BROKEN", "OFF_SITE"];

const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 5;
const RECHECK_MS = 24 * 3_600_000;

function envNum(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw == null || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

export const linkChecksPerRun = () => envNum("COMMERCE_LINK_CHECKS_PER_RUN", 60, 1, 1000);
/** Pause between two requests to the same host (robots.txt included). */
export const sameHostDelayMs = () => envNum("COMMERCE_LINK_CHECK_DELAY_MS", 1000, 0, 30_000);
/** Wall-clock budget for one run, below the cron route's maxDuration (300 s). */
export const linkCheckBudgetMs = () => envNum("COMMERCE_LINK_CHECK_BUDGET_MS", 240_000, 1_000, 280_000);
const HOST_CONCURRENCY = 4;

// ── Classification (pure) ────────────────────────────────────────────────

/** What one check found. FAILURE and INCONCLUSIVE are resolved against the previous state by nextLinkState. */
export type LinkCheck =
  | { kind: "RESULT"; status: "OK" | "REDIRECTED_SAME_SITE" | "BROKEN" | "OFF_SITE"; httpStatus: number | null; finalUrl: string | null; reason: string }
  | { kind: "ROBOTS"; httpStatus: null; finalUrl: null; reason: string }
  | { kind: "INCONCLUSIVE"; httpStatus: number | null; finalUrl: string | null; reason: string }
  | { kind: "FAILURE"; httpStatus: number; finalUrl: string | null; reason: string };

const LOCALE = /^[a-z]{2}(?:[-_][a-z]{2,4})?$/;
const pathSegments = (u: URL) => u.pathname.toLowerCase().split("/").filter(Boolean);

/** "/", "/us", "/en-us", "/us/en", "/index.html", "/home" … */
function isHome(u: URL): boolean {
  const segs = pathSegments(u).filter((s) => !/^(index|default)\.(html?|php|aspx?)$/.test(s));
  if (!segs.length) return true;
  if (segs.length === 1 && segs[0] === "home") return true;
  return segs.length <= 2 && segs.every((s) => LOCALE.test(s));
}

const SEARCH_PATH = /^(search|catalogsearch|s|find|results|search-results)$/;
const SEARCH_KEYS = new Set(["q", "query", "search", "searchterm", "search_query", "keyword", "keywords", "text", "term", "k"]);
function isSearch(u: URL): boolean {
  if (pathSegments(u).some((s) => SEARCH_PATH.test(s))) return true;
  return [...u.searchParams.keys()].some((k) => SEARCH_KEYS.has(k.toLowerCase()));
}

const CATEGORY_LEAF = /^(category|categories|collections?|products?|shop|catalog|c|all|browse)$/;
/** The final page is a parent of the product URL (e.g. /products/espresso/bes870 → /products/espresso) or a bare listing. */
function isCategoryOf(dest: URL, fin: URL): boolean {
  const d = pathSegments(dest);
  const f = pathSegments(fin);
  if (f.length && CATEGORY_LEAF.test(f[f.length - 1])) return true;
  return f.length < d.length && f.every((s, i) => s === d[i]);
}

/** Same page: equal after normalization, ignoring http/https and a leading www. */
function samePage(a: string, b: string): boolean {
  const key = (x: string) => {
    const n = normalizeDestinationUrl(x);
    if (!n) return x;
    const u = new URL(n);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname}${u.search}`;
  };
  return key(a) === key(b);
}

function siteOf(url: string): string | null {
  try {
    return registrableDomain(new URL(url).hostname);
  } catch {
    return null;
  }
}

/** Classifies a fetch of `destinationUrl` (after redirects). Pure. */
export function classifyLinkFetch(destinationUrl: string, r: SafeFetchResult): LinkCheck {
  const httpStatus = r.status || null;
  const finalUrl = r.finalUrl || null;
  if (r.error) {
    const msg = r.error.message.slice(0, 200);
    switch (r.error.kind) {
      case "TIMEOUT":
      case "DNS_FAILURE":
      case "NETWORK":
        return { kind: "FAILURE", httpStatus: 0, finalUrl, reason: `${r.error.kind}: ${msg}` };
      case "REDIRECT_LOOP":
      case "TOO_MANY_REDIRECTS":
      case "REDIRECT_WITHOUT_LOCATION":
      case "RESPONSE_TOO_LARGE":
        return { kind: "INCONCLUSIVE", httpStatus, finalUrl, reason: `${r.error.kind}: ${msg}` };
      case "BLOCKED_HOST":
      case "BLOCKED_PORT":
        // A redirect into a non-public address leaves the merchant's site; a non-public destination is unusable.
        return r.chain.length
          ? { kind: "RESULT", status: "OFF_SITE", httpStatus, finalUrl, reason: `redirects to a non-public address: ${msg}` }
          : { kind: "RESULT", status: "BROKEN", httpStatus, finalUrl, reason: `destination is not a public address: ${msg}` };
      default:
        return { kind: "RESULT", status: "BROKEN", httpStatus, finalUrl, reason: `${r.error.kind}: ${msg}` };
    }
  }
  const s = r.status;
  if (s === 404 || s === 410) return { kind: "RESULT", status: "BROKEN", httpStatus: s, finalUrl, reason: `HTTP ${s}: the page is gone` };
  if (s >= 500) return { kind: "FAILURE", httpStatus: s, finalUrl, reason: `HTTP ${s}` };
  if (s < 200 || s >= 300) return { kind: "INCONCLUSIVE", httpStatus: s, finalUrl, reason: `HTTP ${s}: the site did not allow an automated check` };

  if (!finalUrl || samePage(destinationUrl, finalUrl)) return { kind: "RESULT", status: "OK", httpStatus: s, finalUrl, reason: `HTTP ${s}` };
  const destSite = siteOf(destinationUrl);
  const finSite = siteOf(finalUrl);
  if (!destSite || !finSite || destSite !== finSite) return { kind: "RESULT", status: "OFF_SITE", httpStatus: s, finalUrl, reason: `redirects to another site (${finSite ?? "unknown"})` };
  const dest = new URL(destinationUrl);
  const fin = new URL(finalUrl);
  if (isHome(fin) && !isHome(dest)) return { kind: "RESULT", status: "BROKEN", httpStatus: s, finalUrl, reason: "redirects to the home page: the product page is gone" };
  if (isSearch(fin) && !isSearch(dest)) return { kind: "RESULT", status: "BROKEN", httpStatus: s, finalUrl, reason: "redirects to a search page: the product page is gone" };
  if (isCategoryOf(dest, fin)) return { kind: "RESULT", status: "BROKEN", httpStatus: s, finalUrl, reason: "redirects to a category page: the product page is gone" };
  return { kind: "RESULT", status: "REDIRECTED_SAME_SITE", httpStatus: s, finalUrl, reason: `HTTP ${s} after redirect on the same site` };
}

type PrevState = Pick<CommerceOffer, "linkStatus" | "linkHttpStatus" | "linkCheckedAt" | "linkFinalUrl">;
export type NextLinkState = { linkStatus: LinkStatus; linkHttpStatus: number | null; linkFinalUrl: string | null; reason: string };

/** A stored check that failed (network error = 0, or 5xx). */
const lastCheckFailed = (p: PrevState) => p.linkCheckedAt != null && p.linkHttpStatus != null && (p.linkHttpStatus === 0 || p.linkHttpStatus >= 500);

const asStatus = (s: string): LinkStatus => (LINK_STATUSES as readonly string[]).includes(s) ? (s as LinkStatus) : "UNCHECKED";

/**
 * The state to store after a check. Never erases a finding because a check could not be completed:
 * a first failure keeps the previous status; robots.txt or a refused check keeps a definitive
 * BROKEN/OFF_SITE finding and is otherwise BLOCKED (robots) or the previous status.
 */
export function nextLinkState(prev: PrevState, check: LinkCheck): NextLinkState {
  const prevStatus = asStatus(prev.linkStatus);
  switch (check.kind) {
    case "RESULT":
      return { linkStatus: check.status, linkHttpStatus: check.httpStatus, linkFinalUrl: check.finalUrl, reason: check.reason };
    case "ROBOTS":
      return { linkStatus: DEFINITIVE_BAD.includes(prevStatus) ? prevStatus : "BLOCKED", linkHttpStatus: null, linkFinalUrl: prev.linkFinalUrl, reason: check.reason };
    case "INCONCLUSIVE":
      return { linkStatus: prevStatus === "UNCHECKED" || prevStatus === "UNREACHABLE" ? "BLOCKED" : prevStatus, linkHttpStatus: check.httpStatus, linkFinalUrl: check.finalUrl ?? prev.linkFinalUrl, reason: check.reason };
    case "FAILURE":
      return lastCheckFailed(prev)
        ? { linkStatus: "UNREACHABLE", linkHttpStatus: check.httpStatus, linkFinalUrl: check.finalUrl ?? prev.linkFinalUrl, reason: `${check.reason} (second consecutive failure)` }
        : { linkStatus: prevStatus, linkHttpStatus: check.httpStatus, linkFinalUrl: prev.linkFinalUrl, reason: `${check.reason} (first failure: previous status kept)` };
  }
}

// ── Fetching ─────────────────────────────────────────────────────────────

type RobotsVerdict = { allowed: true } | { allowed: false; failure: boolean; reason: string; httpStatus: number };

/** robots.txt for the `*` group. 4xx = no rules. Unreadable (network/5xx) = a failed check, not a block. */
async function robotsFor(origin: string, cache: Map<string, Promise<{ ok: boolean; body: string | null; status: number; error?: string }>>) {
  let p = cache.get(origin);
  if (!p) {
    p = safeFetch(`${origin}/robots.txt`, { timeoutMs: 8_000, maxRedirects: 3, readBody: true, maxBytes: 500_000, standardPortsOnly: true, headers: { "User-Agent": LINK_CHECK_USER_AGENT() } }).then((r) => ({
      ok: r.ok,
      status: r.status,
      body: r.ok ? (r.body ?? "") : null,
      error: r.error?.kind,
    }));
    cache.set(origin, p);
  }
  return p;
}

async function robotsVerdict(url: string, cache: Map<string, ReturnType<typeof robotsFor>>): Promise<RobotsVerdict & { fetched: boolean }> {
  const u = new URL(url);
  const fetched = !cache.has(u.origin);
  const r = await robotsFor(u.origin, cache);
  if (r.body != null) return robotsAllows(r.body, u.pathname + u.search) ? { allowed: true, fetched } : { allowed: false, failure: false, reason: `robots.txt disallows ${u.pathname}`, httpStatus: r.status, fetched };
  if (r.status >= 400 && r.status < 500) return { allowed: true, fetched };
  return { allowed: false, failure: true, reason: `robots.txt could not be read (${r.status || r.error}); not checked`, httpStatus: r.status >= 500 ? r.status : 0, fetched };
}

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

/** Checks one destination: robots.txt first, then HEAD → ranged GET. `pause` runs between same-host requests. */
export async function checkDestination(destinationUrl: string, opts: { robots?: Map<string, ReturnType<typeof robotsFor>>; pause?: () => Promise<void> } = {}): Promise<LinkCheck> {
  let url: URL;
  try {
    url = new URL(destinationUrl);
  } catch {
    return { kind: "RESULT", status: "BROKEN", httpStatus: null, finalUrl: null, reason: "destination is not a valid URL" };
  }
  const robots = await robotsVerdict(url.toString(), opts.robots ?? new Map());
  if (!robots.allowed) {
    if (robots.failure) return { kind: "FAILURE", httpStatus: robots.httpStatus, finalUrl: null, reason: robots.reason };
    return { kind: "ROBOTS", httpStatus: null, finalUrl: null, reason: robots.reason };
  }
  if (robots.fetched) await opts.pause?.();
  const result = await headThenGet(url.toString(), {
    timeoutMs: TIMEOUT_MS,
    maxRedirects: MAX_REDIRECTS,
    // Retry as GET unless HEAD was a clean 2xx or the host is plainly unreachable.
    fallback: (head) => (head.error ? head.error.kind === "NETWORK" : head.status < 200 || head.status >= 300),
  });
  return classifyLinkFetch(destinationUrl, result);
}

// ── Job ──────────────────────────────────────────────────────────────────

type DueOffer = Pick<CommerceOffer, "id" | "destinationUrl" | "status" | "linkStatus" | "linkHttpStatus" | "linkCheckedAt" | "linkFinalUrl"> & { product: { productEntityId: string | null } };

/**
 * Offers not checked in the last 24 h (or, with `checkedBefore`, not checked since that time — the
 * weekly deals sweep checks every offer once): FRESH first, then STALE; never-checked and oldest-checked first.
 */
export async function dueOffers(now: Date, limit: number, checkedBefore?: Date): Promise<DueOffer[]> {
  const where = { OR: [{ linkCheckedAt: null }, { linkCheckedAt: { lt: checkedBefore ?? new Date(now.getTime() - RECHECK_MS) } }] };
  const select = { id: true, destinationUrl: true, status: true, linkStatus: true, linkHttpStatus: true, linkCheckedAt: true, linkFinalUrl: true, product: { select: { productEntityId: true } } } as const;
  const orderBy = [{ linkCheckedAt: { sort: "asc" as const, nulls: "first" as const } }, { observedAt: "desc" as const }];
  const fresh = await db.commerceOffer.findMany({ where: { status: "FRESH", ...where }, select, orderBy, take: limit });
  const stale = fresh.length < limit ? await db.commerceOffer.findMany({ where: { status: "STALE", ...where }, select, orderBy, take: limit - fresh.length }) : [];
  return [...fresh, ...stale];
}

export type LinkCheckOutcome = { offerId: string; host: string; from: string; to: LinkStatus; httpStatus: number | null; reason: string };

async function storeCheck(offer: DueOffer, next: NextLinkState, now: Date): Promise<LinkCheckOutcome & { changed: boolean }> {
  await db.commerceOffer.update({ where: { id: offer.id }, data: { linkStatus: next.linkStatus, linkHttpStatus: next.linkHttpStatus, linkFinalUrl: next.linkFinalUrl?.slice(0, 2000) ?? null, linkCheckedAt: now } });
  const changed = next.linkStatus !== offer.linkStatus;
  if (changed) {
    const action = HIDDEN_LINK_STATUSES.includes(next.linkStatus) ? "LINK_REJECTED" : "LINK_VALIDATED";
    await commerceAudit(action, "commerce_offer", offer.id, {
      before: { linkStatus: offer.linkStatus },
      after: { linkStatus: next.linkStatus },
      metadata: { url: offer.destinationUrl, httpStatus: next.linkHttpStatus, finalUrl: next.linkFinalUrl, reason: next.reason },
    });
  }
  let host = "";
  try {
    host = new URL(offer.destinationUrl).host;
  } catch {
    /* invalid URL */
  }
  return { offerId: offer.id, host, from: offer.linkStatus, to: next.linkStatus, httpStatus: next.linkHttpStatus, reason: next.reason, changed };
}

export type LinkValidationOptions = { checkedBefore?: Date; budgetMs?: number; limit?: number };

/** Job "commerce-validate-links": checks due offer destinations. Idempotent (24 h re-check window); run under a job lock. */
export async function runLinkValidation(trigger: string, now = new Date(), opts: LinkValidationOptions = {}) {
  const started = Date.now();
  const offers = await dueOffers(now, opts.limit ?? linkChecksPerRun(), opts.checkedBefore);
  if (!offers.length) return { status: "OK", trigger, due: 0, checked: 0, changed: 0, results: [] as LinkCheckOutcome[] };

  const byHost = new Map<string, DueOffer[]>();
  for (const o of offers) {
    let host = "invalid";
    try {
      host = new URL(o.destinationUrl).host.toLowerCase();
    } catch {
      /* grouped as "invalid" */
    }
    byHost.set(host, [...(byHost.get(host) ?? []), o]);
  }

  const robots = new Map<string, ReturnType<typeof robotsFor>>();
  const results: Array<LinkCheckOutcome & { changed: boolean }> = [];
  const touchedEntities = new Set<string>();
  const delay = sameHostDelayMs();
  const budget = Math.min(linkCheckBudgetMs(), opts.budgetMs ?? Infinity);
  let outOfTime = false;

  // Hosts run in parallel (bounded); requests to one host run one at a time with a pause between them.
  const queue = [...byHost.values()];
  const worker = async () => {
    for (let list = queue.shift(); list; list = queue.shift()) {
      for (const [i, offer] of list.entries()) {
        if (Date.now() - started > budget) {
          outOfTime = true;
          return;
        }
        if (i > 0) await sleep(delay);
        try {
          const check = await checkDestination(offer.destinationUrl, { robots, pause: () => sleep(delay) });
          const r = await storeCheck(offer, nextLinkState(offer, check), now);
          results.push(r);
          if (r.changed && offer.product.productEntityId) touchedEntities.add(offer.product.productEntityId);
        } catch (error) {
          log.warn("offer link check failed", { stage: "COMMERCE", offerId: offer.id, error: String(error).slice(0, 200) });
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HOST_CONCURRENCY, byHost.size) }, worker));

  const changed = results.filter((r) => r.changed);
  if (changed.length) {
    // A page that went (or came back) dead changes which facts are current: rebuild the summaries
    // before the review pages are rebuilt and revalidated.
    const { refreshSummary } = await import("./pipeline");
    for (const id of touchedEntities) await refreshSummary(id, new Date()).catch((error) => log.warn("summary refresh after link check failed", { stage: "COMMERCE", entityId: id, error: String(error).slice(0, 200) }));
    await revalidateCommerce(touchedEntities);
  }
  const count = (s: LinkStatus) => results.filter((r) => r.to === s).length;
  log.info("commerce link validation", { stage: "COMMERCE", trigger, due: offers.length, checked: results.length, changed: changed.length });
  return {
    status: "OK",
    trigger,
    due: offers.length,
    checked: results.length,
    changed: changed.length,
    ...(outOfTime ? { reason: `time budget reached; ${offers.length - results.length} offer(s) left for the next run` } : {}),
    byStatus: Object.fromEntries(LINK_STATUSES.map((s) => [s, count(s)]).filter(([, n]) => n)),
    results: results.slice(0, 100).map((r): LinkCheckOutcome => ({ offerId: r.offerId, host: r.host, from: r.from, to: r.to, httpStatus: r.httpStatus, reason: r.reason })),
  };
}
