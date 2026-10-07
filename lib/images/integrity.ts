import type { Prisma } from "@prisma/client";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { safeFetch, type SafeFetchResult } from "@/lib/net/safe-fetch";
import { persistPageRenderModel } from "@/lib/pipeline/render-model";
import { revalidateReviewPaths } from "@/lib/pipeline/revalidate-paths";
import { audit, SYSTEM_ACTOR, type AuditContext } from "@/lib/security/audit";
import { commonsFileTitle, fileTitleMatches, namesSeveralProducts } from "./commons-search";
import { revalidateCommerce } from "@/lib/commerce/revalidate";
import { CATEGORIES } from "@/lib/taxonomy/definitions";
import { revalidateTag } from "next/cache";
import { CATEGORY_PHOTOS_TAG, cachedCategoryPhotosForCheck } from "@/lib/public/category-images";
import { storedCardImage } from "./deal-card-image";
import { clearCardImage, dealCardImageContext, liveCommerceProducts, resolveDealCardImage, runDealCardImages, type DealCardImagesResult } from "./deal-card-images";
import { brokenImageSrcs, extractOfficialProductImages } from "./deal-image";

/**
 * image-integrity: re-checks that every live hero image still loads, so a broken photo falls back to
 * the neutral category image straight away instead of showing a broken <img>.
 *
 *  - One polite request per image: HEAD (bot User-Agent), else a 1-byte GET (servers that refuse
 *    HEAD); IMAGE_INTEGRITY_PER_RUN images per run (default 80), 400 ms apart; an image checked in
 *    the last 20 h is skipped.
 *  - BROKEN (404/410, other 4xx, not an image, blocked/invalid URL): enrichmentStatus → FAILED with
 *    failureReason "image-integrity: <reason>"; publicImageUrl then serves the placeholder.
 *  - TRANSIENT (timeout, network, 5xx): FAILED only when the previous run also found it unreachable.
 *  - 429: every other image on that host is skipped for the rest of the run (checked next run).
 *  - A FAILED-by-integrity image whose URL loads again is restored (ENRICHED). Images failed for any
 *    other reason are never touched.
 *  - A Commons "product" photo whose file title names several products, or (when it was found by
 *    its file title rather than a Wikidata identity match) no longer names exactly this product, is
 *    FAILED as not exact (hero correction then picks a replacement); never restored by a URL check.
 * Rows are never deleted. Every status change is audited, the page's render model rebuilt and its
 * paths revalidated.
 *
 * Also backfills data.productImages for CommerceProducts normalized before deal images existed, from
 * their stored raw record (bounded per run).
 *
 * Per-image check state (last checked, consecutive transient failures) lives in one
 * AutomationSetting row (no schema change); entries for deleted or long-unchecked assets are pruned.
 */

export const INTEGRITY_PREFIX = "image-integrity:";
export const NOT_EXACT_REASON = `${INTEGRITY_PREFIX} not an exact-product photo`;
export const INTEGRITY_STATE_KEY = "image_integrity_state";
const RECHECK_AFTER_MS = 20 * 3_600_000;
const STATE_TTL_MS = 30 * 24 * 3_600_000;
const LIVE_STATUSES = ["PUBLISHED", "QUEUED", "NEEDS_REVIEW"] as const;

export const integrityPerRun = () => {
  const n = Number(process.env.IMAGE_INTEGRITY_PER_RUN);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 1000) : 80;
};

export type ProbeVerdict = { kind: "OK"; status: number; contentType: string } | { kind: "BROKEN" | "TRANSIENT" | "RATE_LIMITED"; status: number; reason: string };

const userAgent = () => `Made4BuyersBot/1.0 (+${config.siteUrl()}; image integrity check)`;

