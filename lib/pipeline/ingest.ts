import { Prisma, type ContentItem, type IngestionRun } from "@prisma/client";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { toPipelineError } from "@/lib/errors";
import { withLock } from "@/lib/jobs/lock";
import { log } from "@/lib/log";
import { recordEvent } from "@/lib/analytics/events";
import { SYSTEM_ACTOR, type AuditContext } from "@/lib/security/audit";
import { sha256, stableStringify } from "@/lib/util/text";
import { contentSourceName, fetchContentBatch } from "./content-source";
import { recordFailure, resolveFailures } from "./failures";
import { contentHash, normalizeContent } from "./normalize";
import { processReview } from "./process";
import { runPublishCycle } from "./publish";
import { validateContentItem } from "./validate";

/**
 * Ingestion run orchestration:
 *   CONTENT_FETCH → (per item) VALIDATION → raw ContentItem snapshot (INGESTED)
 *   → bounded processing of pending items: NORMALIZATION → DEDUPE → review stages
 *   → optional publish cycle.
 * Items that do not fit in one run stay INGESTED and are picked up by the next run.
 */

export type IngestCounters = {
  totalFetched: number;
  normalized: number;
  duplicate: number;
  unchanged: number;
  updated: number;
  failedNormalization: number;
  queued: number;
  failure: number;
  reasons: Record<string, number>;
  duplicates: Array<{ sourceId: string; duplicateOf: string; reason: string }>;
};

function counters(): IngestCounters {
  return { totalFetched: 0, normalized: 0, duplicate: 0, unchanged: 0, updated: 0, failedNormalization: 0, queued: 0, failure: 0, reasons: {}, duplicates: [] };
}

function bump(c: IngestCounters, code: string) {
  c.reasons[code] = (c.reasons[code] ?? 0) + 1;
}

/** Stage VALIDATION + raw snapshot persistence for one fetched item. Never throws. */
export async function ingestRawItem(raw: unknown, source: string, run: Pick<IngestionRun, "id">, c: IngestCounters): Promise<ContentItem | null> {
  try {
    const v = validateContentItem(raw);
    const rawJson = (raw ?? null) as Prisma.InputJsonValue;
    if (!v.ok) {
      const sourceId = v.sourceId ?? `invalid:${sha256(stableStringify(raw)).slice(0, 24)}`;
      const reason = v.issues.join("; ").slice(0, 1000);
      const item = await db.contentItem.upsert({
        where: { source_sourceId: { source, sourceId } },
        create: { source, sourceId, rawPayload: rawJson, contentHash: sha256(stableStringify(raw)), processingStatus: "FAILED", errorCode: "CONTENT_SCHEMA_INVALID", statusReason: reason, ingestRunId: run.id },
        update: { rawPayload: rawJson, contentHash: sha256(stableStringify(raw)), processingStatus: "FAILED", errorCode: "CONTENT_SCHEMA_INVALID", statusReason: reason, ingestRunId: run.id, lastSeenAt: new Date() },
      });
      await recordFailure({ stage: "VALIDATION", code: "CONTENT_SCHEMA_INVALID", message: reason, entityType: "content_item", entityId: item.id, contentItemId: item.id, runId: run.id });
      c.failedNormalization++;
      bump(c, "CONTENT_SCHEMA_INVALID");
      log.warn("content item invalid", { stage: "VALIDATION", sourceId, issues: v.issues });
      return item;
    }
    const hash = contentHash(v.value);
    const existing = await db.contentItem.findUnique({ where: { source_sourceId: { source, sourceId: v.value.sourceId } } });
    if (existing && existing.contentHash === hash && existing.processingStatus !== "FAILED") {
      await db.contentItem.update({ where: { id: existing.id }, data: { lastSeenAt: new Date() } });
      c.unchanged++;
      return existing;
    }
    const data = {
      sourceUrl: v.value.url ?? null,
      rawPayload: rawJson,
      contentHash: hash,
      publishedAt: v.value.publishedAt ?? null,
      fetchedAt: new Date(),
      lastSeenAt: new Date(),
      processingStatus: "INGESTED" as const,
      statusReason: existing ? "content changed since last fetch" : null,
      errorCode: null,
      retryCount: 0,
      ingestRunId: run.id,
    };
    const item = existing
      ? await db.contentItem.update({ where: { id: existing.id }, data })
      : await db.contentItem.create({ data: { source, sourceId: v.value.sourceId, ...data } });
    if (existing) c.updated++;
    await resolveFailures({ stage: "VALIDATION", entityType: "content_item", entityId: item.id });
    return item;
  } catch (error) {
    c.failure++;
    bump(c, "UNEXPECTED_ERROR");
    log.error("raw item persistence failed", { stage: "VALIDATION", runId: run.id, error });
    return null;
  }
}

