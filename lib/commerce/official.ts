import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { brandKey } from "@/lib/products/page-extract";
import { commerceAudit } from "./audit";
import { onDomain } from "./urls";

/**
 * Official-source verification (job "commerce-official-verify"; also run inline by commerce-collect
 * for the products it touched). Per ProductEntity:
 *
 *   VERIFIED   a MATCHED CommerceProduct (identity already exact-matched) whose canonicalUrl is on the
 *              brand's officialDomain, and whose page is not known to be gone (offer link BROKEN/OFF_SITE)
 *              → officialUrl = that URL, officialVerifiedAt = its observedAt
 *   MISMATCH   otherwise, when the latest official-domain match decision naming this product was
 *              MATCH_REJECTED because of a variant / identity difference
 *   NOT_FOUND  otherwise, when the brand was crawled successfully in the last 30 days and no official
 *              page matched this product in that time
 *   null       not checked (no crawled brand)
 * Never VERIFIED without an official-domain exact match. Only status changes are written (and audited).
 */

export type OfficialStatus = "VERIFIED" | "MISMATCH" | "NOT_FOUND";
const WINDOW_MS = 30 * 86_400_000;
const GONE = ["BROKEN", "OFF_SITE"];

type EntityRow = { id: string; brand: string | null; officialStatus: string | null; officialUrl: string | null; officialVerifiedAt: Date | null };
export type OfficialDecision = { status: OfficialStatus | null; url: string | null; verifiedAt: Date | null; reason: string };

/** Brands with a collected product run in the last 30 days. */
async function crawledBrandIds(since: Date): Promise<Set<string | null>> {
  const collected = await db.commerceRun.findMany({ where: { purpose: "PRODUCT", status: "COLLECTED", collectedAt: { gte: since } }, select: { brandId: true }, distinct: ["brandId"] });
  return new Set(collected.map((r) => r.brandId));
}

