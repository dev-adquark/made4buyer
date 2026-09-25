import type { PipelineStage, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ERROR_CODES, type ErrorCode } from "@/lib/errors";
import { log } from "@/lib/log";
import { sha256 } from "@/lib/util/text";

/**
 * Persistent failure log (pipeline_failures). One row per (stage, entity, code) fingerprint;
 * recurring failures increment `occurrences`, successful re-runs resolve them. Retryable
 * failures carry nextRetryAt with bounded exponential backoff for the retry job.
 */

export type FailureInput = {
  stage: PipelineStage;
  code: ErrorCode;
  message?: string;
  entityType: "content_item" | "normalized_review" | "affiliate_link" | "csv_item" | "ingest_run" | "job" | "search_index";
  entityId: string;
  contentItemId?: string;
  normalizedReviewId?: string;
  runId?: string;
  retryable?: boolean;
  maxRetries?: number;
};

type Client = Prisma.TransactionClient | typeof db;

export function backoffMs(retryCount: number): number {
  return Math.min(24 * 3_600_000, 5 * 60_000 * 2 ** Math.min(retryCount, 8));
}

export async function recordFailure(input: FailureInput, client: Client = db) {
  const retryable = input.retryable ?? ERROR_CODES[input.code].retryable;
  const message = (input.message ?? ERROR_CODES[input.code].message).slice(0, 2000);
  const fingerprint = sha256(`${input.stage}|${input.entityType}|${input.entityId}|${input.code}`);
  const now = new Date();
  const existing = await client.pipelineFailure.findUnique({ where: { fingerprint }, select: { retryCount: true } });
  const retryCount = existing?.retryCount ?? 0;
  const row = await client.pipelineFailure.upsert({
    where: { fingerprint },
    create: {
      fingerprint,
      stage: input.stage,
      kind: retryable ? "RETRYABLE_FAILURE" : "PERMANENT_FAILURE",
      errorCode: input.code,
      message,
      entityType: input.entityType,
      entityId: input.entityId,
      contentItemId: input.contentItemId,
      normalizedReviewId: input.normalizedReviewId,
      runId: input.runId,
      maxRetries: input.maxRetries ?? 5,
      nextRetryAt: retryable ? new Date(now.getTime() + backoffMs(0)) : null,
    },
    update: {
      kind: retryable ? "RETRYABLE_FAILURE" : "PERMANENT_FAILURE",
      message,
      runId: input.runId,
      resolvedAt: null,
      occurrences: { increment: 1 },
      lastOccurredAt: now,
      nextRetryAt: retryable ? new Date(now.getTime() + backoffMs(retryCount)) : null,
    },
  });
  log.warn("pipeline failure recorded", { stage: input.stage, code: input.code, entityType: input.entityType, entityId: input.entityId, retryable, message });
  return row;
}

/** Marks failures for an entity/stage as resolved after the stage succeeds. */
export async function resolveFailures(where: { stage: PipelineStage; entityType: string; entityId: string; codes?: ErrorCode[] }, client: Client = db) {
  await client.pipelineFailure.updateMany({
    where: { stage: where.stage, entityType: where.entityType, entityId: where.entityId, resolvedAt: null, ...(where.codes ? { errorCode: { in: where.codes } } : {}) },
    data: { resolvedAt: new Date(), nextRetryAt: null },
  });
}