async function uniqueSlug(base: string, source: string, sourceId: string, ownId?: string): Promise<string> {
  const taken = await db.normalizedReview.findUnique({ where: { slug: base }, select: { id: true } });
  if (!taken || taken.id === ownId) return base;
  return `${base.slice(0, 80)}-${sha256(`${source}|${sourceId}`).slice(0, 6)}`;
}

/** Stages NORMALIZATION + DEDUPE (+ downstream review stages) for one INGESTED content item. */
export async function processContentItem(itemId: string, c: IngestCounters, runId?: string, attempt = 0): Promise<void> {
  const item = await db.contentItem.findUniqueOrThrow({ where: { id: itemId } });
  try {
    const v = validateContentItem(item.rawPayload);
    if (!v.ok) {
      await db.contentItem.update({ where: { id: item.id }, data: { processingStatus: "FAILED", errorCode: "CONTENT_SCHEMA_INVALID", statusReason: v.issues.join("; ").slice(0, 1000) } });
      c.failedNormalization++;
      bump(c, "CONTENT_SCHEMA_INVALID");
      return;
    }
    const cand = normalizeContent(v.value, { source: item.source, fetchedAt: item.fetchedAt });
    const own = await db.normalizedReview.findUnique({ where: { source_sourceId: { source: item.source, sourceId: item.sourceId } } });

    // DEDUPE — deterministic key first, then canonical URL.
    const dup = await db.normalizedReview.findFirst({
      where: {
        OR: [{ dedupeKey: cand.dedupeKey }, ...(cand.canonicalUrl ? [{ canonicalUrl: cand.canonicalUrl }] : [])],
        NOT: { source: item.source, sourceId: item.sourceId },
      },
      select: { id: true, slug: true, dedupeKey: true },
    });
    if (dup && !own) {
      const reason = dup.dedupeKey === cand.dedupeKey ? `dedupe key ${cand.dedupeKey}` : `canonical URL ${cand.canonicalUrl}`;
      await db.contentItem.update({
        where: { id: item.id },
        data: { processingStatus: "DUPLICATE", errorCode: "DUPLICATE_REVIEW", statusReason: `Duplicate of review ${dup.slug} (${reason})`, dedupeKey: cand.dedupeKey, normalizedReviewId: dup.id },
      });
      c.duplicate++;
      bump(c, "DUPLICATE_REVIEW");
      if (c.duplicates.length < 500) c.duplicates.push({ sourceId: item.sourceId, duplicateOf: dup.id, reason });
      log.info("duplicate content item", { stage: "DEDUPE", sourceId: item.sourceId, duplicateOf: dup.id, reason });
      return;
    }

    const slug = own ? own.slug : await uniqueSlug(cand.slugBase, item.source, item.sourceId);
    const textFields = own?.manualEditLocked ? {} : { canonicalTitle: cand.canonicalTitle, summary: cand.summary, body: cand.body };
    const base = {
      sourceUrl: cand.sourceUrl ?? null,
      canonicalUrl: cand.canonicalUrl ?? null,
      // Keep the existing key when a content update would collide with another review.
      dedupeKey: own && dup ? own.dedupeKey : cand.dedupeKey,
      author: cand.author ?? null,
      sourcePublishedAt: cand.publishedAt ?? null,
    };
    const review = own
      ? await db.normalizedReview.update({ where: { id: own.id }, data: { ...base, ...textFields } })
      : await db.normalizedReview.create({
          data: {
            source: item.source,
            sourceId: item.sourceId,
            slug,
            productName: cand.productIdentity,
            canonicalTitle: cand.canonicalTitle,
            summary: cand.summary,
            body: cand.body,
            ...base,
          },
        });
    await db.contentItem.update({ where: { id: item.id }, data: { processingStatus: "NORMALIZED", errorCode: null, statusReason: null, dedupeKey: cand.dedupeKey, normalizedReviewId: review.id } });
    await resolveFailures({ stage: "NORMALIZATION", entityType: "content_item", entityId: item.id });
    c.normalized++;
    log.info("content normalized", { stage: "NORMALIZATION", sourceId: item.sourceId, reviewId: review.id, dedupeKey: cand.dedupeKey });

    const result = await processReview(review.id, { content: v.value });
    if (result.status === "QUEUED") c.queued++;
  } catch (error) {
    if (attempt === 0 && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // A concurrent item claimed the same dedupe key or slug; re-run so dedupe sees it.
      return processContentItem(itemId, c, runId, 1);
    }
    const e = toPipelineError(error);
    await db.contentItem.update({ where: { id: item.id }, data: { processingStatus: "FAILED", errorCode: e.code, statusReason: e.message.slice(0, 1000), retryCount: { increment: 1 } } });
    await recordFailure({ stage: "NORMALIZATION", code: e.code, message: e.message, entityType: "content_item", entityId: item.id, contentItemId: item.id, runId, retryable: e.retryable });
    c.failure++;
    bump(c, e.code);
  }
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export type IngestSummary = {
  runId: string;
  status: string;
  totalFetched: number;
  normalized: number;
  duplicates: number;
  unchanged: number;
  updated: number;
  failedNormalization: number;
  queued: number;
  failures: number;
  reasons: Record<string, number>;
  pendingRemaining: number;
  publishCycle?: Awaited<ReturnType<typeof runPublishCycle>>;
};

/** Processes items still INGESTED (from this or previous runs), bounded by INGEST_MAX_ITEMS_PER_RUN. */
export async function processPendingItems(c: IngestCounters, runId?: string, limit = config.ingest.maxItemsPerRun()) {
  const pending = await db.contentItem.findMany({ where: { processingStatus: "INGESTED" }, orderBy: { fetchedAt: "asc" }, take: limit, select: { id: true } });
  await mapLimit(pending, Number(process.env.INGEST_CONCURRENCY ?? 4) || 4, (p) => processContentItem(p.id, c, runId));
  return db.contentItem.count({ where: { processingStatus: "INGESTED" } });
}

export async function runIngestion(opts: { trigger: string; ctx?: AuditContext; items?: unknown[]; source?: string } = { trigger: "manual" }): Promise<IngestSummary> {
  return withLock("ingestion", 15 * 60_000, async () => {
    const source = opts.source ?? contentSourceName();
    const run = await db.ingestionRun.create({ data: { source, trigger: opts.trigger, status: "RUNNING" } });
    const c = counters();
    log.info("ingestion run started", { stage: "CONTENT_FETCH", runId: run.id, source, trigger: opts.trigger });

    let items: unknown[];
    try {
      items = opts.items ?? (await fetchContentBatch()).items;
      await resolveFailures({ stage: "CONTENT_FETCH", entityType: "job", entityId: "content-api" });
    } catch (error) {
      const e = toPipelineError(error);
      await recordFailure({ stage: "CONTENT_FETCH", code: e.code, message: e.message, entityType: "job", entityId: "content-api", runId: run.id, retryable: e.retryable });
      // Still process leftovers from earlier runs so a feed outage does not stall the queue.
      const remaining = await processPendingItems(c, run.id);
      await db.ingestionRun.update({
        where: { id: run.id },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          normalizedCount: c.normalized,
          duplicateCount: c.duplicate,
          queuedCount: c.queued,
          failureCount: c.failure + 1,
          failureReasonSummary: { ...c.reasons, [e.code]: 1, message: e.message },
        },
      });
      await recordEvent({ event: "ingestion", metadata: { runId: run.id, status: "FAILED", code: e.code } });
      log.error("ingestion fetch failed", { stage: "CONTENT_FETCH", runId: run.id, code: e.code, error: e.message });
      return { runId: run.id, status: "FAILED", totalFetched: 0, normalized: c.normalized, duplicates: c.duplicate, unchanged: 0, updated: 0, failedNormalization: 0, queued: c.queued, failures: c.failure + 1, reasons: { ...c.reasons, [e.code]: 1 }, pendingRemaining: remaining };
    }

    c.totalFetched = items.length;
    for (const raw of items) await ingestRawItem(raw, source, run, c);
    const pendingRemaining = await processPendingItems(c, run.id);
    const publishCycle = await runPublishCycle(opts.ctx ?? SYSTEM_ACTOR);

    const hadErrors = c.failure > 0 || c.failedNormalization > 0;
    const status = hadErrors ? "COMPLETED_WITH_ERRORS" : "COMPLETED";
    await db.ingestionRun.update({
      where: { id: run.id },
      data: {
        status,
        completedAt: new Date(),
        totalFetched: c.totalFetched,
        normalizedCount: c.normalized,
        duplicateCount: c.duplicate,
        unchangedCount: c.unchanged,
        updatedCount: c.updated,
        failedNormalizationCount: c.failedNormalization,
        queuedCount: c.queued,
        failureCount: c.failure,
        failureReasonSummary: Object.keys(c.reasons).length ? c.reasons : Prisma.DbNull,
        duplicateItems: c.duplicates.length ? c.duplicates : Prisma.DbNull,
      },
    });
    await recordEvent({ event: "ingestion", metadata: { runId: run.id, status, fetched: c.totalFetched, normalized: c.normalized, duplicates: c.duplicate } });
    log.info("ingestion run completed", { stage: "CONTENT_FETCH", runId: run.id, status, ...c, duplicates: c.duplicate });
    return {
      runId: run.id,
      status,
      totalFetched: c.totalFetched,
      normalized: c.normalized,
      duplicates: c.duplicate,
      unchanged: c.unchanged,
      updated: c.updated,
      failedNormalization: c.failedNormalization,
      queued: c.queued,
      failures: c.failure,
      reasons: c.reasons,
      pendingRemaining,
      publishCycle,
    };
  });
}
