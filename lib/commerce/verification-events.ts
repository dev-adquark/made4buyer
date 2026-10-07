import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { log } from "@/lib/log";

/**
 * Verification history (CommerceVerificationEvent): one row for EVERY check the commerce engine
 * performs, including checks that changed nothing. AuditLog keeps only changes; this keeps the
 * evidence trail ("checked 3 times this week, OK each time").
 *
 *   kind         entityType / entityId                       written by
 *   LINK         offer / CommerceOffer.id                    link-check.ts (every destination check)
 *   OFFICIAL     product / ProductEntity.id                  official.ts (every VERIFIED / MISMATCH / NOT_FOUND decision)
 *   COUPON       coupon / CommerceCoupon.id                  coupons.ts (every verification at collect, disappearance, expiry)
 *   PRICE        offer / CommerceOffer.id (CREATED, CHANGED) recordPriceChange: only when price or list price changed
 *                product / CommerceProduct.id (REJECTED)     recordPriceRejected: an offer that was refused
 *   IDENTITY     product / CommerceProduct.id                recordIdentityDecision: every identity decision
 *   DEAL_STATUS  offer / CommerceOffer.id                    classify.ts: only when the persisted deal status changed
 *   LOGO         brand / CommerceBrand.id                    brand-logos.ts: every official-logo check (VERIFIED / NOT_FOUND / FAILED / REJECTED)
 *
 * Writing an event never throws and never fails the check it records. `details` is kept small
 * (strings ≤ 300 chars, ≤ 20 keys / items per level, ≤ 3 levels, ≤ 2 KB serialized).
 * Retention: pruneVerificationEvents (cleanup-cache job) deletes events older than 90 days but
 * always keeps the latest event per (entityType, entityId, kind).
 */

export const VERIFICATION_KINDS = ["LINK", "OFFICIAL", "COUPON", "PRICE", "IDENTITY", "DEAL_STATUS", "LOGO"] as const;
export type VerificationKind = (typeof VERIFICATION_KINDS)[number];
export type VerificationEntityType = "offer" | "coupon" | "product" | "brand";

export type VerificationEventInput = {
  entityType: VerificationEntityType;
  entityId: string;
  kind: VerificationKind;
  result: string;
  reason?: string | null;
  sourceUrl?: string | null;
  details?: Record<string, unknown> | null;
  checkedAt?: Date;
};

const BATCH = 500;
const MAX_STRING = 300;
const MAX_ITEMS = 20;
const MAX_DEPTH = 3;
const MAX_DETAILS_CHARS = 2000;

function compact(v: unknown, depth: number): unknown {
  if (v === undefined) return undefined;
  if (v === null || typeof v === "number" || typeof v === "boolean") return Number.isNaN(v) ? null : v;
  if (typeof v === "string") return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  if (typeof v === "bigint") return v.toString();
  if (depth >= MAX_DEPTH) return typeof v === "object" ? "[…]" : String(v).slice(0, MAX_STRING);
  if (Array.isArray(v)) return v.slice(0, MAX_ITEMS).map((x) => compact(x, depth + 1) ?? null);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, MAX_ITEMS)) {
      const c = compact(x, depth + 1);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return String(v).slice(0, MAX_STRING);
}

/** `details` bounded in size; null when empty. Exported for tests. */
export function smallDetails(details: Record<string, unknown> | null | undefined): Prisma.InputJsonValue | undefined {
  if (!details) return undefined;
  const c = compact(details, 0) as Record<string, unknown>;
  if (!Object.keys(c).length) return undefined;
  const json = JSON.stringify(c);
  if (json.length <= MAX_DETAILS_CHARS) return c as Prisma.InputJsonValue;
  // Still too big: keep the scalar fields only.
  const scalars = Object.fromEntries(Object.entries(c).filter(([, x]) => x === null || typeof x !== "object"));
  return { ...scalars, truncated: true } as Prisma.InputJsonValue;
}

const clip = (s: string | null | undefined, n: number) => (s == null ? null : s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Writes the events (batched createMany). Never throws: a failed write is logged and the check it
 * records goes on. Returns the number of rows written.
 */
export async function recordVerification(events: VerificationEventInput[]): Promise<number> {
  const rows = events
    .filter((e) => e && e.entityId && e.kind && e.result)
    .map(
      (e): Prisma.CommerceVerificationEventCreateManyInput => ({
        entityType: e.entityType,
        entityId: e.entityId,
        kind: e.kind,
        result: clip(e.result, 64)!,
        reason: clip(e.reason, 1000),
        sourceUrl: clip(e.sourceUrl, 2000),
        details: smallDetails(e.details),
        ...(e.checkedAt ? { checkedAt: e.checkedAt } : {}),
      }),
    );
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    try {
      written += (await db.commerceVerificationEvent.createMany({ data: rows.slice(i, i + BATCH) })).count;
    } catch (error) {
      log.warn("verification event write failed", { stage: "COMMERCE", events: rows.slice(i, i + BATCH).length, error: String(error).slice(0, 200) });
    }
  }
  return written;
}

/** The latest events for one entity (newest first). */
export async function latestVerifications(entityType: VerificationEntityType, entityId: string, take = 20, kind?: VerificationKind) {
  return db.commerceVerificationEvent.findMany({
    where: { entityType, entityId, ...(kind ? { kind } : {}) },
    orderBy: [{ checkedAt: "desc" }, { id: "desc" }],
    take: Math.max(1, Math.min(200, take)),
  });
}

// ── Helpers for the collect pipeline (lib/commerce/pipeline.ts) ─────────────────

