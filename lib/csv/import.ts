import type { CsvImportItem, Prisma } from "@prisma/client";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { audit, type AuditContext } from "@/lib/security/audit";
import { findReviewByKey, resolveCategorySlug, resolveSubcategorySlug, setCategoryOverride, setDealOverride, setEntityOverrides } from "@/lib/admin/overrides";
import { recordFailure, resolveFailures } from "@/lib/pipeline/failures";
import { processReview, type ReviewStage } from "@/lib/pipeline/process";
import { sovrnConfigured } from "@/lib/sovrn/client";
import { overrideAssignment } from "@/lib/taxonomy/persist";
import { parseCsv, toCsv } from "./parse";

/**
 * Bulk CSV override import:
 *   upload → validate headers → create job → create queue rows (validated per row) →
 *   preview → process (apply overrides, audit, re-run taxonomy / Sovrn / links /
 *   verification) → published pages reflect changes on the next render.
 */

export const REQUIRED_COLUMN = "normalized_review_key";
export const OVERRIDE_COLUMNS = ["override_primary_category", "entity_brand_override", "entity_product_name_override", "sovrn_deal_id_override"] as const;
export const OPTIONAL_COLUMNS = ["override_subcategory", "entity_model_number_override", "entity_device_type_override"] as const;
export const ALL_COLUMNS = [REQUIRED_COLUMN, ...OVERRIDE_COLUMNS, ...OPTIONAL_COLUMNS];

const ACCEPTED_TYPES = new Set(["text/csv", "application/csv", "text/plain", "application/vnd.ms-excel", "application/octet-stream", ""]);
const DEAL_ID = /^[A-Za-z0-9._:\-/]{1,300}$/;

export type UploadValidation = { ok: true; header: string[]; rows: string[][] } | { ok: false; errors: string[] };

export function validateUpload(file: { name: string; size: number; type: string }, text: string): UploadValidation {
  const errors: string[] = [];
  if (!file.name.toLowerCase().endsWith(".csv")) errors.push("File must have a .csv extension");
  if (!ACCEPTED_TYPES.has(file.type.toLowerCase())) errors.push(`Unsupported content type "${file.type}"`);
  if (file.size > config.csv.maxBytes()) errors.push(`File exceeds ${config.csv.maxBytes()} bytes`);
  if (file.size === 0) errors.push("File is empty");
  if (errors.length) return { ok: false, errors };

  const parsed = parseCsv(text, { maxRows: config.csv.maxRows() + 1, maxFieldLength: 2000 });
  if (!parsed.ok) return { ok: false, errors: [`CSV parse error: ${parsed.error}`] };
  if (!parsed.rows.length) return { ok: false, errors: ["CSV has no header row"] };
  const header = parsed.rows[0].map((h) => h.trim().toLowerCase());
  if (!header.includes(REQUIRED_COLUMN)) errors.push(`Missing required column "${REQUIRED_COLUMN}"`);
  if (!header.some((h) => (OVERRIDE_COLUMNS as readonly string[]).includes(h) || (OPTIONAL_COLUMNS as readonly string[]).includes(h))) {
    errors.push(`At least one override column is required: ${[...OVERRIDE_COLUMNS, ...OPTIONAL_COLUMNS].join(", ")}`);
  }
  const unknown = header.filter((h) => !ALL_COLUMNS.includes(h));
  if (unknown.length) errors.push(`Unknown column(s): ${unknown.join(", ")}`);
  const dupes = header.filter((h, i) => header.indexOf(h) !== i);
  if (dupes.length) errors.push(`Duplicate column(s): ${[...new Set(dupes)].join(", ")}`);
  const rows = parsed.rows.slice(1);
  if (!rows.length) errors.push("CSV has no data rows");
  if (rows.length > config.csv.maxRows()) errors.push(`CSV exceeds the ${config.csv.maxRows()} row limit`);
  if (errors.length) return { ok: false, errors };
  return { ok: true, header, rows };
}

type RowInput = {
  rowNumber: number;
  key: string;
  category?: string;
  subcategory?: string;
  brand?: string;
  productName?: string;
  dealId?: string;
  modelNumber?: string;
  deviceType?: string;
};

