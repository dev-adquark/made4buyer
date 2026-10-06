import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { couponMaxAgeDays } from "@/lib/commerce/coupons";
import { normalizeDestinationUrl } from "@/lib/commerce/urls";
import { maxAgeMs } from "@/lib/products/facts";
import { audit, SYSTEM_ACTOR, type AuditContext } from "@/lib/security/audit";

/**
 * Data-integrity audit of published content and commerce data. Every check is a query against
 * stored data. The only writes are two safe, audited status corrections:
 *   - FRESH offers older than PRODUCT_PRICE_MAX_AGE_HOURS (default 48 h) → STALE
 *   - VERIFIED coupons whose stated expiry has passed → EXPIRED
 * Nothing is ever deleted, no article is rewritten and no value is filled in.
 */

export type AuditCategory = "UNVERIFIED" | "STALE" | "CONFLICTING" | "DUPLICATE" | "BROKEN" | "MISSING_SOURCE";

export type AuditRow = { id: string; title: string; detail: string; href?: string; at?: Date | null };

type Ctx = { now: Date };

type Check = {
  key: string;
  category: AuditCategory;
  label: string;
  rule: string;
  /** Count of flagged items (rows or duplicate groups). */
  count: (c: Ctx) => Promise<number>;
  /** One page of flagged items (1-based page). */
  list: (c: Ctx, page: number, pageSize: number) => Promise<AuditRow[]>;
  /** What a count means, e.g. "duplicate groups". */
  unit: string;
  safeFix?: string;
};

const MAX_SCAN = 20_000;
const LIVE_COUPON_STATUSES = ["VERIFIED", "UNVERIFIED", "CONFLICTING", "UNKNOWN"];

const publicProduct: Prisma.ProductEntityWhereInput = { content: { some: { review: { status: "PUBLISHED" } } } };

function staleOfferWhere(c: Ctx): Prisma.CommerceOfferWhereInput {
  return { status: "FRESH", observedAt: { lt: new Date(c.now.getTime() - maxAgeMs("HIGH")) } };
}
function expiredCouponWhere(c: Ctx): Prisma.CommerceCouponWhereInput {
  return { status: "VERIFIED", expiresAt: { lt: c.now } };
}
function unseenCouponWhere(c: Ctx): Prisma.CommerceCouponWhereInput {
  const since = new Date(c.now.getTime() - couponMaxAgeDays() * 86_400_000);
  return { status: "VERIFIED", OR: [{ lastVerifiedAt: null }, { lastVerifiedAt: { lt: since } }], AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gte: c.now } }] }] };
}
const brokenOfferWhere: Prisma.CommerceOfferWhereInput = { linkStatus: { in: ["BROKEN", "OFF_SITE", "UNREACHABLE"] } };
const missingHeroWhere: Prisma.NormalizedReviewWhereInput = {
  status: "PUBLISHED",
  OR: [
    { images: { none: { isPrimary: true } } },
    { images: { some: { isPrimary: true, OR: [{ enrichmentStatus: "FAILED" }, { sourceType: { not: "PLACEHOLDER" }, sourceUrl: null, cdnUrl: null }] } } },
  ],
};
const imageNoSourceWhere: Prisma.ImageAssetWhereInput = {
  isPrimary: true,
  review: { status: "PUBLISHED" },
  sourceType: { not: "PLACEHOLDER" },
  licenseState: { not: "OWNED_PLACEHOLDER" },
  OR: [{ licenseState: "UNVERIFIED" }, { license: null }, { sourcePageUrl: null, attributionUrl: null }],
};

const productHref = (id: string) => `/admin/products?id=${encodeURIComponent(id)}`;
const reviewHref = (id: string) => `/admin/reviews/${encodeURIComponent(id)}`;
const commerceProductHref = (id: string) => `/admin/commerce/products?id=${encodeURIComponent(id)}`;
const couponsHref = "/admin/commerce/coupons";
const skip = (page: number, size: number) => (Math.max(1, page) - 1) * size;

