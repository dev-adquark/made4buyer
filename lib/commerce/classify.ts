import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { dropCandidateWhere, loadClassifiedOffers } from "@/lib/public/deals";
import { commerceAudit } from "./audit";
import { DEAL_STATUSES, type DealReason, type DealStatus } from "./deal-status";
import { recordVerification, type VerificationEventInput } from "./verification-events";

/**
 * Persisted deal status (CommerceOffer.dealStatus / dealStatusReasons / dealStatusAt).
 *
 * The status is decided by lib/commerce/deal-status.ts through the SAME loader /deals uses
 * (lib/public/deals.ts loadClassifiedOffers → classifyOffers), so the inputs (product, brand,
 * official reference, page data, link status) and the duplicate resolution are identical. To make
 * duplicate resolution match /deals when only some offers are classified, every batch is classified
 * together with all current drop candidates (dropCandidateWhere, the set /deals classifies), and the
 * candidates' statuses are persisted too: a new ACTIVE offer can displace a listed one (it becomes a
 * DUPLICATE) even when only the new one was asked for. Each offer is written at most once per run.
 *
 * Public pages never read this column: /deals keeps computing live (stricter and time-dependent:
 * an offer turns stale between two classifications). The persisted status is for Admin, filtering
 * and history. A write happens only when the status or its reason codes changed (reason messages
 * that only carry a changing age are not a change); each change records a DEAL_STATUS verification
 * event, and a transition into or out of ACTIVE also an audit event (DEAL_ACTIVATED / DEAL_DEACTIVATED).
 */

const BATCH = 500;

export type ClassifyOptions = {
  /** Only these offers (default: every offer). */
  offerIds?: string[];
  /** Also the offers of commerce products matched to these Made4Buyers products. */
  productEntityIds?: string[];
  now?: Date | number;
};

export type ClassifyResult = {
  status: "OK";
  /** Offers in scope that were classified. */
  checked: number;
  /** Drop candidates outside the scope, classified for duplicate resolution (persisted when changed). */
  context: number;
  /** Writes, scope and context together. */
  changed: number;
  activated: number;
  deactivated: number;
  /** Statuses of every offer classified (scope and context). */
  byStatus: Record<DealStatus, number>;
};

const codesOf = (reasons: unknown): string =>
  Array.isArray(reasons)
    ? reasons
        .map((r) => (r && typeof r === "object" && typeof (r as { code?: unknown }).code === "string" ? (r as { code: string }).code : ""))
        .filter(Boolean)
        .sort()
        .join(",")
    : "";

const stored = (reasons: DealReason[]) => reasons.map((r) => ({ code: r.code, message: r.message.slice(0, 300) }));

async function scopeIds(opts: ClassifyOptions): Promise<string[] | null> {
  if (opts.offerIds === undefined && opts.productEntityIds === undefined) return null;
  const ids = new Set(opts.offerIds ?? []);
  const entityIds = [...new Set(opts.productEntityIds ?? [])];
  if (entityIds.length) {
    const rows = await db.commerceOffer.findMany({ where: { product: { productEntityId: { in: entityIds } } }, select: { id: true } });
    for (const r of rows) ids.add(r.id);
  }
  return [...ids];
}

/** Classifies and persists one batch of offer ids (classified alongside the /deals candidate set). */
async function classifyBatch(ids: string[], nowMs: number, candidateWhere: Prisma.CommerceOfferWhereInput, candidateCount: number, done: Set<string>, out: ClassifyResult) {
  if (!ids.length) return;
  const inBatch = new Set(ids);
  const classified = (await loadClassifiedOffers({ where: { OR: [{ id: { in: ids } }, candidateWhere] }, take: ids.length + candidateCount, now: nowMs })).filter((x) => !done.has(x.offer.id));
  if (!classified.length) return;
  const current = await db.commerceOffer.findMany({ where: { id: { in: classified.map((x) => x.offer.id) } }, select: { id: true, dealStatus: true, dealStatusReasons: true } });
  const currentById = new Map(current.map((c) => [c.id, c]));
  const events: VerificationEventInput[] = [];
  const at = new Date(nowMs);
  for (const x of classified) {
    const id = x.offer.id;
    done.add(id);
    const v = x.verdict;
    out.byStatus[v.status]++;
    if (inBatch.has(id)) out.checked++;
    else out.context++;
    const prev = currentById.get(id);
    if (!prev) continue;
    if (prev.dealStatus === v.status && codesOf(prev.dealStatusReasons) === codesOf(v.reasons)) continue;
    // Conditional write: a concurrent classification that already stored this change wins (no duplicate event).
    const w = await db.commerceOffer.updateMany({
      where: { id, dealStatus: prev.dealStatus },
      data: { dealStatus: v.status, dealStatusReasons: stored(v.reasons), dealStatusAt: at },
    });
    if (!w.count) continue;
    out.changed++;
    const codes = v.reasons.map((r) => r.code);
    events.push({
      entityType: "offer",
      entityId: id,
      kind: "DEAL_STATUS",
      result: v.status,
      reason: v.reasons[0]?.message ?? null,
      sourceUrl: x.offer.destinationUrl,
      details: { from: prev.dealStatus, to: v.status, codes },
      checkedAt: at,
    });
    const intoActive = v.status === "ACTIVE" && prev.dealStatus !== "ACTIVE";
    const outOfActive = prev.dealStatus === "ACTIVE" && v.status !== "ACTIVE";
    if (intoActive || outOfActive) {
      if (intoActive) out.activated++;
      else out.deactivated++;
      await commerceAudit(intoActive ? "DEAL_ACTIVATED" : "DEAL_DEACTIVATED", "commerce_offer", id, {
        before: { dealStatus: prev.dealStatus },
        after: { dealStatus: v.status },
        metadata: { url: x.offer.destinationUrl, reasons: codes.join(",") || null, price: x.offer.price, listPrice: x.offer.listPrice },
      });
    }
  }
  await recordVerification(events);
}