function classify(res: SafeFetchResult): ProbeVerdict {
  if (res.error) {
    const k = res.error.kind;
    const transient = k === "TIMEOUT" || k === "NETWORK" || k === "DNS_FAILURE";
    return { kind: transient ? "TRANSIENT" : "BROKEN", status: res.status, reason: `${k}: ${res.error.message}`.slice(0, 200) };
  }
  const s = res.status;
  if (s === 429) return { kind: "RATE_LIMITED", status: s, reason: "HTTP 429" };
  if (s === 200 || s === 206) {
    const contentType = (res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) return { kind: "BROKEN", status: s, reason: `not an image (content-type "${contentType || "none"}")` };
    if (contentType === "image/svg+xml") return { kind: "BROKEN", status: s, reason: "remote SVG" };
    return { kind: "OK", status: s, contentType };
  }
  if (s >= 500 || s === 408 || s === 425) return { kind: "TRANSIENT", status: s, reason: `HTTP ${s}` };
  return { kind: "BROKEN", status: s, reason: `HTTP ${s}` };
}

/** HEAD with a bot User-Agent; servers that refuse HEAD get a 1-byte GET. Never reads a body. */
export async function checkImageUrl(url: string): Promise<ProbeVerdict> {
  const opts = { timeoutMs: config.images.timeoutMs(), maxRedirects: 3, standardPortsOnly: true, headers: { Accept: "image/*", "User-Agent": userAgent() } };
  const head = await safeFetch(url, { ...opts, method: "HEAD" });
  const first = classify(head);
  if (first.kind === "OK" || first.kind === "RATE_LIMITED") return first;
  // HEAD refused, unsupported, or answered oddly: confirm with the smallest possible GET.
  if (head.error && head.error.kind !== "TIMEOUT" && head.error.kind !== "NETWORK") return first;
  const get = await safeFetch(url, { ...opts, method: "GET", headers: { ...opts.headers, Range: "bytes=0-0" } });
  return classify(get);
}

// ── Check state (one AutomationSetting row) ─────────────────────────────────

type AssetState = { at: string; transient?: number; last?: string };
type IntegrityState = { v: 1; assets: Record<string, AssetState> };

export async function readIntegrityState(): Promise<IntegrityState> {
  const row = await db.automationSetting.findUnique({ where: { key: INTEGRITY_STATE_KEY } }).catch(() => null);
  try {
    const parsed = row ? (JSON.parse(row.value) as IntegrityState) : null;
    if (parsed && parsed.v === 1 && parsed.assets && typeof parsed.assets === "object") return parsed;
  } catch {
    /* corrupt: start again */
  }
  return { v: 1, assets: {} };
}

async function writeIntegrityState(state: IntegrityState, actor: string, now: Date) {
  const cutoff = now.getTime() - STATE_TTL_MS;
  for (const [id, s] of Object.entries(state.assets)) if (!(Date.parse(s.at) >= cutoff)) delete state.assets[id];
  const value = JSON.stringify(state);
  await db.automationSetting.upsert({ where: { key: INTEGRITY_STATE_KEY }, create: { key: INTEGRITY_STATE_KEY, value, updatedBy: actor.slice(0, 200) }, update: { value, updatedBy: actor.slice(0, 200) } });
}

// ── One asset ───────────────────────────────────────────────────────────────

const assetSelect = {
  id: true,
  sourceType: true,
  sourceUrl: true,
  cdnUrl: true,
  enrichmentStatus: true,
  failureReason: true,
  imageType: true,
  sourcePageUrl: true,
  review: { select: { id: true, slug: true, status: true, categorySlug: true, brandSlug: true, productName: true, brand: true } },
} satisfies Prisma.ImageAssetSelect;
type CheckAsset = Prisma.ImageAssetGetPayload<{ select: typeof assetSelect }>;

export type AssetOutcome = "ok" | "restored" | "failed" | "transient" | "rate-limited" | "not-exact" | "unchanged-failed";

const failedByIntegrity = (a: { enrichmentStatus: string; failureReason: string | null }) => a.enrichmentStatus === "FAILED" && (a.failureReason ?? "").startsWith(INTEGRITY_PREFIX);