function readRow(header: string[], cells: string[], rowNumber: number): RowInput {
  const get = (col: string) => {
    const i = header.indexOf(col);
    const v = i >= 0 ? (cells[i] ?? "").trim() : "";
    return v || undefined;
  };
  return {
    rowNumber,
    key: get(REQUIRED_COLUMN) ?? "",
    category: get("override_primary_category"),
    subcategory: get("override_subcategory"),
    brand: get("entity_brand_override"),
    productName: get("entity_product_name_override"),
    dealId: get("sovrn_deal_id_override"),
    modelNumber: get("entity_model_number_override"),
    deviceType: get("entity_device_type_override"),
  };
}

/** Creates the import job and its queue rows. Row-level problems are recorded per row (partial failure support). */
export async function createImportJob(file: { name: string; size: number; type: string }, text: string, ctx: AuditContext) {
  const v = validateUpload(file, text);
  if (!v.ok) {
    const job = await db.csvImportJob.create({ data: { fileName: file.name.slice(0, 200), fileSize: file.size, status: "REJECTED", headerErrors: v.errors, uploadedBy: ctx.actor } });
    await audit(ctx, { action: "csv.upload_rejected", entityType: "csv_import_job", entityId: job.id, metadata: { errors: v.errors } });
    return job;
  }

  const seen = new Map<string, number>();
  const items: Prisma.CsvImportItemCreateManyJobInput[] = [];
  for (const [index, cells] of v.rows.entries()) {
    const rowNumber = index + 2; // 1-based incl. header
    const r = readRow(v.header, cells, rowNumber);
    let errorCode: string | undefined;
    let errorReason: string | undefined;
    let reviewId: string | undefined;
    let categorySlug: string | undefined;
    let subcategorySlug: string | undefined;

    if (cells.length > v.header.length) {
      errorCode = "CSV_ROW_INVALID";
      errorReason = `Row has ${cells.length} fields; header has ${v.header.length}`;
    } else if (!r.key) {
      errorCode = "CSV_ROW_INVALID";
      errorReason = "normalized_review_key is empty";
    } else if (!r.category && !r.subcategory && !r.brand && !r.productName && !r.dealId && !r.modelNumber && !r.deviceType) {
      errorCode = "CSV_ROW_INVALID";
      errorReason = "Row has no override values";
    } else {
      const review = await findReviewByKey(r.key);
      if (!review) {
        errorCode = "CSV_UNKNOWN_REVIEW";
        errorReason = `No review matches id, slug or dedupe key "${r.key}"`;
      } else if (seen.has(review.id)) {
        // Duplicates are detected on the resolved review, so an id and a slug for the same review collide.
        errorCode = "CSV_DUPLICATE_ROW";
        errorReason = `Duplicate of row ${seen.get(review.id)} for the same review`;
      } else {
        seen.set(review.id, rowNumber);
        reviewId = review.id;
        if (r.category) {
          categorySlug = resolveCategorySlug(r.category);
          if (!categorySlug) {
            errorCode = "CSV_INVALID_CATEGORY";
            errorReason = `Unknown category "${r.category}"`;
          }
        }
        if (!errorCode && r.subcategory) {
          const parent = categorySlug ?? (await db.normalizedReview.findUnique({ where: { id: review.id }, select: { categorySlug: true } }))?.categorySlug;
          subcategorySlug = parent ? resolveSubcategorySlug(parent, r.subcategory) : undefined;
          if (!subcategorySlug) {
            errorCode = "CSV_INVALID_CATEGORY";
            errorReason = `Unknown subcategory "${r.subcategory}" for category "${parent ?? "none"}"`;
          }
        }
        if (!errorCode && r.dealId && !DEAL_ID.test(r.dealId)) {
          errorCode = "CSV_ROW_INVALID";
          errorReason = "sovrn_deal_id_override contains invalid characters";
        }
        for (const [name, value, max] of [["entity_brand_override", r.brand, 80], ["entity_product_name_override", r.productName, 160], ["entity_model_number_override", r.modelNumber, 80], ["entity_device_type_override", r.deviceType, 80]] as const) {
          if (!errorCode && value && value.length > max) {
            errorCode = "CSV_ROW_INVALID";
            errorReason = `${name} exceeds ${max} characters`;
          }
        }
      }
    }

    items.push({
      rowNumber,
      normalizedReviewKey: r.key.slice(0, 300) || "(empty)",
      normalizedReviewId: reviewId ?? null,
      overridePrimaryCategory: categorySlug ?? r.category ?? null,
      entityBrandOverride: r.brand ?? null,
      entityProductNameOverride: r.productName ?? null,
      sovrnDealIdOverride: r.dealId ?? null,
      extraOverrides: subcategorySlug || r.subcategory || r.modelNumber || r.deviceType ? { subcategory: subcategorySlug ?? r.subcategory, modelNumber: r.modelNumber, deviceType: r.deviceType } : undefined,
      processingStatus: errorCode ? "INVALID" : "PENDING",
      errorCode: errorCode ?? null,
      errorReason: errorReason ?? null,
    });
  }

  const invalid = items.filter((i) => i.processingStatus === "INVALID").length;
  const job = await db.csvImportJob.create({
    data: {
      fileName: file.name.slice(0, 200),
      fileSize: file.size,
      rowCount: items.length,
      status: "VALIDATED",
      validRows: items.length - invalid,
      invalidRows: invalid,
      uploadedBy: ctx.actor,
      items: { createMany: { data: items } },
    },
  });
  await audit(ctx, { action: "csv.upload", entityType: "csv_import_job", entityId: job.id, metadata: { fileName: file.name, rows: items.length, invalid } });
  return job;
}

