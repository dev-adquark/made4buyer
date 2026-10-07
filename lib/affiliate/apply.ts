import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { activeProviderNames, affiliateConfigIssues, getAffiliateProvider, safeWrap } from "./provider";

/**
 * Stores provider-generated affiliate links on CommerceOffer rows (affiliateUrl,
 * affiliateProvider, affiliateStatus). Never touches destinationUrl: the plain link is always
 * kept and is what pages and /go/<id> use whenever affiliateStatus is not AFFILIATED.
 *
 *  - No active provider → every AFFILIATED offer is reverted to NONE (links plain again), so the
 *    site never carries affiliate links the disclosure page doesn't announce.
 *  - Active provider → offers never tried (NONE), transiently failed (UNAVAILABLE), or decided by
 *    a provider that is no longer configured are (re)wrapped, bounded by `limit` per run.
 * Any provider error leaves the offer on its plain link (UNAVAILABLE) and is retried next run.
 */
export type AffiliateRunResult = { status: "OK" | "NOT_CONFIGURED"; provider: string; checked: number; affiliated: number; notAffiliatable: number; unavailable: number; reverted: number; reason?: string };

export async function runAffiliateLinks(trigger: string, opts: { limit?: number } = {}): Promise<AffiliateRunResult> {
  const provider = getAffiliateProvider();
  const names = activeProviderNames();
  if (!provider.active) {
    const reverted = await db.commerceOffer.updateMany({ where: { affiliateStatus: { not: "NONE" } }, data: { affiliateUrl: null, affiliateProvider: null, affiliateStatus: "NONE" } });
    const issues = affiliateConfigIssues();
    const reason = issues.missingEnv.length || issues.unknown.length ? `affiliate provider not usable: ${[...issues.unknown.map((u) => `unknown provider "${u}"`), ...issues.missingEnv.map((m) => `missing ${m}`)].join(", ")}` : "AFFILIATE_PROVIDER=none: links stay plain";
    return { status: "NOT_CONFIGURED", provider: provider.name, checked: 0, affiliated: 0, notAffiliatable: 0, unavailable: 0, reverted: reverted.count, reason };
  }
  const chainKey = names.join("+");
  const recheckBefore = new Date(Date.now() - 7 * 86_400_000);
  const offers = await db.commerceOffer.findMany({
    where: {
      status: { in: ["FRESH", "STALE"] },
      OR: [
        { affiliateStatus: { in: ["NONE", "UNAVAILABLE"] } },
        // Affiliated by a provider that is no longer configured.
        { affiliateStatus: "AFFILIATED", OR: [{ affiliateProvider: null }, { affiliateProvider: { notIn: names } }] },
        // "Not affiliatable" decided by a different provider set, or a week ago (merchant lists change).
        { affiliateStatus: "NOT_AFFILIATABLE", OR: [{ affiliateProvider: null }, { affiliateProvider: { not: chainKey } }, { updatedAt: { lt: recheckBefore } }] },
      ],
    },
    // Oldest first: every update bumps updatedAt, so repeated runs rotate through the backlog.
    orderBy: { updatedAt: "asc" },
    take: Math.max(1, Math.min(opts.limit ?? 200, 2000)),
    select: { id: true, destinationUrl: true },
  });
  const r: AffiliateRunResult = { status: "OK", provider: provider.name, checked: 0, affiliated: 0, notAffiliatable: 0, unavailable: 0, reverted: 0 };
  for (const o of offers) {
    r.checked++;
    const w = await safeWrap(provider, o.destinationUrl);
    if (w.status === "AFFILIATED") {
      r.affiliated++;
      await db.commerceOffer.update({ where: { id: o.id }, data: { affiliateUrl: w.affiliateUrl, affiliateProvider: w.provider ?? provider.name, affiliateStatus: "AFFILIATED" } });
    } else {
      if (w.status === "NOT_AFFILIATABLE") r.notAffiliatable++;
      else r.unavailable++;
      // Recorded against the provider chain that decided, so a later provider change re-checks it.
      await db.commerceOffer.update({ where: { id: o.id }, data: { affiliateUrl: null, affiliateProvider: chainKey || provider.name, affiliateStatus: w.status } });
    }
  }
  log.info("affiliate links applied", { stage: "AFFILIATE", trigger, ...r });
  return r;
}