/** Decides the official status of the given entities (or every entity with commerce data when `ids` is omitted). */
export async function decideOfficial(ids: string[] | undefined, now = new Date()): Promise<Map<string, OfficialDecision & { entity: EntityRow }>> {
  const since = new Date(now.getTime() - WINDOW_MS);
  const allBrands = await db.commerceBrand.findMany({ select: { id: true, name: true, officialDomain: true } });
  const brandById = new Map(allBrands.map((b) => [b.id, b]));
  const crawledIds = await crawledBrandIds(since);
  const crawledKeys = new Set(allBrands.filter((b) => crawledIds.has(b.id)).map((b) => brandKey(b.name)));

  // Entities in scope: named ones, or every entity with commerce data / of a commerce brand / already labelled.
  let entities: EntityRow[];
  const select = { id: true, brand: true, officialStatus: true, officialUrl: true, officialVerifiedAt: true } as const;
  if (ids) entities = ids.length ? await db.productEntity.findMany({ where: { id: { in: [...new Set(ids)] } }, select }) : [];
  else {
    const attached = await db.commerceProduct.findMany({ where: { productEntityId: { not: null } }, select: { productEntityId: true }, distinct: ["productEntityId"] });
    const logged = await db.commerceMatchLog.findMany({ where: { productEntityId: { not: null } }, select: { productEntityId: true }, distinct: ["productEntityId"] });
    const idSet = new Set([...attached, ...logged].map((r) => r.productEntityId!));
    const candidates = await db.productEntity.findMany({ where: { OR: [{ id: { in: [...idSet] } }, { officialStatus: { not: null } }, { brand: { not: null } }] }, select });
    const brandKeys = new Set(allBrands.map((b) => brandKey(b.name)));
    entities = candidates.filter((e) => idSet.has(e.id) || e.officialStatus != null || (e.brand && brandKeys.has(brandKey(e.brand))));
  }
  const entityIds = entities.map((e) => e.id);
  const out = new Map<string, OfficialDecision & { entity: EntityRow }>();
  if (!entityIds.length) return out;

  // VERIFIED evidence: exact-matched products on their brand's official domain.
  const matched = await db.commerceProduct.findMany({
    where: { productEntityId: { in: entityIds }, identityStatus: "MATCHED" },
    select: { id: true, productEntityId: true, canonicalUrl: true, observedAt: true, brandId: true, offers: { select: { destinationUrl: true, linkStatus: true } } },
    orderBy: { observedAt: "desc" },
  });
  const official = matched.filter((p) => {
    const b = p.brandId ? brandById.get(p.brandId) : undefined;
    if (!b || !onDomain(p.canonicalUrl, b.officialDomain)) return false;
    const own = p.offers.filter((o) => o.destinationUrl === p.canonicalUrl);
    const all = own.length ? own : p.offers;
    return !(all.length && all.every((o) => GONE.includes(o.linkStatus)));
  });

  // MISMATCH evidence: latest decision naming the entity for an official-domain page.
  const logs = await db.commerceMatchLog.findMany({ where: { productEntityId: { in: entityIds } }, orderBy: { createdAt: "desc" }, select: { productEntityId: true, commerceProductId: true, result: true, reason: true, createdAt: true } });
  const logProducts = await db.commerceProduct.findMany({ where: { id: { in: [...new Set(logs.map((l) => l.commerceProductId))] } }, select: { id: true, canonicalUrl: true, brandId: true } });
  const productById = new Map(logProducts.map((p) => [p.id, p]));
  const officialLog = (l: (typeof logs)[number]) => {
    const p = productById.get(l.commerceProductId);
    const b = p?.brandId ? brandById.get(p.brandId) : undefined;
    return !!p && !!b && onDomain(p.canonicalUrl, b.officialDomain);
  };

  for (const e of entities) {
    const v = official.find((p) => p.productEntityId === e.id);
    if (v) {
      out.set(e.id, { entity: e, status: "VERIFIED", url: v.canonicalUrl, verifiedAt: v.observedAt, reason: `exact match on the official site (${v.canonicalUrl})` });
      continue;
    }
    const last = logs.find((l) => l.productEntityId === e.id && officialLog(l));
    // decideIdentity names a product on a rejection only for a variant/identity difference (near miss).
    if (last && last.result === "MATCH_REJECTED") {
      out.set(e.id, { entity: e, status: "MISMATCH", url: null, verifiedAt: null, reason: `official page ${productById.get(last.commerceProductId)?.canonicalUrl} is a different variant: ${last.reason.slice(0, 200)}` });
      continue;
    }
    const k = e.brand ? brandKey(e.brand) : "";
    if (k && crawledKeys.has(k)) {
      const recentMatch = logs.some((l) => l.productEntityId === e.id && l.result === "MATCHED" && l.createdAt >= since && officialLog(l));
      if (!recentMatch) {
        out.set(e.id, { entity: e, status: "NOT_FOUND", url: null, verifiedAt: null, reason: `${e.brand} official site crawled in the last 30 days; no page matched this product` });
        continue;
      }
    }
    out.set(e.id, { entity: e, status: null, url: null, verifiedAt: null, reason: "brand not crawled" });
  }
  return out;
}

/** Applies decisions; writes and audits only status changes (and refreshes URL/date on VERIFIED). */
export async function verifyOfficial(ids?: string[], now = new Date()) {
  const decisions = await decideOfficial(ids, now);
  const counts: Record<string, number> = { VERIFIED: 0, MISMATCH: 0, NOT_FOUND: 0, NONE: 0 };
  let changed = 0;
  for (const [id, d] of decisions) {
    counts[d.status ?? "NONE"]++;
    const e = d.entity;
    const same = e.officialStatus === d.status && e.officialUrl === d.url && (e.officialVerifiedAt?.getTime() ?? null) === (d.verifiedAt?.getTime() ?? null);
    if (same) continue;
    await db.productEntity.update({ where: { id }, data: { officialStatus: d.status, officialUrl: d.url, officialVerifiedAt: d.verifiedAt } });
    if (e.officialStatus !== d.status) {
      changed++;
      await commerceAudit("OFFICIAL_VERIFICATION", "product_entity", id, { before: { officialStatus: e.officialStatus }, after: { officialStatus: d.status }, metadata: { url: d.url, reason: d.reason } });
    }
  }
  return { checked: decisions.size, changed, ...counts };
}

/** Job "commerce-official-verify". Idempotent; run under a job lock. */
export async function runOfficialVerify(trigger: string, now = new Date()) {
  const r = await verifyOfficial(undefined, now);
  log.info("commerce official verification", { stage: "COMMERCE", trigger, ...r });
  return { status: "OK", trigger, ...r };
}