async function applyItem(item: CsvImportItem, ctx: AuditContext): Promise<{ note?: string }> {
  if (!item.normalizedReviewId) throw new Error("Row has no resolved review");
  const reviewId = item.normalizedReviewId;
  const extra = (item.extraOverrides ?? {}) as { subcategory?: string; modelNumber?: string; deviceType?: string };
  let from: ReviewStage | undefined;
  const earliest = (stage: ReviewStage) => {
    const order: ReviewStage[] = ["ENTITY_EXTRACTION", "TAXONOMY", "OFFER_MATCHING"];
    if (!from || order.indexOf(stage) < order.indexOf(from)) from = stage;
  };

  const entityValues: Record<string, string> = {};
  if (item.entityBrandOverride) entityValues.brand = item.entityBrandOverride;
  if (item.entityProductNameOverride) entityValues.productName = item.entityProductNameOverride;
  if (extra.modelNumber) entityValues.modelNumber = extra.modelNumber;
  if (extra.deviceType) entityValues.deviceType = extra.deviceType;
  if (Object.keys(entityValues).length) {
    await setEntityOverrides(reviewId, entityValues, ctx, "CSV");
    earliest("ENTITY_EXTRACTION");
  }
  if (item.overridePrimaryCategory) {
    await setCategoryOverride(reviewId, item.overridePrimaryCategory, extra.subcategory, ctx, "CSV");
    earliest("TAXONOMY");
  } else if (extra.subcategory) {
    await overrideAssignment(reviewId, "SUBCATEGORY", extra.subcategory, ctx.actor, "CSV");
    earliest("TAXONOMY");
  }
  let previousDeal: string | null | undefined;
  if (item.sovrnDealIdOverride) {
    previousDeal = await setDealOverride(reviewId, item.sovrnDealIdOverride, ctx, "CSV");
    earliest("OFFER_MATCHING");
  }

  const summary = await processReview(reviewId, { from: from ?? "TAXONOMY", skipImage: true, bypassOfferCache: Boolean(item.sovrnDealIdOverride) });

  if (item.sovrnDealIdOverride) {
    if (!sovrnConfigured()) return { note: "Deal ID override stored; Sovrn matching BLOCKED_BY_ENVIRONMENT until credentials are configured" };
    const best = await db.sovrnOfferMatch.findFirst({ where: { normalizedReviewId: reviewId, isBestOffer: true }, select: { offerId: true } });
    if (best?.offerId !== item.sovrnDealIdOverride) {
      // Invalid deal ID: revert so a working deal is not replaced by a missing one.
      await setDealOverride(reviewId, previousDeal ?? null, ctx, "CSV");
      await processReview(reviewId, { from: "OFFER_MATCHING", skipImage: true });
      throw Object.assign(new Error(`Sovrn deal ID "${item.sovrnDealIdOverride}" was not returned by Sovrn for this product (${summary.dealStatus ?? "unknown"}); override reverted`), { code: "SOVRN_DEAL_ID_NOT_FOUND" });
    }
  }
  return {};
}