/**
 * Not this product's exact photo by today's rule: a Commons group shot, or (for a photo found by its
 * file title, i.e. not identity-matched through a Wikidata image fact) a title that no longer names
 * exactly this product.
 */
async function notExactReason(a: CheckAsset): Promise<string | null> {
  if (a.sourceType !== "WIKIMEDIA_COMMONS") return null;
  const title = commonsFileTitle(a.sourceUrl) ?? commonsFileTitle(a.sourcePageUrl);
  if (!title) return null;
  if (namesSeveralProducts(title, a.review.productName, a.review.brand)) return `${NOT_EXACT_REASON}: Commons file names several products (${title})`.slice(0, 300);
  const viaWikidata = a.sourcePageUrl ? (await db.productFact.count({ where: { field: "image", sourceKey: a.sourcePageUrl } })) > 0 : false;
  if (!viaWikidata && !fileTitleMatches(title, a.review.productName, a.review.brand)) return `${NOT_EXACT_REASON}: Commons file title does not name this exact product (${title})`.slice(0, 300);
  return null;
}

async function changeStatus(a: CheckAsset, next: { enrichmentStatus: "FAILED" | "ENRICHED"; failureReason: string | null }, ctx: AuditContext, meta: Record<string, unknown>) {
  await db.imageAsset.update({ where: { id: a.id }, data: next });
  await audit(ctx, { action: next.enrichmentStatus === "FAILED" ? "image.integrity.failed" : "image.integrity.restored", entityType: "image_asset", entityId: a.id, before: { enrichmentStatus: a.enrichmentStatus, failureReason: a.failureReason }, after: next, metadata: { reviewId: a.review.id, slug: a.review.slug, url: a.cdnUrl ?? a.sourceUrl, ...meta } });
  if (a.review.status === "PUBLISHED") {
    await persistPageRenderModel(a.review.id);
    revalidateReviewPaths(a.review);
  }
}