function factRow(f: { id: string; field: string; source: string; sourceName: string; observedAt: Date; entity: { id: string; name: string } }): AuditRow {
  return { id: f.id, title: `${f.entity.name} · ${f.field}`, detail: `${f.sourceName} (${f.source}); no source URL stored`, href: productHref(f.entity.id), at: f.observedAt };
}
const factSelect = { id: true, field: true, source: true, sourceName: true, observedAt: true, entity: { select: { id: true, name: true } } } as const;

function offerRow(o: { id: string; seller: string; price: number | null; currency: string | null; destinationUrl: string; status: string; linkStatus: string; observedAt: Date; product: { id: string; name: string } }, extra: string): AuditRow {
  return { id: o.id, title: `${o.product.name} · ${o.seller}`, detail: `${o.price ?? "no price"} ${o.currency ?? ""} · ${o.destinationUrl} · ${extra}`.replace(/\s+/g, " "), href: commerceProductHref(o.product.id), at: o.observedAt };
}
const offerSelect = { id: true, seller: true, price: true, currency: true, destinationUrl: true, status: true, linkStatus: true, observedAt: true, product: { select: { id: true, name: true } } } as const;

function couponRow(c: { id: string; merchant: string; code: string; status: string; expiresAt: Date | null; lastVerifiedAt: Date | null; sourceUrl: string }, extra: string): AuditRow {
  return { id: c.id, title: `${c.merchant} · ${c.code}`, detail: `${c.status} · ${extra} · ${c.sourceUrl}`, href: couponsHref, at: c.lastVerifiedAt };
}
const couponSelect = { id: true, merchant: true, code: true, status: true, expiresAt: true, lastVerifiedAt: true, sourceUrl: true } as const;

// ── Group-based checks (duplicates, JSON) — computed in full, then paged ─────

type Group = { key: string; rows: AuditRow[] };

function pageOf<T>(items: T[], page: number, size: number): T[] {
  const s = skip(page, size);
  return items.slice(s, s + size);
}

function groupsToRows(groups: Group[]): AuditRow[] {
  return groups.map((g) => ({ id: g.key, title: `${g.rows.length} × ${g.rows[0]?.title ?? g.key}`, detail: g.rows.map((r) => `${r.detail} [${r.id}]`).join(" | "), href: g.rows[0]?.href }));
}