/** Processes pending (and retry-requested) rows of a job, bounded per call. */
export async function processImportJob(jobId: string, ctx: AuditContext, limit = 100) {
  const job = await db.csvImportJob.findUniqueOrThrow({ where: { id: jobId } });
  if (job.status === "REJECTED") throw new Error("Rejected imports cannot be processed");
  await db.csvImportJob.update({ where: { id: jobId }, data: { status: "PROCESSING", startedAt: job.startedAt ?? new Date() } });
  const items = await db.csvImportItem.findMany({ where: { importJobId: jobId, processingStatus: "PENDING" }, orderBy: { rowNumber: "asc" }, take: limit });
  for (const item of items) {
    await db.csvImportItem.update({ where: { id: item.id }, data: { processingStatus: "PROCESSING" } });
    try {
      const { note } = await applyItem(item, ctx);
      await db.csvImportItem.update({ where: { id: item.id }, data: { processingStatus: "APPLIED", processedAt: new Date(), errorCode: null, errorReason: note ?? null } });
      await resolveFailures({ stage: "CSV_IMPORT", entityType: "csv_item", entityId: item.id });
    } catch (error) {
      const code = (error as { code?: string }).code === "SOVRN_DEAL_ID_NOT_FOUND" ? "SOVRN_DEAL_ID_NOT_FOUND" : "CSV_APPLY_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      await db.csvImportItem.update({ where: { id: item.id }, data: { processingStatus: "FAILED", processedAt: new Date(), errorCode: code, errorReason: message.slice(0, 1000), retryCount: { increment: 1 } } });
      await recordFailure({ stage: "CSV_IMPORT", code, message, entityType: "csv_item", entityId: item.id, normalizedReviewId: item.normalizedReviewId ?? undefined, retryable: false });
      log.warn("csv row failed", { stage: "CSV_IMPORT", jobId, row: item.rowNumber, code, message });
    }
  }
  return finalizeJob(jobId);
}

export async function finalizeJob(jobId: string) {
  const grouped = await db.csvImportItem.groupBy({ by: ["processingStatus"], where: { importJobId: jobId }, _count: { _all: true } });
  const count = (s: string) => grouped.find((g) => g.processingStatus === s)?._count._all ?? 0;
  const pending = count("PENDING") + count("PROCESSING");
  const failed = count("FAILED");
  const invalid = count("INVALID");
  return db.csvImportJob.update({
    where: { id: jobId },
    data: {
      appliedRows: count("APPLIED"),
      failedRows: failed,
      invalidRows: invalid,
      status: pending ? "PROCESSING" : failed || invalid ? "COMPLETED_WITH_ERRORS" : "COMPLETED",
      completedAt: pending ? null : new Date(),
    },
  });
}

/** Re-queues FAILED rows (bounded retries) for another processing pass. */
export async function retryFailedRows(jobId: string, ctx: AuditContext, maxRetries = 3) {
  const res = await db.csvImportItem.updateMany({ where: { importJobId: jobId, processingStatus: "FAILED", retryCount: { lt: maxRetries } }, data: { processingStatus: "PENDING" } });
  await audit(ctx, { action: "csv.retry", entityType: "csv_import_job", entityId: jobId, metadata: { requeued: res.count } });
  return processImportJob(jobId, ctx);
}

export async function errorReportCsv(jobId: string): Promise<string> {
  const job = await db.csvImportJob.findUniqueOrThrow({ where: { id: jobId } });
  const header = ["row_number", "normalized_review_key", "status", "error_code", "error_reason"];
  if (job.status === "REJECTED") {
    return toCsv(header, ((job.headerErrors ?? []) as string[]).map((e) => ["header", "", "REJECTED", "CSV_HEADER_INVALID", e]));
  }
  const items = await db.csvImportItem.findMany({ where: { importJobId: jobId, OR: [{ processingStatus: { in: ["INVALID", "FAILED"] } }, { errorReason: { not: null } }] }, orderBy: { rowNumber: "asc" } });
  return toCsv(header, items.map((i) => [i.rowNumber, i.normalizedReviewKey, i.processingStatus, i.errorCode ?? "", i.errorReason ?? ""]));
}
