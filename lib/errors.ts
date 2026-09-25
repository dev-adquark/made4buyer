/**
 * Failure reason codes used across every pipeline stage. Codes are persisted on
 * pipeline_failures, content_items, publish_jobs and csv_import_queue rows.
 */

export const ERROR_CODES = {
  CONTENT_API_NOT_CONFIGURED: { retryable: false, message: "CONTENT_API_URL is not configured" },
  CONTENT_API_TIMEOUT: { retryable: true, message: "Content API request timed out" },
  CONTENT_API_HTTP_ERROR: { retryable: true, message: "Content API returned an error status" },
  CONTENT_API_RESPONSE_INVALID: { retryable: false, message: "Content API response shape is invalid" },
  CONTENT_SCHEMA_INVALID: { retryable: false, message: "Content item failed schema validation" },
  DUPLICATE_REVIEW: { retryable: false, message: "Content item duplicates an existing review" },
  ENTITY_EXTRACTION_LOW_CONFIDENCE: { retryable: false, message: "Entity extraction confidence below threshold" },
  NO_CATEGORY_MATCH: { retryable: false, message: "No taxonomy category matched" },
  CATEGORY_LOW_CONFIDENCE: { retryable: false, message: "Category confidence below auto-accept threshold" },
  SOVRN_NOT_CONFIGURED: { retryable: false, message: "Sovrn credentials are not configured (BLOCKED_BY_ENVIRONMENT)" },
  SOVRN_NO_MATCH: { retryable: false, message: "No Sovrn offer matched the product" },
  SOVRN_TIMEOUT: { retryable: true, message: "Sovrn request timed out" },
  SOVRN_PROVIDER_ERROR: { retryable: true, message: "Sovrn returned an error" },
  SOVRN_RESPONSE_INVALID: { retryable: false, message: "Sovrn response shape is invalid" },
  SOVRN_DEAL_ID_NOT_FOUND: { retryable: false, message: "Overridden Sovrn deal ID not present in provider results" },
  AFFILIATE_URL_INVALID: { retryable: false, message: "Affiliate URL could not be generated or is invalid" },
  LINK_VERIFICATION_TIMEOUT: { retryable: true, message: "Affiliate link verification timed out" },
  LINK_VERIFICATION_FAILED: { retryable: true, message: "Affiliate link verification failed" },
  IMAGE_ENRICHMENT_FAILED: { retryable: true, message: "Image enrichment failed; placeholder used" },
  LICENSE_UNVERIFIED: { retryable: false, message: "Image license could not be verified" },
  PAGE_RENDER_FAILED: { retryable: true, message: "Page render model could not be built" },
  PUBLISH_QA_FAILED: { retryable: false, message: "Review failed publish QA gates" },
  CSV_ROW_INVALID: { retryable: false, message: "CSV row failed validation" },
  CSV_UNKNOWN_REVIEW: { retryable: false, message: "CSV row references an unknown review" },
  CSV_INVALID_CATEGORY: { retryable: false, message: "CSV row references an unknown category" },
  CSV_DUPLICATE_ROW: { retryable: false, message: "CSV row duplicates an earlier row for the same review" },
  CSV_APPLY_FAILED: { retryable: true, message: "CSV overrides could not be applied" },
  GSC_NOT_CONFIGURED: { retryable: false, message: "Search Console is not configured (NOT_AVAILABLE_IN_ENVIRONMENT)" },
  GSC_INSPECTION_FAILED: { retryable: true, message: "Search Console URL inspection failed" },
  UNEXPECTED_ERROR: { retryable: true, message: "Unexpected error" },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class PipelineError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message?: string, details?: Record<string, unknown>, retryable?: boolean) {
    super(message ?? ERROR_CODES[code].message);
    this.name = "PipelineError";
    this.code = code;
    this.retryable = retryable ?? ERROR_CODES[code].retryable;
    this.details = details;
  }
}

export function toPipelineError(error: unknown, fallback: ErrorCode = "UNEXPECTED_ERROR"): PipelineError {
  if (error instanceof PipelineError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new PipelineError(fallback, message);
}

export function isErrorCode(value: string): value is ErrorCode {
  return value in ERROR_CODES;
}
