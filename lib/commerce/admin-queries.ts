import type { Prisma } from "@prisma/client";
import { computeSaving, DEAL_REASON_LABEL, DEAL_STATUSES, type DealReasonCode, type DealStatus } from "./deal-status";
import { db } from "@/lib/db";

/**
 * Read-only queries behind Admin → Commerce (Sources, Products, Deals, Runs) and the admin JSON
 * API (/api/commerce/*). Every list is paginated and every per-row lookup is bounded to the rows
 * on the page. Nothing here computes a deal status: the persisted CommerceOffer.dealStatus is
 * shown as stored, and a row that was never classified says so.
 */

// ── Paging ───────────────────────────────────────────────────────────────────

export const MAX_PAGE_LIMIT = 100;

export type Paging = { page: number; limit: number; skip: number };

/** ?page (≥ 1) and ?limit (1–100, default `defaultLimit`). Garbage falls back to the defaults. */
export function parsePaging(get: (k: string) => string | null | undefined, defaultLimit = 25): Paging {
  const pageRaw = Number(get("page"));
  const limitRaw = Number(get("limit"));
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? Math.min(pageRaw, 100_000) : 1;
  const limit = Number.isInteger(limitRaw) && limitRaw >= 1 ? Math.min(limitRaw, MAX_PAGE_LIMIT) : Math.min(defaultLimit, MAX_PAGE_LIMIT);
  return { page, limit, skip: (page - 1) * limit };
}

export const pageCount = (total: number, limit: number) => Math.max(1, Math.ceil(total / Math.max(1, limit)));

/** A filter token from a query string: upper-case status/purpose words only (anything else is ignored). */
export function statusToken(v: string | null | undefined): string | undefined {
  const s = v?.trim().toUpperCase();
  return s && /^[A-Z][A-Z_-]{1,39}$/.test(s) ? s : undefined;
}

/** A brand slug from a query string (the API filters by slug, never by URL). */
export function slugToken(v: string | null | undefined): string | undefined {
  const s = v?.trim().toLowerCase();
  return s && /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(s) ? s : undefined;
}

// ── Runs ─────────────────────────────────────────────────────────────────────

export type RunErrorSummary = { count: number; codes: Array<{ code: string; count: number }>; sample: string | null };

/** CommerceRun.errors (an array of {code, reason|message, url?} as the jobs store it) → counts by code and one example. */
export function summarizeRunErrors(errors: unknown): RunErrorSummary {
  const list = Array.isArray(errors) ? errors : errors && typeof errors === "object" ? [errors] : [];
  const byCode = new Map<string, number>();
  let sample: string | null = null;
  for (const e of list) {
    const o = e && typeof e === "object" ? (e as Record<string, unknown>) : { reason: String(e) };
    const code = typeof o.code === "string" && o.code ? o.code : "ERROR";
    byCode.set(code, (byCode.get(code) ?? 0) + 1);
    if (!sample) {
      const text = [o.reason, o.message].find((x) => typeof x === "string" && x) as string | undefined;
      const url = typeof o.url === "string" ? o.url : null;
      sample = [code, text, url].filter(Boolean).join(": ").slice(0, 300) || null;
    }
  }
  return { count: list.length, codes: [...byCode.entries()].sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count })), sample };
}

export type RunFilter = { status?: string; purpose?: string; brandId?: string; brandSlug?: string };

export function runWhere(f: RunFilter): Prisma.CommerceRunWhereInput {
  return {
    ...(f.status ? { status: f.status } : {}),
    ...(f.purpose ? { purpose: f.purpose } : {}),
    ...(f.brandId ? { brandId: f.brandId } : {}),
    ...(f.brandSlug ? { brand: { slug: f.brandSlug } } : {}),
  };
}

export type RunFindings = { products: number; deals: number; coupons: number };

/**
 * What a run's raw records currently source, for the given runs only: products (distinct
 * CommerceProducts whose latest record, or one of whose offers, came from the run), deals (offers
 * from the run whose stated list price is above the price) and coupons. An offer or product that a
 * later run observed again is attributed to the later run (its provenance moved).
 */
