import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { audit, SYSTEM_ACTOR } from "@/lib/security/audit";

/**
 * Audit events for automated commerce mutations (actor "system"). One event per real change:
 * callers emit only when a stored value actually changed. An audit write never fails the job.
 */

export type CommerceAuditAction =
  | "PRICE_UPDATED"
  | "PRICE_REJECTED"
  | "PRODUCT_CREATED"
  | "PRODUCT_UPDATED"
  | "SOURCE_CONFLICT"
  | "COUPON_CREATED"
  | "COUPON_EXPIRED"
  | "COUPON_INVALIDATED"
  | "LINK_VALIDATED"
  | "LINK_REJECTED"
  | "OFFICIAL_VERIFICATION"
  | "DEAL_ACTIVATED"
  | "DEAL_DEACTIVATED"
  | "APIFY_RUN_COMPLETED"
  | "APIFY_RUN_FAILED";

export type CommerceEntityType = "commerce_product" | "commerce_offer" | "commerce_coupon" | "commerce_run" | "product_entity";

type Entry = { before?: unknown; after?: unknown; metadata?: Record<string, unknown> };

const short = (v: unknown) => (typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}…` : v);

function small(m: Record<string, unknown> | undefined) {
  if (!m) return undefined;
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined).map(([k, v]) => [k, short(v)]));
}

export async function commerceAudit(action: CommerceAuditAction, entityType: CommerceEntityType, entityId: string, entry: Entry = {}): Promise<void> {
  try {
    await audit(SYSTEM_ACTOR, { action, entityType, entityId, before: entry.before, after: entry.after, metadata: small(entry.metadata) });
  } catch (error) {
    log.warn("commerce audit write failed", { stage: "COMMERCE", action, entityType, entityId, error: String(error).slice(0, 200) });
  }
}

/**
 * Emits `action` unless the latest event of that action for this entity already carries the same
 * `key` (a repeated observation of the same rejected value is not a new change).
 */
export async function commerceAuditOnce(action: CommerceAuditAction, entityType: CommerceEntityType, entityId: string, key: string, entry: Entry = {}): Promise<boolean> {
  try {
    const last = await db.auditLog.findFirst({ where: { action, entityType, entityId }, orderBy: { createdAt: "desc" }, select: { metadata: true } });
    if (last && (last.metadata as { key?: unknown } | null)?.key === key) return false;
  } catch {
    /* fall through: better a duplicate event than a lost one */
  }
  await commerceAudit(action, entityType, entityId, { ...entry, metadata: { ...entry.metadata, key } });
  return true;
}