/**
 * Classifies offers with deal-status.ts (the /deals decision) and persists dealStatus /
 * dealStatusReasons / dealStatusAt where they changed. All offers, or the given offer ids and/or
 * the offers of the given product entities; bounded batches of 500. Idempotent.
 */
export async function classifyOfferStatuses(opts: ClassifyOptions = {}): Promise<ClassifyResult> {
  const nowMs = opts.now instanceof Date ? opts.now.getTime() : (opts.now ?? Date.now());
  const out: ClassifyResult = { status: "OK", checked: 0, context: 0, changed: 0, activated: 0, deactivated: 0, byStatus: Object.fromEntries(DEAL_STATUSES.map((s) => [s, 0])) as Record<DealStatus, number> };
  const scope = await scopeIds(opts);
  if (scope && !scope.length) return out;
  const candidateWhere = dropCandidateWhere(nowMs);
  const candidateCount = await db.commerceOffer.count({ where: candidateWhere });
  const done = new Set<string>();
  if (scope) {
    for (let i = 0; i < scope.length; i += BATCH) await classifyBatch(scope.slice(i, i + BATCH), nowMs, candidateWhere, candidateCount, done, out);
    return out;
  }
  let cursor: string | undefined;
  for (;;) {
    const page = await db.commerceOffer.findMany({ select: { id: true }, orderBy: { id: "asc" }, take: BATCH, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    if (!page.length) break;
    await classifyBatch(
      page.map((p) => p.id),
      nowMs,
      candidateWhere,
      candidateCount,
      done,
      out,
    );
    if (page.length < BATCH) break;
    cursor = page[page.length - 1].id;
  }
  // Every offer was in scope.
  out.checked += out.context;
  out.context = 0;
  return out;
}

/** Same, never throwing (for inline use at the end of other jobs). */
export async function classifyOfferStatusesSafe(opts: ClassifyOptions = {}): Promise<ClassifyResult | { status: "FAILED"; reason: string }> {
  try {
    return await classifyOfferStatuses(opts);
  } catch (error) {
    log.warn("deal status classification failed", { stage: "COMMERCE", error: String(error).slice(0, 200) });
    return { status: "FAILED", reason: String(error).slice(0, 200) };
  }
}

/** Job "commerce-classify-deals": classifies every offer. Idempotent; run under a job lock. */
export async function runClassifyDeals(trigger: string, now = new Date()) {
  const r = await classifyOfferStatuses({ now });
  log.info("commerce deal status classification", { stage: "COMMERCE", trigger, checked: r.checked, changed: r.changed, activated: r.activated, deactivated: r.deactivated });
  return { ...r, trigger };
}

/** Counts by the persisted status (Admin). `unclassified`: offers never classified. */
export async function dealStatusCounts(): Promise<{ total: number; unclassified: number; byStatus: Record<DealStatus, number>; other: number }> {
  const groups = await db.commerceOffer.groupBy({ by: ["dealStatus"], _count: { _all: true } });
  const byStatus = Object.fromEntries(DEAL_STATUSES.map((s) => [s, 0])) as Record<DealStatus, number>;
  let total = 0;
  let unclassified = 0;
  let other = 0;
  for (const g of groups) {
    const n = g._count._all;
    total += n;
    if (g.dealStatus == null) unclassified += n;
    else if ((DEAL_STATUSES as readonly string[]).includes(g.dealStatus)) byStatus[g.dealStatus as DealStatus] += n;
    else other += n;
  }
  return { total, unclassified, byStatus, other };
}