/** Checks one asset and applies the status rules (the state carries consecutive unreachable results). */
async function checkAsset(a: CheckAsset, state: IntegrityState, ctx: AuditContext, now: Date): Promise<{ outcome: AssetOutcome; reason?: string; host?: string }> {
  const notExact = await notExactReason(a);
  if (notExact) {
    state.assets[a.id] = { at: now.toISOString(), last: "not-exact" };
    if (a.enrichmentStatus === "FAILED" && a.failureReason?.startsWith(NOT_EXACT_REASON)) return { outcome: "unchanged-failed", reason: notExact };
    await changeStatus(a, { enrichmentStatus: "FAILED", failureReason: notExact }, ctx, { verdict: "NOT_EXACT" });
    return { outcome: "not-exact", reason: notExact };
  }
  const url = (a.cdnUrl ?? a.sourceUrl)!;
  const v = await checkImageUrl(url);
  if (v.kind === "RATE_LIMITED") return { outcome: "rate-limited", reason: v.reason, host: hostOf(url) };
  const prev = state.assets[a.id];
  if (v.kind === "OK") {
    state.assets[a.id] = { at: now.toISOString(), last: "ok" };
    if (failedByIntegrity(a)) {
      await changeStatus(a, { enrichmentStatus: "ENRICHED", failureReason: null }, ctx, { verdict: "OK", status: v.status });
      return { outcome: "restored" };
    }
    return { outcome: "ok" };
  }
  const transient = v.kind === "TRANSIENT" ? (prev?.transient ?? 0) + 1 : 0;
  state.assets[a.id] = { at: now.toISOString(), last: v.kind.toLowerCase(), ...(transient ? { transient } : {}) };
  if (v.kind === "TRANSIENT" && transient < 2) return { outcome: "transient", reason: v.reason };
  const reason = `${INTEGRITY_PREFIX} ${v.reason}${v.kind === "TRANSIENT" ? " (unreachable on 2 consecutive checks)" : ""}`.slice(0, 300);
  if (failedByIntegrity(a)) return { outcome: "unchanged-failed", reason };
  await changeStatus(a, { enrichmentStatus: "FAILED", failureReason: reason }, ctx, { verdict: v.kind, status: v.status, transientCount: transient || undefined });
  return { outcome: "failed", reason };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Live primary images the integrity check covers (remote URLs; never placeholders; integrity-failed ones for restore). */
const checkableWhere: Prisma.ImageAssetWhereInput = {
  isPrimary: true,
  sourceType: { not: "PLACEHOLDER" },
  OR: [{ sourceUrl: { startsWith: "http" } }, { cdnUrl: { startsWith: "http" } }],
  review: { status: { in: [...LIVE_STATUSES] } },
  AND: [{ OR: [{ enrichmentStatus: { not: "FAILED" } }, { failureReason: { startsWith: INTEGRITY_PREFIX } }] }],
};

// ── Commerce product image backfill ─────────────────────────────────────────

export type ProductImageBackfill = { checked: number; filled: number; none: number; noRaw: number };

/** Writes data.productImages for CommerceProducts stored before it existed, from their last raw record. */
export async function backfillCommerceProductImages(limit = 40): Promise<ProductImageBackfill> {
  const out: ProductImageBackfill = { checked: 0, filled: 0, none: 0, noRaw: 0 };
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "commerce_products"
    WHERE "lastRawId" IS NOT NULL AND ("data" IS NULL OR jsonb_typeof("data") <> 'object' OR NOT jsonb_exists("data", 'productImages'))
    ORDER BY "updatedAt" DESC LIMIT ${limit}`;
  for (const { id } of rows) {
    const p = await db.commerceProduct.findUnique({ where: { id }, select: { id: true, canonicalUrl: true, sku: true, data: true, lastRawId: true } });
    if (!p) continue;
    out.checked++;
    const raw = p.lastRawId ? await db.commerceRawRecord.findUnique({ where: { id: p.lastRawId }, select: { payload: true } }) : null;
    const images = raw ? extractOfficialProductImages(raw.payload, p.canonicalUrl, { sku: p.sku }) : [];
    if (!raw) out.noRaw++;
    else if (images.length) out.filled++;
    else out.none++;
    const data = (p.data && typeof p.data === "object" && !Array.isArray(p.data) ? p.data : {}) as Record<string, unknown>;
    // [] marks "looked, none stated" so the product is not re-read every run.
    await db.commerceProduct.update({ where: { id: p.id }, data: { data: { ...data, productImages: images } as unknown as Prisma.InputJsonValue } });
  }
  return out;
}

// ── Deal cards and category features ───────────────────────────────────────

export type DealImageIntegrity = {
  /** Live commerce products (fresh offer) whose card image was considered. */
  live: number;
  checked: number;
  ok: number;
  broken: number;
  restored: number;
  transient: number;
  /** Stored illustrative photos no longer valid for their product (another product's, or its type changed): removed. */
  mismatched: number;
  skippedRecent: number;
  categoryChecked: number;
  categoryBroken: number;
  /** The repair pass (labelled product-type photos for cards left with the category image). */
  repair: DealCardImagesResult | null;
  items: Array<{ productId: string; name: string; outcome: string; src?: string; reason?: string }>;
};

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

async function setBroken(productId: string, src: string, broken: boolean, now: Date): Promise<void> {
  const p = await db.commerceProduct.findUnique({ where: { id: productId }, select: { data: true } });
  if (!p) return;
  const data = isRecord(p.data) ? { ...p.data } : {};
  const map = isRecord(data.brokenImages) ? { ...data.brokenImages } : {};
  if (broken) map[src] = now.toISOString();
  else delete map[src];
  if (Object.keys(map).length) data.brokenImages = map;
  else delete data.brokenImages;
  await db.commerceProduct.update({ where: { id: productId }, data: { data: data as Prisma.InputJsonValue } });
}

/**
 * Deal-card images of every live commerce product: the image the card shows now (exact or illustrative)
 * must load; a broken one is recorded in data.brokenImages (the card falls to the next priority at once),
 * a recorded one that loads again is restored, a stored illustrative photo that is not this product's
 * (or no longer its type) is removed. Then the repair pass attaches a labelled product-type photo to
 * every card left with the category image. Category feature photos (home issue panels) are checked too.
 */
export async function checkDealCardImages(trigger: string, state: IntegrityState, opts: { now: Date; limit: number; pauseMs: number; deadline: number; repair?: boolean }): Promise<DealImageIntegrity> {
  const out: DealImageIntegrity = { live: 0, checked: 0, ok: 0, broken: 0, restored: 0, transient: 0, mismatched: 0, skippedRecent: 0, categoryChecked: 0, categoryBroken: 0, repair: null, items: [] };
  const now = opts.now;
  const rows = await liveCommerceProducts(now.getTime());
  out.live = rows.length;
  const ctx = await dealCardImageContext([...new Set(rows.map((r) => r.productEntityId).filter((x): x is string => Boolean(x)))]);
  let changed = false;
  const pause = async () => {
    if (out.checked > 0 && opts.pauseMs > 0) await new Promise((r) => setTimeout(r, opts.pauseMs));
  };
  for (const r of rows) {
    if (out.checked >= opts.limit || Date.now() > opts.deadline) break;
    const data = isRecord(r.data) ? r.data : {};
    // Wrong-image prevention: a stored photo that is not valid for THIS product is removed (never shown: storedCardImage refuses it).
    if (isRecord(data.cardImage) && !storedCardImage(r, r.brand?.categories ?? []) && !brokenImageSrcs(r.data).has(String(data.cardImage.src))) {
      await clearCardImage(r.id);
      out.mismatched++;
      changed = true;
      out.items.push({ productId: r.id, name: r.name, outcome: "mismatched: stored illustrative photo removed", src: String(data.cardImage.src) });
    }
    // Restore: a photo recorded broken more than 20 h ago is re-checked.
    for (const [src, at] of Object.entries(isRecord(data.brokenImages) ? data.brokenImages : {})) {
      if (now.getTime() - (Date.parse(String(at)) || 0) < RECHECK_AFTER_MS || out.checked >= opts.limit) continue;
      await pause();
      out.checked++;
      const v = await checkImageUrl(src);
      if (v.kind === "OK") {
        await setBroken(r.id, src, false, now);
        out.restored++;
        changed = true;
        out.items.push({ productId: r.id, name: r.name, outcome: "restored", src });
      }
    }
    const img = resolveDealCardImage(r, ctx);
    if (img.kind === "category" || !/^https?:\/\//.test(img.src)) continue;
    const key = `deal:${img.src}`;
    if (now.getTime() - (Date.parse(state.assets[key]?.at ?? "") || 0) < RECHECK_AFTER_MS) {
      out.skippedRecent++;
      continue;
    }
    await pause();
    out.checked++;
    const v = await checkImageUrl(img.src);
    if (v.kind === "OK") {
      state.assets[key] = { at: now.toISOString(), last: "ok" };
      out.ok++;
      continue;
    }
    if (v.kind === "RATE_LIMITED") continue;
    const transient = v.kind === "TRANSIENT" ? (state.assets[key]?.transient ?? 0) + 1 : 0;
    state.assets[key] = { at: now.toISOString(), last: v.kind.toLowerCase(), ...(transient ? { transient } : {}) };
    if (v.kind === "TRANSIENT" && transient < 2) {
      out.transient++;
      continue;
    }
    await setBroken(r.id, img.src, true, now);
    out.broken++;
    changed = true;
    out.items.push({ productId: r.id, name: r.name, outcome: `broken ${img.kind} image`, src: img.src, reason: v.reason });
    await audit(SYSTEM_ACTOR, { action: "image.integrity.deal_broken", entityType: "commerce_product", entityId: r.id, metadata: { src: img.src, kind: img.kind, reason: v.reason } }).catch(() => undefined);
  }

  // Category features: each category photo must load (a broken one is re-fetched by purging the cache).
  try {
    const photos = await cachedCategoryPhotosForCheck(CATEGORIES.map((c) => c.slug));
    for (const [slug, photo] of Object.entries(photos)) {
      if (!photo || Date.now() > opts.deadline) continue;
      const key = `category:${slug}`;
      if (now.getTime() - (Date.parse(state.assets[key]?.at ?? "") || 0) < RECHECK_AFTER_MS) continue;
      await pause();
      out.categoryChecked++;
      const v = await checkImageUrl(photo.url);
      state.assets[key] = { at: now.toISOString(), last: v.kind === "OK" ? "ok" : v.kind.toLowerCase() };
      if (v.kind === "BROKEN") out.categoryBroken++;
    }
    if (out.categoryBroken) {
      try {
        revalidateTag(CATEGORY_PHOTOS_TAG, { expire: 0 });
      } catch {
        /* no request context: the daily cache refresh replaces it */
      }
    }
  } catch (error) {
    log.warn("category photo check failed", { stage: "IMAGE_ENRICHMENT", error: String(error).slice(0, 200) });
  }

  if (opts.repair !== false && Date.now() < opts.deadline) {
    out.repair = await runDealCardImages(trigger, { limit: 40, now: now.getTime() }).catch((error: unknown) => {
      log.error("deal card image repair failed", { stage: "IMAGE_ENRICHMENT", error: String(error) });
      return null;
    });
    if (out.repair?.attached) changed = true;
  }
  if (changed) await revalidateCommerce().catch(() => undefined);
  return out;
}

// ── The job ─────────────────────────────────────────────────────────────────

export type ImageIntegrityResult = {
  status: "OK";
  trigger: string;
  candidates: number;
  checked: number;
  ok: number;
  restored: number;
  failed: number;
  transient: number;
  notExact: number;
  skippedRecent: number;
  skippedRateLimited: number;
  rateLimitedHosts: string[];
  /** Due images left for the next run (per-run cap or time budget reached). */
  remaining: number;
  productImages: ProductImageBackfill;
  /** Deal cards (live commerce products) and category features. */
  deals: DealImageIntegrity | null;
  items: Array<{ assetId: string; slug: string; outcome: AssetOutcome; reason?: string }>;
};

export async function runImageIntegrity(trigger: string, opts: { limit?: number; pauseMs?: number; now?: Date; productImageLimit?: number; budgetMs?: number; dealLimit?: number; dealRepair?: boolean } = {}): Promise<ImageIntegrityResult> {
  const t0 = Date.now();
  // Stays well inside the cron route's 300 s (a slow host can take IMAGE_TIMEOUT_MS per request).
  const budgetMs = opts.budgetMs ?? 200_000;
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? integrityPerRun();
  const pauseMs = opts.pauseMs ?? 400;
  const state = await readIntegrityState();
  const out: ImageIntegrityResult = { status: "OK", trigger, candidates: 0, checked: 0, ok: 0, restored: 0, failed: 0, transient: 0, notExact: 0, skippedRecent: 0, skippedRateLimited: 0, rateLimitedHosts: [], remaining: 0, productImages: { checked: 0, filled: 0, none: 0, noRaw: 0 }, deals: null, items: [] };

  const all = await db.imageAsset.findMany({ where: checkableWhere, select: assetSelect, orderBy: { createdAt: "asc" } });
  out.candidates = all.length;
  const lastAt = (id: string) => Date.parse(state.assets[id]?.at ?? "") || 0;
  // Never-checked first, then the longest unchecked; published pages before drafts.
  const due = all
    .filter((a) => {
      const recent = now.getTime() - lastAt(a.id) < RECHECK_AFTER_MS;
      if (recent) out.skippedRecent++;
      return !recent;
    })
    .sort((a, b) => lastAt(a.id) - lastAt(b.id) || Number(b.review.status === "PUBLISHED") - Number(a.review.status === "PUBLISHED"));

  const skipHosts = new Set<string>();
  for (const a of due) {
    if (out.checked >= limit || Date.now() - t0 > budgetMs) break;
    const host = hostOf((a.cdnUrl ?? a.sourceUrl) ?? "");
    if (skipHosts.has(host)) {
      out.skippedRateLimited++;
      continue;
    }
    // Polite pacing: one request at a time, pauseMs apart.
    if (out.checked > 0 && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    out.checked++;
    try {
      const r = await checkAsset(a, state, SYSTEM_ACTOR, now);
      if (r.outcome === "rate-limited") {
        skipHosts.add(r.host ?? host);
        out.skippedRateLimited++;
      } else if (r.outcome === "ok") out.ok++;
      else if (r.outcome === "restored") out.restored++;
      else if (r.outcome === "failed") out.failed++;
      else if (r.outcome === "transient") out.transient++;
      else if (r.outcome === "not-exact") out.notExact++;
      if (r.outcome !== "ok") out.items.push({ assetId: a.id, slug: a.review.slug, outcome: r.outcome, reason: r.reason });
    } catch (error) {
      log.error("image integrity check failed", { stage: "IMAGE_ENRICHMENT", assetId: a.id, error: String(error) });
      out.items.push({ assetId: a.id, slug: a.review.slug, outcome: "transient", reason: `check error: ${String(error).slice(0, 160)}` });
    }
  }
  out.rateLimitedHosts = [...skipHosts];
  // Everything due that did not get a definitive result (cap/budget reached, or its host rate-limited us).
  out.remaining = Math.max(0, due.length - (out.checked - out.items.filter((i) => i.outcome === "rate-limited").length));
  out.productImages = await backfillCommerceProductImages(opts.productImageLimit ?? 40).catch((error: unknown) => {
    log.error("commerce product image backfill failed", { stage: "IMAGE_ENRICHMENT", error: String(error) });
    return out.productImages;
  });
  // Deal cards and category features: detect missing / broken / mismatched and repair via the priority chain.
  out.deals = await checkDealCardImages(trigger, state, { now, limit: opts.dealLimit ?? 120, pauseMs, deadline: t0 + budgetMs + 60_000, repair: opts.dealRepair }).catch((error: unknown) => {
    log.error("deal card image integrity failed", { stage: "IMAGE_ENRICHMENT", error: String(error) });
    return null;
  });
  await writeIntegrityState(state, `job:${trigger}`, now);
  if (out.failed || out.restored || out.notExact) log.info("image integrity changes", { stage: "IMAGE_ENRICHMENT", trigger, failed: out.failed, restored: out.restored, notExact: out.notExact });
  return out;
}

/** Admin "Re-check": checks one image now (ignores the 20 h window), audited as the admin. */
export async function recheckImageAsset(assetId: string, ctx: AuditContext, now = new Date()): Promise<{ outcome: AssetOutcome | "not-checkable"; reason?: string }> {
  const a = await db.imageAsset.findFirst({ where: { id: assetId, ...checkableWhere }, select: assetSelect });
  if (!a) return { outcome: "not-checkable", reason: "not a live remote primary image (placeholders and images failed for other reasons are not re-checked)" };
  const state = await readIntegrityState();
  const r = await checkAsset(a, state, ctx, now);
  await writeIntegrityState(state, ctx.actor, now);
  return { outcome: r.outcome, reason: r.reason };
}

/** Last integrity check per asset (for Admin → Images). */
export async function integrityCheckTimes(): Promise<Map<string, { at: Date; last?: string; transient?: number }>> {
  const s = await readIntegrityState();
  return new Map(Object.entries(s.assets).map(([id, v]) => [id, { at: new Date(v.at), last: v.last, transient: v.transient }]));
}