async function duplicateOfferGroups(): Promise<Group[]> {
  const offers = await db.commerceOffer.findMany({ select: offerSelect, orderBy: { id: "asc" }, take: MAX_SCAN });
  const groups = new Map<string, typeof offers>();
  for (const o of offers) {
    const key = [o.product.id, o.seller.trim().toLowerCase(), (o.currency ?? "").toUpperCase(), o.price ?? "", normalizeDestinationUrl(o.destinationUrl) ?? o.destinationUrl].join("|");
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  return [...groups.entries()].filter(([, v]) => v.length > 1).map(([key, v]) => ({ key, rows: v.map((o) => offerRow(o, o.status)) }));
}

async function duplicateCommerceProductGroups(): Promise<Group[]> {
  const products = await db.commerceProduct.findMany({ select: { id: true, name: true, canonicalUrl: true, observedAt: true }, orderBy: { id: "asc" }, take: MAX_SCAN });
  const groups = new Map<string, typeof products>();
  for (const p of products) {
    const key = normalizeDestinationUrl(p.canonicalUrl) ?? p.canonicalUrl;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups.entries()]
    .filter(([, v]) => v.length > 1)
    .map(([key, v]) => ({ key, rows: v.map((p) => ({ id: p.id, title: p.name, detail: p.canonicalUrl, href: commerceProductHref(p.id), at: p.observedAt })) }));
}

async function duplicateReviewGroups(by: "title" | "content"): Promise<Group[]> {
  const rows =
    by === "title"
      ? await db.$queryRaw<Array<{ key: string; ids: string[]; slugs: string[]; titles: string[] }>>`
          SELECT btrim(lower(regexp_replace("canonicalTitle", '[^[:alnum:]]+', ' ', 'g'))) AS key,
                 array_agg(id ORDER BY "publishedAt") AS ids, array_agg(slug ORDER BY "publishedAt") AS slugs, array_agg("canonicalTitle" ORDER BY "publishedAt") AS titles
          FROM "normalized_reviews" WHERE status = 'PUBLISHED'
          GROUP BY 1 HAVING count(*) > 1 AND btrim(lower(regexp_replace("canonicalTitle", '[^[:alnum:]]+', ' ', 'g'))) <> '' ORDER BY 1 LIMIT ${MAX_SCAN}`
      : await db.$queryRaw<Array<{ key: string; ids: string[]; slugs: string[]; titles: string[] }>>`
          SELECT md5(btrim(lower(regexp_replace(body, '[[:space:]]+', ' ', 'g')))) AS key,
                 array_agg(id ORDER BY "publishedAt") AS ids, array_agg(slug ORDER BY "publishedAt") AS slugs, array_agg("canonicalTitle" ORDER BY "publishedAt") AS titles
          FROM "normalized_reviews" WHERE status = 'PUBLISHED' AND length(btrim(body)) > 0
          GROUP BY 1 HAVING count(*) > 1 ORDER BY 1 LIMIT ${MAX_SCAN}`;
  return rows.map((r) => ({ key: r.key, rows: r.ids.map((id, i) => ({ id, title: r.titles[i], detail: `/${r.slugs[i]}`, href: reviewHref(id) })) }));
}

async function duplicateCouponGroups(): Promise<Group[]> {
  const rows = await db.$queryRaw<Array<{ key: string; ids: string[] }>>`
    SELECT lower(btrim(merchant)) || ' · ' || upper(btrim(code)) AS key, array_agg(id ORDER BY "createdAt") AS ids
    FROM "commerce_coupons" WHERE status = ANY(${LIVE_COUPON_STATUSES})
    GROUP BY lower(btrim(merchant)), upper(btrim(code)) HAVING count(*) > 1 ORDER BY 1 LIMIT ${MAX_SCAN}`;
  if (!rows.length) return [];
  const coupons = await db.commerceCoupon.findMany({ where: { id: { in: rows.flatMap((r) => r.ids) } }, select: couponSelect });
  const byId = new Map(coupons.map((c) => [c.id, c]));
  return rows.map((r) => ({ key: r.key, rows: r.ids.map((id) => byId.get(id)).filter((c): c is NonNullable<typeof c> => Boolean(c)).map((c) => couponRow(c, "same merchant and code")) }));
}

type OfficialRow = { id: string; name: string; officialStatus: string | null; officialUrl: string | null; manufacturerFact: boolean; manufacturerOffer: boolean };

async function unofficialOfficialRows(): Promise<OfficialRow[]> {
  return db.$queryRaw<OfficialRow[]>`
    SELECT * FROM (
      SELECT pe.id, pe.name, pe."officialStatus", pe."officialUrl",
        EXISTS (SELECT 1 FROM "product_facts" f WHERE f."productEntityId" = pe.id AND f.field = 'officialUrl' AND f.source = 'MANUFACTURER') AS "manufacturerFact",
        EXISTS (SELECT 1 FROM "commerce_offers" o JOIN "commerce_products" cp ON cp.id = o."productId"
                WHERE cp."productEntityId" = pe.id AND o."sellerType" = 'MANUFACTURER' AND o.status = 'FRESH') AS "manufacturerOffer"
      FROM "product_entities" pe
      WHERE (pe."officialStatus" IS NULL OR pe."officialStatus" <> 'VERIFIED')
        AND EXISTS (SELECT 1 FROM "content_entities" ce JOIN "normalized_reviews" r ON r.id = ce."normalizedReviewId"
                    WHERE ce."productEntityId" = pe.id AND r.status = 'PUBLISHED')
    ) t
    WHERE t."manufacturerFact" OR t."manufacturerOffer" OR t."officialUrl" IS NOT NULL
    ORDER BY t.name LIMIT ${MAX_SCAN}`;
}

type ConflictRow = { id: string; name: string; fields: string[]; public: boolean };

async function conflictingFactRows(): Promise<ConflictRow[]> {
  return db.$queryRaw<ConflictRow[]>`
    SELECT pe.id, pe.name,
      ARRAY(SELECT jsonb_array_elements_text(pe."factSummary"->'conflicting')) AS fields,
      EXISTS (SELECT 1 FROM "content_entities" ce JOIN "normalized_reviews" r ON r.id = ce."normalizedReviewId"
              WHERE ce."productEntityId" = pe.id AND r.status = 'PUBLISHED') AS public
    FROM "product_entities" pe
    WHERE jsonb_typeof(pe."factSummary"->'conflicting') = 'array' AND jsonb_array_length(pe."factSummary"->'conflicting') > 0
    ORDER BY pe.name LIMIT ${MAX_SCAN}`;
}

function groupCheck(fn: () => Promise<Group[]>): Pick<Check, "count" | "list"> {
  return {
    count: async () => (await fn()).length,
    list: async (_c, page, size) => pageOf(groupsToRows(await fn()), page, size),
  };
}

// ── The checks ───────────────────────────────────────────────────────────────

export const CHECKS: Check[] = [
  {
    key: "unverified-public-facts",
    category: "UNVERIFIED",
    label: "Public product facts without a source URL",
    rule: "ProductFact rows with no sourceUrl on products linked to published content.",
    unit: "facts",
    count: () => db.productFact.count({ where: { sourceUrl: null, entity: publicProduct } }),
    list: async (_c, page, size) => (await db.productFact.findMany({ where: { sourceUrl: null, entity: publicProduct }, select: factSelect, orderBy: { observedAt: "desc" }, skip: skip(page, size), take: size })).map(factRow),
  },
  {
    key: "unverified-official",
    category: "UNVERIFIED",
    label: "Products presented as official without VERIFIED official status",
    rule: "Products linked to published content whose officialStatus is not VERIFIED but which carry an official signal: a MANUFACTURER officialUrl fact, a FRESH MANUFACTURER offer, or an officialUrl.",
    unit: "products",
    count: async () => (await unofficialOfficialRows()).length,
    list: async (_c, page, size) =>
      pageOf(await unofficialOfficialRows(), page, size).map((r) => ({
        id: r.id,
        title: r.name,
        detail: `officialStatus ${r.officialStatus ?? "not checked"}; ${[r.manufacturerFact && "MANUFACTURER officialUrl fact", r.manufacturerOffer && "fresh MANUFACTURER offer", r.officialUrl && `officialUrl ${r.officialUrl}`].filter(Boolean).join(", ")}`,
        href: productHref(r.id),
      })),
  },
  {
    key: "stale-fresh-offers",
    category: "STALE",
    label: "Offers older than the price max age still marked FRESH",
    rule: "CommerceOffer status FRESH with observedAt older than PRODUCT_PRICE_MAX_AGE_HOURS (default 48 h).",
    unit: "offers",
    safeFix: "Marked STALE (row kept).",
    count: (c) => db.commerceOffer.count({ where: staleOfferWhere(c) }),
    list: async (c, page, size) => (await db.commerceOffer.findMany({ where: staleOfferWhere(c), select: offerSelect, orderBy: { observedAt: "asc" }, skip: skip(page, size), take: size })).map((o) => offerRow(o, `observed ${o.observedAt.toISOString()}`)),
  },
  {
    key: "expired-verified-coupons",
    category: "STALE",
    label: "Coupons past their expiry still VERIFIED",
    rule: "CommerceCoupon status VERIFIED with expiresAt in the past.",
    unit: "coupons",
    safeFix: "Marked EXPIRED (row kept).",
    count: (c) => db.commerceCoupon.count({ where: expiredCouponWhere(c) }),
    list: async (c, page, size) => (await db.commerceCoupon.findMany({ where: expiredCouponWhere(c), select: couponSelect, orderBy: { expiresAt: "asc" }, skip: skip(page, size), take: size })).map((x) => couponRow(x, `expired ${x.expiresAt?.toISOString() ?? ""}`)),
  },
  {
    key: "unseen-verified-coupons",
    category: "STALE",
    label: "VERIFIED coupons not re-seen recently",
    rule: "CommerceCoupon status VERIFIED, not expired, whose lastVerifiedAt is missing or older than COMMERCE_COUPON_MAX_AGE_DAYS (default 7). Not shown publicly; flagged only.",
    unit: "coupons",
    count: (c) => db.commerceCoupon.count({ where: unseenCouponWhere(c) }),
    list: async (c, page, size) => (await db.commerceCoupon.findMany({ where: unseenCouponWhere(c), select: couponSelect, orderBy: { lastVerifiedAt: { sort: "asc", nulls: "first" } }, skip: skip(page, size), take: size })).map((x) => couponRow(x, x.lastVerifiedAt ? `last verified ${x.lastVerifiedAt.toISOString()}` : "never re-verified")),
  },
  {
    key: "conflicting-fact-fields",
    category: "CONFLICTING",
    label: "Products with conflicting fact fields",
    rule: "ProductEntity factSummary.conflicting is non-empty (sources of equal authority disagree; no value is shown).",
    unit: "products",
    count: async () => (await conflictingFactRows()).length,
    list: async (_c, page, size) => pageOf(await conflictingFactRows(), page, size).map((r) => ({ id: r.id, title: r.name, detail: `conflicting: ${r.fields.join(", ")}${r.public ? " · linked to published content" : ""}`, href: productHref(r.id) })),
  },
  {
    key: "conflicting-coupons",
    category: "CONFLICTING",
    label: "Coupons marked CONFLICTING",
    rule: "CommerceCoupon status CONFLICTING.",
    unit: "coupons",
    count: () => db.commerceCoupon.count({ where: { status: "CONFLICTING" } }),
    list: async (_c, page, size) => (await db.commerceCoupon.findMany({ where: { status: "CONFLICTING" }, select: couponSelect, orderBy: { updatedAt: "desc" }, skip: skip(page, size), take: size })).map((x) => couponRow(x, "conflicting evidence")),
  },
  {
    key: "duplicate-offers",
    category: "DUPLICATE",
    label: "Duplicate offers",
    rule: "Offers with the same product, seller, currency, price and canonical destination URL (tracking parameters ignored).",
    unit: "duplicate groups",
    ...groupCheck(duplicateOfferGroups),
  },
  {
    key: "duplicate-review-titles",
    category: "DUPLICATE",
    label: "Published pages with the same title",
    rule: "Published reviews whose title is identical after lower-casing and removing punctuation.",
    unit: "duplicate groups",
    ...groupCheck(() => duplicateReviewGroups("title")),
  },
  {
    key: "duplicate-review-content",
    category: "DUPLICATE",
    label: "Published pages with identical content",
    rule: "Published reviews whose body has the same hash after lower-casing and collapsing whitespace.",
    unit: "duplicate groups",
    ...groupCheck(() => duplicateReviewGroups("content")),
  },
  {
    key: "duplicate-commerce-products",
    category: "DUPLICATE",
    label: "Commerce products with the same canonical URL",
    rule: "CommerceProduct rows whose canonical URL is the same once tracking parameters, fragment, host case and trailing slash are ignored.",
    unit: "duplicate groups",
    ...groupCheck(duplicateCommerceProductGroups),
  },
  {
    key: "duplicate-coupons",
    category: "DUPLICATE",
    label: "Coupons with the same merchant and code",
    rule: "Live coupons (VERIFIED, UNVERIFIED, CONFLICTING, UNKNOWN) sharing merchant and code (case-insensitive), e.g. seen on two source pages.",
    unit: "duplicate groups",
    ...groupCheck(duplicateCouponGroups),
  },
  {
    key: "broken-offer-links",
    category: "BROKEN",
    label: "Offers with a broken destination",
    rule: "CommerceOffer linkStatus BROKEN, OFF_SITE or UNREACHABLE.",
    unit: "offers",
    count: () => db.commerceOffer.count({ where: brokenOfferWhere }),
    list: async (_c, page, size) => (await db.commerceOffer.findMany({ where: brokenOfferWhere, select: { ...offerSelect, linkHttpStatus: true, linkCheckedAt: true }, orderBy: { linkCheckedAt: "desc" }, skip: skip(page, size), take: size })).map((o) => offerRow(o, `link ${o.linkStatus}${o.linkHttpStatus ? ` (HTTP ${o.linkHttpStatus})` : ""}, offer ${o.status}`)),
  },
  {
    key: "missing-hero-image",
    category: "BROKEN",
    label: "Published pages whose hero image is missing",
    rule: "Published reviews with no primary image, a FAILED primary image, or a non-placeholder primary image with no URL.",
    unit: "pages",
    count: () => db.normalizedReview.count({ where: missingHeroWhere }),
    list: async (_c, page, size) =>
      (await db.normalizedReview.findMany({ where: missingHeroWhere, select: { id: true, slug: true, canonicalTitle: true, publishedAt: true, images: { where: { isPrimary: true }, take: 1, select: { enrichmentStatus: true, failureReason: true } } }, orderBy: { publishedAt: "desc" }, skip: skip(page, size), take: size })).map((r) => ({
        id: r.id,
        title: r.canonicalTitle,
        detail: `/${r.slug} · ${r.images[0] ? `primary image ${r.images[0].enrichmentStatus}${r.images[0].failureReason ? `: ${r.images[0].failureReason}` : ""}` : "no primary image"}`,
        href: reviewHref(r.id),
        at: r.publishedAt,
      })),
  },
  {
    key: "image-missing-source",
    category: "MISSING_SOURCE",
    label: "Published hero images without source or licence",
    rule: "Primary images of published reviews (not placeholders) with licence UNVERIFIED or no licence text, or with neither a source page nor an attribution URL.",
    unit: "images",
    count: () => db.imageAsset.count({ where: imageNoSourceWhere }),
    list: async (_c, page, size) =>
      (await db.imageAsset.findMany({ where: imageNoSourceWhere, select: { id: true, sourceType: true, licenseState: true, license: true, sourcePageUrl: true, attributionUrl: true, createdAt: true, review: { select: { id: true, canonicalTitle: true } } }, orderBy: { createdAt: "desc" }, skip: skip(page, size), take: size })).map((i) => ({
        id: i.id,
        title: i.review.canonicalTitle,
        detail: `${i.sourceType} · licence ${i.licenseState}${i.license ? ` (${i.license})` : ", no licence text"} · ${i.sourcePageUrl ?? i.attributionUrl ?? "no source page"}`,
        href: reviewHref(i.review.id),
        at: i.createdAt,
      })),
  },
  {
    key: "fact-missing-source",
    category: "MISSING_SOURCE",
    label: "Product facts without a source URL (all products)",
    rule: "Every ProductFact with no sourceUrl, published or not.",
    unit: "facts",
    count: () => db.productFact.count({ where: { sourceUrl: null } }),
    list: async (_c, page, size) => (await db.productFact.findMany({ where: { sourceUrl: null }, select: factSelect, orderBy: { observedAt: "desc" }, skip: skip(page, size), take: size })).map(factRow),
  },
];

export const CATEGORY_LABELS: Record<AuditCategory, string> = {
  UNVERIFIED: "Unverified",
  STALE: "Stale",
  CONFLICTING: "Conflicting",
  DUPLICATE: "Duplicate",
  BROKEN: "Broken",
  MISSING_SOURCE: "Missing source",
};

export function checkByKey(key: string): Check | undefined {
  return CHECKS.find((c) => c.key === key);
}

/** One page of a check's flagged items, evaluated now. */
export async function listFlagged(key: string, page: number, pageSize = 50, now = new Date()): Promise<{ rows: AuditRow[]; total: number } | null> {
  const check = checkByKey(key);
  if (!check) return null;
  const c = { now };
  const [total, rows] = await Promise.all([check.count(c), check.list(c, page, pageSize)]);
  return { rows, total };
}

// ── Run + store ──────────────────────────────────────────────────────────────

export const DATA_AUDIT_SETTING = "data_audit_last";

export type DataAuditResult = {
  status: "OK";
  trigger: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Counts found by each check before any fix was applied. */
  counts: Record<string, number>;
  /** Safe fixes applied (row counts). */
  fixed: { offersMarkedStale: number; couponsMarkedExpired: number };
  totalFlagged: number;
};

/** Safe fix: FRESH offers past the price max age → STALE. Audited with the ids changed. */
async function fixStaleOffers(c: Ctx, actor: AuditContext): Promise<number> {
  const rows = await db.commerceOffer.findMany({ where: staleOfferWhere(c), select: { id: true }, take: MAX_SCAN });
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.id);
  const r = await db.commerceOffer.updateMany({ where: { id: { in: ids }, ...staleOfferWhere(c) }, data: { status: "STALE" } });
  await audit(actor, { action: "data_audit.fix.offers_stale", entityType: "commerce_offer", entityId: "bulk", before: { status: "FRESH" }, after: { status: "STALE" }, metadata: { count: r.count, ids: ids.slice(0, 500), maxAgeHours: maxAgeMs("HIGH") / 3_600_000 } });
  return r.count;
}

