import type { ProductFact } from "@prisma/client";
import { db } from "@/lib/db";
import { volatility } from "./facts";
import type { FactField } from "./types";

/** Offer link states that mean the seller's page is gone (kept in sync with lib/commerce/link-check.ts). */
export const DEAD_LINK_STATUSES = ["BROKEN", "OFF_SITE", "UNREACHABLE"] as const;

/**
 * The stored facts a product summary may be built from. Volatile facts (price, availability …)
 * whose source page the link check found gone are left out: a price from a page that no longer
 * exists is not a current price. Nothing is deleted; the facts return if the page comes back.
 */
export async function loadSummaryFacts(entityId: string): Promise<ProductFact[]> {
  const [rows, dead] = await Promise.all([
    db.productFact.findMany({ where: { productEntityId: entityId } }),
    db.commerceOffer.findMany({ where: { linkStatus: { in: [...DEAD_LINK_STATUSES] }, product: { productEntityId: entityId } }, select: { destinationUrl: true } }),
  ]);
  if (!dead.length) return rows;
  const gone = new Set(dead.map((d) => d.destinationUrl));
  return rows.filter((r) => !(volatility(r.field as FactField) === "HIGH" && ((r.sourceUrl && gone.has(r.sourceUrl)) || gone.has(r.sourceKey))));
}