export async function runFindings(runIds: string[]): Promise<Map<string, RunFindings>> {
  const out = new Map<string, RunFindings>();
  const ids = [...new Set(runIds)].slice(0, MAX_PAGE_LIMIT);
  if (!ids.length) return out;
  const [products, deals, coupons] = await Promise.all([
    db.$queryRaw<Array<{ runId: string; n: number }>>`
      SELECT x."runId", COUNT(DISTINCT x.pid)::int AS n FROM (
        SELECT rr."runId", p.id AS pid FROM "commerce_raw_records" rr JOIN "commerce_products" p ON p."lastRawId" = rr.id WHERE rr."runId" = ANY(${ids})
        UNION
        SELECT rr."runId", o."productId" AS pid FROM "commerce_raw_records" rr JOIN "commerce_offers" o ON o."sourceRawId" = rr.id WHERE rr."runId" = ANY(${ids})
      ) x GROUP BY x."runId"`,
    db.$queryRaw<Array<{ runId: string; n: number }>>`
      SELECT rr."runId", COUNT(o.id)::int AS n FROM "commerce_raw_records" rr JOIN "commerce_offers" o ON o."sourceRawId" = rr.id
      WHERE rr."runId" = ANY(${ids}) AND o."listPrice" IS NOT NULL AND o.price IS NOT NULL AND o."listPrice" > o.price GROUP BY rr."runId"`,
    db.$queryRaw<Array<{ runId: string; n: number }>>`
      SELECT rr."runId", COUNT(c.id)::int AS n FROM "commerce_raw_records" rr JOIN "commerce_coupons" c ON c."sourceRawId" = rr.id WHERE rr."runId" = ANY(${ids}) GROUP BY rr."runId"`,
  ]);
  for (const id of ids) out.set(id, { products: 0, deals: 0, coupons: 0 });
  for (const r of products) out.get(r.runId)!.products = Number(r.n);
  for (const r of deals) out.get(r.runId)!.deals = Number(r.n);
  for (const r of coupons) out.get(r.runId)!.coupons = Number(r.n);
  return out;
}

export type RunRow = {
  id: string;
  purpose: string;
  brand: { slug: string; name: string } | null;
  source: { slug: string; name: string } | null;
  actorId: string;
  apifyRunId: string | null;
  trigger: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  collectedAt: Date | null;
  durationMs: number | null;
  startUrls: number;
  pagesProcessed: number | null;
  extracted: number | null;
  accepted: number | null;
  rejected: number | null;
  found: RunFindings;
  errors: RunErrorSummary;
  computeUnits: number | null;
  usageUsd: number | null;
};

export async function listRuns(f: RunFilter, paging: Paging): Promise<{ total: number; items: RunRow[] }> {
  const where = runWhere(f);
  const [total, rows] = await Promise.all([
    db.commerceRun.count({ where }),
    db.commerceRun.findMany({
      where,
      orderBy: { startedAt: "desc" },
      skip: paging.skip,
      take: paging.limit,
      include: { brand: { select: { slug: true, name: true } }, source: { select: { slug: true, name: true } } },
    }),
  ]);
  const found = await runFindings(rows.map((r) => r.id));
  return {
    total,
    items: rows.map((r) => ({
      id: r.id,
      purpose: r.purpose,
      brand: r.brand,
      source: r.source,
      actorId: r.actorId,
      apifyRunId: r.apifyRunId,
      trigger: r.trigger,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      collectedAt: r.collectedAt,
      durationMs: r.finishedAt ? Math.max(0, r.finishedAt.getTime() - r.startedAt.getTime()) : null,
      startUrls: r.startUrls,
      pagesProcessed: r.pagesProcessed,
      extracted: r.extracted,
      accepted: r.accepted,
      rejected: r.rejected,
      found: found.get(r.id) ?? { products: 0, deals: 0, coupons: 0 },
      errors: summarizeRunErrors(r.errors),
      computeUnits: r.computeUnits,
      usageUsd: r.usageUsd,
    })),
  };
}