/** Safe fix: VERIFIED coupons past their stated expiry → EXPIRED. Audited with the ids changed. */
async function fixExpiredCoupons(c: Ctx, actor: AuditContext): Promise<number> {
  const rows = await db.commerceCoupon.findMany({ where: expiredCouponWhere(c), select: { id: true }, take: MAX_SCAN });
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.id);
  const r = await db.commerceCoupon.updateMany({ where: { id: { in: ids }, ...expiredCouponWhere(c) }, data: { status: "EXPIRED" } });
  await audit(actor, { action: "data_audit.fix.coupons_expired", entityType: "commerce_coupon", entityId: "bulk", before: { status: "VERIFIED" }, after: { status: "EXPIRED" }, metadata: { count: r.count, ids: ids.slice(0, 500) } });
  return r.count;
}

export async function runDataAudit(trigger: string, opts: { now?: Date; fix?: boolean } = {}): Promise<DataAuditResult> {
  const started = new Date();
  const c = { now: opts.now ?? started };
  const counts: Record<string, number> = {};
  for (const check of CHECKS) counts[check.key] = await check.count(c);
  const actor: AuditContext = trigger.startsWith("admin:") ? { actor: trigger.slice(6) } : { ...SYSTEM_ACTOR, actor: "data-audit" };
  const fixed = { offersMarkedStale: 0, couponsMarkedExpired: 0 };
  if (opts.fix !== false) {
    fixed.offersMarkedStale = await fixStaleOffers(c, actor);
    fixed.couponsMarkedExpired = await fixExpiredCoupons(c, actor);
  }
  const finished = new Date();
  const result: DataAuditResult = {
    status: "OK",
    trigger,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    counts,
    fixed,
    totalFlagged: Object.values(counts).reduce((a, b) => a + b, 0),
  };
  const value = JSON.stringify(result);
  await db.automationSetting.upsert({ where: { key: DATA_AUDIT_SETTING }, create: { key: DATA_AUDIT_SETTING, value, updatedBy: actor.actor }, update: { value, updatedBy: actor.actor } });
  return result;
}

export async function lastDataAudit(): Promise<DataAuditResult | null> {
  const row = await db.automationSetting.findUnique({ where: { key: DATA_AUDIT_SETTING } }).catch(() => null);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as DataAuditResult;
    return parsed && typeof parsed === "object" && parsed.counts ? parsed : null;
  } catch {
    return null;
  }
}
