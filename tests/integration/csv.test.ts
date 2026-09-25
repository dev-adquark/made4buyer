import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createImportJob, errorReportCsv, processImportJob, retryFailedRows } from "@/lib/csv/import";
import { runIngestion } from "@/lib/pipeline/ingest";
import { publishReview } from "@/lib/pipeline/publish";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { resetDb } from "../support/db";
import { sampleEnvironment } from "../support/pipeline";

const admin = { actor: "admin@test" };
let env: Awaited<ReturnType<typeof sampleEnvironment>>;
beforeAll(async () => {
  await seedTaxonomy();
  env = await sampleEnvironment();
});
afterAll(() => env.close());
beforeEach(async () => {
  await resetDb();
  await runIngestion({ trigger: "test" });
});

const file = (text: string) => ({ name: "overrides.csv", size: Buffer.byteLength(text), type: "text/csv" });

describe("CSV import processor", () => {
  it("validates rows, applies overrides with audit, re-runs stages and supports partial failure", async () => {
    const pixel = await db.normalizedReview.findFirstOrThrow({ where: { sourceId: "s-004" } });
    const gear = await db.normalizedReview.findFirstOrThrow({ where: { sourceId: "s-014" } });
    const vscode = await db.normalizedReview.findFirstOrThrow({ where: { sourceId: "s-008" } });
    const galaxy = await db.normalizedReview.findFirstOrThrow({ where: { sourceId: "s-005" } });
    const mouse = await db.normalizedReview.findFirstOrThrow({ where: { sourceId: "s-010" } });
    await publishReview(pixel.id, admin);
    const csv = [
      "normalized_review_key,override_primary_category,entity_brand_override,entity_product_name_override,sovrn_deal_id_override",
      `${gear.slug},Accessories,Various,Home office desk gear,`,
      `${pixel.id},,,,sv-px-1`,
      `${vscode.dedupeKey},,,,does-not-exist`,
      `${gear.slug},phones,,,`,
      "no-such-review,phones,,,",
      `${galaxy.slug},not-a-category,,,`,
      `${mouse.slug},,,,bad id with spaces`,
      `${pixel.slug},laptops,,,`,
      `,phones,,,`,
    ].join("\n");
    const job = await createImportJob(file(csv), csv, admin);
    expect(job).toMatchObject({ status: "VALIDATED", rowCount: 9, validRows: 3, invalidRows: 6 });
    const codes = (await db.csvImportItem.findMany({ where: { importJobId: job.id }, orderBy: { rowNumber: "asc" } })).map((i) => i.errorCode);
    expect(codes).toEqual([null, null, null, "CSV_DUPLICATE_ROW", "CSV_UNKNOWN_REVIEW", "CSV_INVALID_CATEGORY", "CSV_ROW_INVALID", "CSV_DUPLICATE_ROW", "CSV_ROW_INVALID"]);

    const done = await processImportJob(job.id, admin);
    expect(done).toMatchObject({ status: "COMPLETED_WITH_ERRORS", appliedRows: 2, failedRows: 1 });

    const gearAfter = await db.normalizedReview.findUniqueOrThrow({ where: { id: gear.id }, include: { entities: true } });
    expect(gearAfter).toMatchObject({ categorySlug: "accessories", brand: "Various", productName: "Home office desk gear", classificationConfidence: 1 });
    expect(gearAfter.entities?.lowConfidenceFields).toEqual([]);
    expect(gearAfter.status).toBe("QUEUED");

    const pixelAfter = await db.normalizedReview.findUniqueOrThrow({ where: { id: pixel.id } });
    expect(pixelAfter.sovrnDealIdOverride).toBe("sv-px-1");
    expect(await db.sovrnOfferMatch.findFirst({ where: { normalizedReviewId: pixel.id, isBestOffer: true }, select: { offerId: true } })).toEqual({ offerId: "sv-px-1" });

    const failed = await db.csvImportItem.findFirstOrThrow({ where: { importJobId: job.id, processingStatus: "FAILED" } });
    expect(failed.errorCode).toBe("SOVRN_DEAL_ID_NOT_FOUND");
    expect((await db.normalizedReview.findUniqueOrThrow({ where: { id: vscode.id } })).sovrnDealIdOverride).toBeNull();

    expect(await db.auditLog.count({ where: { action: { in: ["entities.override.csv", "category.override.csv", "deal.override.csv"] } } })).toBeGreaterThanOrEqual(4);
    const report = await errorReportCsv(job.id);
    expect(report.split("\r\n")[0]).toBe("row_number,normalized_review_key,status,error_code,error_reason");
    expect(report).toContain("CSV_UNKNOWN_REVIEW");
    expect(report).toContain("SOVRN_DEAL_ID_NOT_FOUND");

    const retried = await retryFailedRows(job.id, admin);
    expect(retried.failedRows).toBe(1);
    expect((await db.csvImportItem.findUniqueOrThrow({ where: { id: failed.id } })).retryCount).toBe(2);
  });

  it("rejects a file with an invalid header and records the job", async () => {
    const csv = "review,category\nx,phones\n";
    const job = await createImportJob(file(csv), csv, admin);
    expect(job.status).toBe("REJECTED");
    expect(job.headerErrors).toEqual(expect.arrayContaining([expect.stringMatching(/Missing required column/)]));
    await expect(processImportJob(job.id, admin)).rejects.toThrow(/Rejected imports/);
    expect(await errorReportCsv(job.id)).toContain("CSV_HEADER_INVALID");
  });
});