export type IdentityDecisionInput = {
  /** CommerceProduct.id */
  commerceProductId: string;
  /** MATCHED | MATCH_REJECTED | UNMATCHED */
  result: string;
  basis?: string | null;
  reason: string;
  /** The Made4Buyers product it was matched to (MATCHED). */
  productEntityId?: string | null;
  /** The product it nearly matched (MATCH_REJECTED for a variant / identity difference). */
  nearEntityId?: string | null;
  sourceUrl?: string | null;
  at?: Date;
};

/** IDENTITY event for one identity decision (every decision, changed or not). Never throws. */
export async function recordIdentityDecision(d: IdentityDecisionInput): Promise<void> {
  await recordVerification([
    {
      entityType: "product",
      entityId: d.commerceProductId,
      kind: "IDENTITY",
      result: d.result,
      reason: d.reason,
      sourceUrl: d.sourceUrl ?? null,
      details: { basis: d.basis ?? null, productEntityId: d.productEntityId ?? null, nearEntityId: d.nearEntityId ?? null },
      checkedAt: d.at,
    },
  ]);
}

export type PriceSnapshot = { price: number | null; listPrice: number | null; currency: string | null };

/** Whether a stored price observation differs from the previous one (price, list price or currency). */
export function priceChanged(before: PriceSnapshot | null | undefined, after: PriceSnapshot): boolean {
  if (!before) return true;
  return (before.price ?? null) !== (after.price ?? null) || (before.listPrice ?? null) !== (after.listPrice ?? null) || (before.currency ?? null) !== (after.currency ?? null);
}

/**
 * PRICE event for a written offer, ONLY when it is new (CREATED) or its price / list price /
 * currency changed (CHANGED): unchanged re-observations are already in the raw records. Returns
 * whether an event was recorded. Never throws.
 */
export async function recordPriceChange(input: { offerId: string; before: PriceSnapshot | null | undefined; after: PriceSnapshot; sourceUrl?: string | null; at?: Date }): Promise<boolean> {
  if (!priceChanged(input.before, input.after)) return false;
  const b = input.before;
  const what = !b ? "first observation" : [b.price !== input.after.price && `price ${b.price ?? "none"} → ${input.after.price ?? "none"}`, (b.listPrice ?? null) !== (input.after.listPrice ?? null) && `list price ${b.listPrice ?? "none"} → ${input.after.listPrice ?? "none"}`, (b.currency ?? null) !== (input.after.currency ?? null) && `currency ${b.currency ?? "none"} → ${input.after.currency ?? "none"}`].filter(Boolean).join("; ");
  await recordVerification([
    {
      entityType: "offer",
      entityId: input.offerId,
      kind: "PRICE",
      result: b ? "CHANGED" : "CREATED",
      reason: what,
      sourceUrl: input.sourceUrl ?? null,
      details: { before: b ? { price: b.price ?? null, listPrice: b.listPrice ?? null, currency: b.currency ?? null } : null, after: { price: input.after.price ?? null, listPrice: input.after.listPrice ?? null, currency: input.after.currency ?? null } },
      checkedAt: input.at,
    },
  ]);
  return true;
}

/** PRICE event (REJECTED) for an offer the pipeline refused (not USD for a US brand, invalid price). Never throws. */
export async function recordPriceRejected(input: { commerceProductId: string; sourceUrl?: string | null; price: number | null; listPrice?: number | null; currency: string | null; reason: string; at?: Date }): Promise<void> {
  await recordVerification([
    {
      entityType: "product",
      entityId: input.commerceProductId,
      kind: "PRICE",
      result: "REJECTED",
      reason: input.reason,
      sourceUrl: input.sourceUrl ?? null,
      details: { price: input.price ?? null, listPrice: input.listPrice ?? null, currency: input.currency ?? null },
      checkedAt: input.at,
    },
  ]);
}

// ── Retention ───────────────────────────────────────────────────────────────

const PRUNE_CHUNK = 5000;
const PRUNE_MAX_ROUNDS = 200;

/**
 * Deletes verification events older than `olderThanDays` (default 90), except the latest event of
 * each (entityType, entityId, kind), which is kept regardless of age. Deletes nothing else (only
 * this table, only rows that have a newer event of the same entity and kind). Bounded chunks.
 */
export async function pruneVerificationEvents(olderThanDays = 90, now = new Date()): Promise<{ deleted: number; cutoff: string }> {
  const days = Number.isFinite(olderThanDays) && olderThanDays >= 1 ? Math.floor(olderThanDays) : 90;
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  let deleted = 0;
  for (let round = 0; round < PRUNE_MAX_ROUNDS; round++) {
    const n = await db.$executeRaw(Prisma.sql`
      DELETE FROM "commerce_verification_events" WHERE "id" IN (
        SELECT e."id" FROM "commerce_verification_events" e
        WHERE e."checkedAt" < ${cutoff}
          AND EXISTS (
            SELECT 1 FROM "commerce_verification_events" n
            WHERE n."entityType" = e."entityType" AND n."entityId" = e."entityId" AND n."kind" = e."kind"
              AND (n."checkedAt" > e."checkedAt" OR (n."checkedAt" = e."checkedAt" AND n."id" > e."id"))
          )
        LIMIT ${PRUNE_CHUNK}
      )`);
    deleted += n;
    if (n < PRUNE_CHUNK) break;
  }
  if (deleted) log.info("verification events pruned", { stage: "COMMERCE", deleted, days });
  return { deleted, cutoff: cutoff.toISOString() };
}