/** "1 h 4 min", "3 min 12 s", "40 s". */
export function durationLabel(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

// ── Deal status (persisted) ──────────────────────────────────────────────────

export const UNCLASSIFIED = "UNCLASSIFIED";
export const NOT_CLASSIFIED_LABEL = "Not classified yet";

export const isDealStatus = (v: string | null | undefined): v is DealStatus => !!v && (DEAL_STATUSES as readonly string[]).includes(v);
export const isDealReason = (v: string | null | undefined): v is DealReasonCode => !!v && Object.prototype.hasOwnProperty.call(DEAL_REASON_LABEL, v);

export type StoredReason = { code: string; label: string; message: string | null };

/**
 * CommerceOffer.dealStatusReasons as stored by the classifier: an array of {code, message} (or of
 * codes), or an object carrying such an array in `reasons`. Unknown codes are shown as stored.
 */
export function parseDealReasons(json: unknown): { reasons: StoredReason[]; listPriceLabel: string | null } {
  const obj = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
  const list = Array.isArray(json) ? json : obj && Array.isArray(obj.reasons) ? obj.reasons : [];
  const reasons: StoredReason[] = [];
  for (const r of list.slice(0, 30)) {
    const code = typeof r === "string" ? r : r && typeof r === "object" && typeof (r as { code?: unknown }).code === "string" ? (r as { code: string }).code : null;
    if (!code) continue;
    const message = r && typeof r === "object" && typeof (r as { message?: unknown }).message === "string" ? (r as { message: string }).message.slice(0, 300) : null;
    reasons.push({ code, label: isDealReason(code) ? DEAL_REASON_LABEL[code] : code, message });
  }
  return { reasons, listPriceLabel: obj && typeof obj.listPriceLabel === "string" ? obj.listPriceLabel.slice(0, 40) : null };
}

/**
 * How the page labelled the previous price, read from the product's stored page data (the same
 * convention as lib/commerce/deal-status.ts): "Regular price" (ListPrice), "Was"
 * (StrikethroughPrice), else "List price".
 */
export function listPriceLabelFor(data: unknown, offer: { price: number | null; listPrice: number | null }): string {
  const d = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  const offers = d && Array.isArray(d.offers) ? (d.offers as unknown[]).filter((o): o is Record<string, unknown> => !!o && typeof o === "object") : [];
  const same = offers.filter((o) => o.price === offer.price && (o.listPrice ?? null) === (offer.listPrice ?? null));
  const type = same.length === 1 ? same[0].listPriceType : same.find((o) => typeof o.listPriceType === "string")?.listPriceType;
  return type === "StrikethroughPrice" ? "Was" : type === "ListPrice" ? "Regular price" : "List price";
}

/** Persisted deal-status counts (null = never classified). */
export async function persistedDealStatusCounts(where: Prisma.CommerceOfferWhereInput = {}): Promise<Record<string, number>> {
  const rows = await db.commerceOffer.groupBy({ by: ["dealStatus"], where, _count: { _all: true } });
  const out: Record<string, number> = Object.fromEntries([...DEAL_STATUSES, UNCLASSIFIED].map((s) => [s, 0]));
  for (const r of rows) out[r.dealStatus ?? UNCLASSIFIED] = (out[r.dealStatus ?? UNCLASSIFIED] ?? 0) + r._count._all;
  return out;
}

export type DealFilter = { status?: string; brandId?: string; brandSlug?: string; reason?: string };

export function dealWhere(f: DealFilter): Prisma.CommerceOfferWhereInput {
  const and: Prisma.CommerceOfferWhereInput[] = [];
  if (f.status === UNCLASSIFIED) and.push({ dealStatus: null });
  else if (isDealStatus(f.status)) and.push({ dealStatus: f.status });
  if (f.brandId) and.push({ product: { brandId: f.brandId } });
  if (f.brandSlug) and.push({ product: { brand: { slug: f.brandSlug } } });
  if (isDealReason(f.reason)) {
    const code = f.reason;
    and.push({
      OR: [
        { dealStatusReasons: { array_contains: [{ code }] } },
        { dealStatusReasons: { array_contains: [code] } },
        { dealStatusReasons: { path: ["reasons"], array_contains: [{ code }] } },
      ],
    });
  }
  return and.length ? { AND: and } : {};
}

export type VerificationEventRow = { kind: string; result: string; reason: string | null; checkedAt: Date };

/** The latest `perEntity` verification events of each entity (read-only; bounded to the given ids). */
export async function latestVerificationEvents(entityType: string, ids: string[], perEntity = 3): Promise<Map<string, VerificationEventRow[]>> {
  const out = new Map<string, VerificationEventRow[]>();
  const list = [...new Set(ids)].slice(0, MAX_PAGE_LIMIT);
  if (!list.length) return out;
  const rows = await db.$queryRaw<Array<{ entityId: string; kind: string; result: string; reason: string | null; checkedAt: Date }>>`
    SELECT "entityId", kind, result, reason, "checkedAt" FROM (
      SELECT "entityId", kind, result, reason, "checkedAt", ROW_NUMBER() OVER (PARTITION BY "entityId" ORDER BY "checkedAt" DESC, id DESC) AS rn
      FROM "commerce_verification_events" WHERE "entityType" = ${entityType} AND "entityId" = ANY(${list})
    ) e WHERE e.rn <= ${Math.max(1, Math.min(10, perEntity))} ORDER BY "entityId", "checkedAt" DESC`;
  for (const r of rows) {
    const arr = out.get(r.entityId) ?? [];
    arr.push({ kind: r.kind, result: r.result, reason: r.reason ? r.reason.slice(0, 200) : null, checkedAt: r.checkedAt });
    out.set(r.entityId, arr);
  }
  return out;
}

export type DealRow = {
  id: string;
  product: { id: string; name: string; productEntityId: string | null };
  brand: { id: string; slug: string; name: string } | null;
  seller: string;
  sellerType: string;
  destinationUrl: string;
  price: number | null;
  listPrice: number | null;
  listPriceLabel: string | null;
  currency: string | null;
  saving: { amount: number; percent: number } | null;
  availability: string | null;
  linkStatus: string;
  linkCheckedAt: Date | null;
  officialStatus: string | null;
  observedAt: Date;
  /** Persisted; null = never classified ("Not classified yet"). */
  dealStatus: string | null;
  dealStatusAt: Date | null;
  reasons: StoredReason[];
  events: VerificationEventRow[];
};

export async function listDeals(f: DealFilter, paging: Paging): Promise<{ total: number; items: DealRow[] }> {
  const where = dealWhere(f);
  const [total, rows] = await Promise.all([
    db.commerceOffer.count({ where }),
    db.commerceOffer.findMany({
      where,
      orderBy: [{ dealStatusAt: { sort: "desc", nulls: "last" } }, { observedAt: "desc" }],
      skip: paging.skip,
      take: paging.limit,
      select: {
        id: true,
        seller: true,
        sellerType: true,
        destinationUrl: true,
        price: true,
        listPrice: true,
        currency: true,
        availability: true,
        linkStatus: true,
        linkCheckedAt: true,
        observedAt: true,
        dealStatus: true,
        dealStatusReasons: true,
        dealStatusAt: true,
        product: { select: { id: true, name: true, productEntityId: true, data: true, brand: { select: { id: true, slug: true, name: true } } } },
      },
    }),
  ]);
  const entityIds = [...new Set(rows.map((r) => r.product.productEntityId).filter((x): x is string => Boolean(x)))];
  const [entities, events] = await Promise.all([
    entityIds.length ? db.productEntity.findMany({ where: { id: { in: entityIds } }, select: { id: true, officialStatus: true } }) : Promise.resolve([]),
    latestVerificationEvents("offer", rows.map((r) => r.id)),
  ]);
  const official = new Map(entities.map((e) => [e.id, e.officialStatus]));
  return {
    total,
    items: rows.map((r) => {
      const parsed = parseDealReasons(r.dealStatusReasons);
      return {
        id: r.id,
        product: { id: r.product.id, name: r.product.name, productEntityId: r.product.productEntityId },
        brand: r.product.brand,
        seller: r.seller,
        sellerType: r.sellerType,
        destinationUrl: r.destinationUrl,
        price: r.price,
        listPrice: r.listPrice,
        listPriceLabel: r.listPrice != null ? (parsed.listPriceLabel ?? listPriceLabelFor(r.product.data, r)) : null,
        currency: r.currency,
        saving: computeSaving(r.price, r.listPrice),
        availability: r.availability,
        linkStatus: r.linkStatus,
        linkCheckedAt: r.linkCheckedAt,
        officialStatus: r.product.productEntityId ? (official.get(r.product.productEntityId) ?? null) : null,
        observedAt: r.observedAt,
        dealStatus: r.dealStatus,
        dealStatusAt: r.dealStatusAt,
        reasons: parsed.reasons,
        events: events.get(r.id) ?? [],
      };
    }),
  };
}

// ── Products and coupons (admin API) ─────────────────────────────────────────

export type ProductFilter = { status?: string; brandSlug?: string; brandId?: string };

export async function listCommerceProducts(f: ProductFilter, paging: Paging) {
  const where: Prisma.CommerceProductWhereInput = {
    ...(f.status ? { identityStatus: f.status } : {}),
    ...(f.brandId ? { brandId: f.brandId } : {}),
    ...(f.brandSlug ? { brand: { slug: f.brandSlug } } : {}),
  };
  const [total, rows] = await Promise.all([
    db.commerceProduct.count({ where }),
    db.commerceProduct.findMany({
      where,
      orderBy: { observedAt: "desc" },
      skip: paging.skip,
      take: paging.limit,
      select: {
        id: true,
        name: true,
        canonicalUrl: true,
        model: true,
        mpn: true,
        sku: true,
        gtin: true,
        category: true,
        identityStatus: true,
        identityReason: true,
        productEntityId: true,
        observedAt: true,
        data: true,
        brand: { select: { slug: true, name: true } },
        _count: { select: { offers: true } },
        offers: {
          orderBy: [{ status: "asc" }, { price: { sort: "asc", nulls: "last" } }, { observedAt: "desc" }],
          take: 1,
          select: { id: true, seller: true, sellerType: true, price: true, listPrice: true, currency: true, status: true, observedAt: true, linkStatus: true, linkCheckedAt: true, dealStatus: true, dealStatusAt: true },
        },
      },
    }),
  ]);
  const entityIds = [...new Set(rows.map((r) => r.productEntityId).filter((x): x is string => Boolean(x)))];
  const entities = entityIds.length ? await db.productEntity.findMany({ where: { id: { in: entityIds } }, select: { id: true, officialStatus: true } }) : [];
  const official = new Map(entities.map((e) => [e.id, e.officialStatus]));
  return {
    total,
    items: rows.map(({ data, offers, _count, ...p }) => {
      const o = offers[0];
      return {
        ...p,
        officialStatus: p.productEntityId ? (official.get(p.productEntityId) ?? null) : null,
        offerCount: _count.offers,
        bestOffer: o ? { ...o, listPriceLabel: o.listPrice != null ? listPriceLabelFor(data, o) : null } : null,
      };
    }),
  };
}

export type CouponFilter = { status?: string; brandSlug?: string };

export async function listCommerceCoupons(f: CouponFilter, paging: Paging) {
  const where: Prisma.CommerceCouponWhereInput = { ...(f.status ? { status: f.status } : {}), ...(f.brandSlug ? { brand: { slug: f.brandSlug } } : {}) };
  const [total, items] = await Promise.all([
    db.commerceCoupon.count({ where }),
    db.commerceCoupon.findMany({
      where,
      orderBy: { observedAt: "desc" },
      skip: paging.skip,
      take: paging.limit,
      select: {
        id: true,
        merchant: true,
        code: true,
        title: true,
        discount: true,
        discountType: true,
        eligibility: true,
        restrictions: true,
        startsAt: true,
        expiresAt: true,
        status: true,
        sourceUrl: true,
        firstSeenAt: true,
        observedAt: true,
        lastVerifiedAt: true,
        brand: { select: { slug: true, name: true } },
      },
    }),
  ]);
  return { total, items };
}

export async function couponStatusCounts(): Promise<Array<{ status: string; count: number }>> {
  const rows = await db.commerceCoupon.groupBy({ by: ["status"], _count: { _all: true } });
  return rows.map((r) => ({ status: r.status, count: r._count._all })).sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
}

// ── Source registry (per-brand health) ───────────────────────────────────────

export type BrandRegistryStats = {
  runs: number;
  extracted: number;
  accepted: number;
  rejected: number;
  products: number;
  /** ProductEntity.officialStatus of the Made4Buyers products this brand's commerce products are attached to (null → "NOT_CHECKED"). */
  official: Record<string, number>;
  lastRun: { status: string; startedAt: Date } | null;
};

/** Per-brand numbers for the registry: run totals, product counts and official-verification counts. Three grouped queries for all brands. */
export async function brandRegistryStats(): Promise<Map<string, BrandRegistryStats>> {
  const [runs, products, official, lastRuns] = await Promise.all([
    db.commerceRun.groupBy({ by: ["brandId"], where: { brandId: { not: null } }, _sum: { extracted: true, accepted: true, rejected: true }, _count: { _all: true } }),
    db.commerceProduct.groupBy({ by: ["brandId"], where: { brandId: { not: null } }, _count: { _all: true } }),
    db.$queryRaw<Array<{ brandId: string; status: string | null; n: number }>>`
      SELECT cp."brandId", pe."officialStatus" AS status, COUNT(DISTINCT pe.id)::int AS n
      FROM "commerce_products" cp JOIN "product_entities" pe ON pe.id = cp."productEntityId"
      WHERE cp."brandId" IS NOT NULL GROUP BY cp."brandId", pe."officialStatus"`,
    db.$queryRaw<Array<{ brandId: string; status: string; startedAt: Date }>>`
      SELECT DISTINCT ON ("brandId") "brandId", status, "startedAt" FROM "commerce_runs" WHERE "brandId" IS NOT NULL ORDER BY "brandId", "startedAt" DESC`,
  ]);
  const out = new Map<string, BrandRegistryStats>();
  const get = (id: string) => {
    let s = out.get(id);
    if (!s) out.set(id, (s = { runs: 0, extracted: 0, accepted: 0, rejected: 0, products: 0, official: {}, lastRun: null }));
    return s;
  };
  for (const r of runs) Object.assign(get(r.brandId!), { runs: r._count._all, extracted: r._sum.extracted ?? 0, accepted: r._sum.accepted ?? 0, rejected: r._sum.rejected ?? 0 });
  for (const p of products) get(p.brandId!).products = p._count._all;
  for (const o of official) {
    const s = get(o.brandId);
    const k = o.status ?? "NOT_CHECKED";
    s.official[k] = (s.official[k] ?? 0) + Number(o.n);
  }
  for (const l of lastRuns) get(l.brandId).lastRun = { status: l.status, startedAt: l.startedAt };
  return out;
}

export const runPurposeOptions = ["PRODUCT", "COUPON", "DEAL"] as const;

/** Distinct run statuses actually stored (for the filter), most common first. */
export async function runStatusOptions(): Promise<string[]> {
  const rows = await db.commerceRun.groupBy({ by: ["status"], _count: { _all: true } });
  return rows.sort((a, b) => b._count._all - a._count._all).map((r) => r.status);
}

