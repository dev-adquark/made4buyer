-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "run_status" AS ENUM ('RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "content_processing_status" AS ENUM ('INGESTED', 'NORMALIZED', 'DUPLICATE', 'FAILED', 'QUEUED', 'PUBLISHED', 'REJECTED');

-- CreateEnum
CREATE TYPE "review_status" AS ENUM ('NEEDS_REVIEW', 'QUEUED', 'PUBLISHED', 'UNPUBLISHED', 'REJECTED');

-- CreateEnum
CREATE TYPE "tag_type" AS ENUM ('CATEGORY', 'SUBCATEGORY', 'INTENT', 'PLATFORM', 'PRICE_TIER');

-- CreateEnum
CREATE TYPE "assignment_source" AS ENUM ('RULES', 'SOURCE_FIELD', 'ADMIN', 'CSV');

-- CreateEnum
CREATE TYPE "assignment_review_state" AS ENUM ('UNREVIEWED', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "deal_status" AS ENUM ('PENDING', 'MATCHED', 'NO_MATCH', 'STALE', 'FAILED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "offer_match_status" AS ENUM ('MATCHED', 'BELOW_THRESHOLD', 'STALE', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "link_generation_method" AS ENUM ('PROVIDER_DEEPLINK', 'LINK_WRAPPER');

-- CreateEnum
CREATE TYPE "link_verification_status" AS ENUM ('PENDING', 'VERIFIED_OK', 'REDIRECT_MISMATCH', 'FORBIDDEN', 'BLOCKED', 'UNAVAILABLE', 'TIMEOUT', 'INVALID', 'PROVIDER_ERROR');

-- CreateEnum
CREATE TYPE "image_source_type" AS ENUM ('CONTENT_API', 'ENRICHMENT_SERVICE', 'PLACEHOLDER');

-- CreateEnum
CREATE TYPE "license_state" AS ENUM ('VERIFIED', 'PROVIDER_ASSERTED', 'UNVERIFIED', 'OWNED_PLACEHOLDER');

-- CreateEnum
CREATE TYPE "enrichment_status" AS ENUM ('ENRICHED', 'FALLBACK', 'FAILED');

-- CreateEnum
CREATE TYPE "publish_action" AS ENUM ('PUBLISH', 'UNPUBLISH');

-- CreateEnum
CREATE TYPE "publish_job_status" AS ENUM ('SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "csv_job_status" AS ENUM ('VALIDATED', 'REJECTED', 'PROCESSING', 'COMPLETED', 'COMPLETED_WITH_ERRORS');

-- CreateEnum
CREATE TYPE "csv_item_status" AS ENUM ('PENDING', 'INVALID', 'PROCESSING', 'APPLIED', 'FAILED');

-- CreateEnum
CREATE TYPE "pipeline_stage" AS ENUM ('CONTENT_FETCH', 'VALIDATION', 'NORMALIZATION', 'DEDUPE', 'ENTITY_EXTRACTION', 'TAXONOMY', 'IMAGE_ENRICHMENT', 'OFFER_MATCHING', 'AFFILIATE_LINK', 'LINK_VERIFICATION', 'PAGE_RENDER', 'PUBLISH', 'CSV_IMPORT', 'REVALIDATION', 'INDEX_INSPECTION');

-- CreateEnum
CREATE TYPE "failure_kind" AS ENUM ('RETRYABLE_FAILURE', 'PERMANENT_FAILURE');

-- CreateEnum
CREATE TYPE "revalidation_type" AS ENUM ('OFFER_REFRESH', 'LINK_VERIFICATION', 'CACHE_CLEANUP', 'FAILED_RETRY', 'PUBLISH_CYCLE', 'INDEX_INSPECTION');

-- CreateEnum
CREATE TYPE "sponsored_position" AS ENUM ('HOME_HERO', 'CATEGORY_TOP', 'REVIEW_SIDEBAR');

-- CreateEnum
CREATE TYPE "index_verdict" AS ENUM ('INDEXED', 'NOT_INDEXED', 'UNKNOWN', 'ERROR');

-- CreateTable
CREATE TABLE "review_ingest_runs" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "status" "run_status" NOT NULL DEFAULT 'RUNNING',
    "source" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "totalFetched" INTEGER NOT NULL DEFAULT 0,
    "normalizedCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "unchangedCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "failedNormalizationCount" INTEGER NOT NULL DEFAULT 0,
    "queuedCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "failureReasonSummary" JSONB,
    "duplicateItems" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_ingest_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_items" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "rawPayload" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processingStatus" "content_processing_status" NOT NULL DEFAULT 'INGESTED',
    "statusReason" TEXT,
    "errorCode" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "dedupeKey" TEXT,
    "ingestRunId" TEXT,
    "normalizedReviewId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "normalized_reviews" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "canonicalUrl" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "canonicalTitle" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "brand" TEXT,
    "brandSlug" TEXT,
    "summary" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "author" TEXT,
    "sourcePublishedAt" TIMESTAMP(3),
    "entityConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "classificationConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "categorySlug" TEXT,
    "subcategorySlug" TEXT,
    "status" "review_status" NOT NULL DEFAULT 'NEEDS_REVIEW',
    "statusReason" TEXT,
    "qaFailures" JSONB,
    "manualEditLocked" BOOLEAN NOT NULL DEFAULT false,
    "dealStatus" "deal_status" NOT NULL DEFAULT 'PENDING',
    "dealStatusReason" TEXT,
    "dealCheckedAt" TIMESTAMP(3),
    "sovrnDealIdOverride" TEXT,
    "publishedAt" TIMESTAMP(3),
    "unpublishedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "normalized_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extracted_entities" (
    "id" TEXT NOT NULL,
    "normalizedReviewId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "brand" TEXT,
    "deviceType" TEXT,
    "useCase" TEXT,
    "platform" TEXT,
    "price" DOUBLE PRECISION,
    "currency" TEXT,
    "modelNumber" TEXT,
    "source" TEXT NOT NULL,
    "publishDate" TIMESTAMP(3),
    "rating" DOUBLE PRECISION,
    "ratingScale" DOUBLE PRECISION,
    "confidences" JSONB NOT NULL,
    "overrides" JSONB,
    "lowConfidenceFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "overallConfidence" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "extracted_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_tags" (
    "id" TEXT NOT NULL,
    "type" "tag_type" NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "parentId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "category_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_category_assignments" (
    "id" TEXT NOT NULL,
    "normalizedReviewId" TEXT NOT NULL,
    "categoryTagId" TEXT NOT NULL,
    "tagType" "tag_type" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "source" "assignment_source" NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isOverride" BOOLEAN NOT NULL DEFAULT false,
    "overrideSource" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "reviewState" "assignment_review_state" NOT NULL DEFAULT 'UNREVIEWED',
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_category_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sovrn_offers_cache" (
    "id" TEXT NOT NULL,
    "queryKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "rawResponse" JSONB,
    "providerStatus" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sovrn_offers_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sovrn_offer_matches" (
    "id" TEXT NOT NULL,
    "normalizedReviewId" TEXT NOT NULL,
    "cacheId" TEXT,
    "offerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "merchantName" TEXT,
    "merchantId" TEXT,
    "offerUrl" TEXT NOT NULL,
    "providerAffiliateUrl" TEXT,
    "price" DOUBLE PRECISION,
    "currency" TEXT,
    "availability" TEXT,
    "imageUrl" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "scoreBreakdown" JSONB NOT NULL,
    "isBestOffer" BOOLEAN NOT NULL DEFAULT false,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "matchStatus" "offer_match_status" NOT NULL DEFAULT 'MATCHED',
    "selectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sovrn_offer_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliate_links" (
    "id" TEXT NOT NULL,
    "normalizedReviewId" TEXT NOT NULL,
    "offerMatchId" TEXT,
    "sovrnOfferId" TEXT NOT NULL,
    "affiliateUrl" TEXT NOT NULL,
    "destinationUrl" TEXT,
    "generationMethod" "link_generation_method" NOT NULL,
    "isBest" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "verificationStatus" "link_verification_status" NOT NULL DEFAULT 'PENDING',
    "verificationReason" TEXT,
    "httpStatus" INTEGER,
    "redirectChain" JSONB,
    "finalUrl" TEXT,
    "verificationAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastVerifiedAt" TIMESTAMP(3),
    "nextVerificationAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "affiliate_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "image_assets" (
    "id" TEXT NOT NULL,
    "normalizedReviewId" TEXT NOT NULL,
    "sourceType" "image_source_type" NOT NULL,
    "sourceUrl" TEXT,
    "cdnUrl" TEXT,
    "contentType" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "licenseState" "license_state" NOT NULL,
    "license" TEXT,
    "attribution" TEXT,
    "enrichmentStatus" "enrichment_status" NOT NULL,
    "isFallback" BOOLEAN NOT NULL DEFAULT false,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "failureReason" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "image_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_render_models" (
    "id" TEXT NOT NULL,
    "normalizedReviewId" TEXT NOT NULL,
    "model" JSONB NOT NULL,
    "modelHash" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "builtAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_render_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_jobs" (
    "id" TEXT NOT NULL,
    "normalizedReviewId" TEXT NOT NULL,
    "action" "publish_action" NOT NULL,
    "status" "publish_job_status" NOT NULL,
    "trigger" TEXT NOT NULL,
    "actor" TEXT,
    "qaFailures" JSONB,
    "errorCode" TEXT,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publish_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revalidation_runs" (
    "id" TEXT NOT NULL,
    "type" "revalidation_type" NOT NULL,
    "status" "run_status" NOT NULL DEFAULT 'RUNNING',
    "trigger" TEXT NOT NULL,
    "actor" TEXT,
    "rangeStart" TIMESTAMP(3),
    "rangeEnd" TIMESTAMP(3),
    "checkedCount" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "reasonBreakdown" JSONB,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "revalidation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_failures" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "stage" "pipeline_stage" NOT NULL,
    "kind" "failure_kind" NOT NULL,
    "errorCode" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "contentItemId" TEXT,
    "normalizedReviewId" TEXT,
    "runId" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 5,
    "nextRetryAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "lastOccurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_failures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_locks" (
    "name" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_locks_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "analytics_events" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "normalizedReviewId" TEXT,
    "categorySlug" TEXT,
    "sessionId" TEXT,
    "path" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sponsored_placements" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "advertiser" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Sponsored',
    "disclosure" TEXT NOT NULL,
    "categorySlug" TEXT,
    "position" "sponsored_position" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "minMonthlyPageViews" INTEGER NOT NULL DEFAULT 1000,
    "minMonthlySessions" INTEGER NOT NULL DEFAULT 250,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sponsored_placements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_index_checks" (
    "id" TEXT NOT NULL,
    "normalizedReviewId" TEXT,
    "url" TEXT NOT NULL,
    "verdict" "index_verdict" NOT NULL,
    "coverageState" TEXT,
    "lastCrawlTime" TIMESTAMP(3),
    "error" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_index_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "csv_import_jobs" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "status" "csv_job_status" NOT NULL,
    "headerErrors" JSONB,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "appliedRows" INTEGER NOT NULL DEFAULT 0,
    "failedRows" INTEGER NOT NULL DEFAULT 0,
    "uploadedBy" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "csv_import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "csv_import_queue" (
    "id" TEXT NOT NULL,
    "importJobId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "normalizedReviewKey" TEXT NOT NULL,
    "normalizedReviewId" TEXT,
    "overridePrimaryCategory" TEXT,
    "entityBrandOverride" TEXT,
    "entityProductNameOverride" TEXT,
    "sovrnDealIdOverride" TEXT,
    "extraOverrides" JSONB,
    "processingStatus" "csv_item_status" NOT NULL DEFAULT 'PENDING',
    "errorCode" TEXT,
    "errorReason" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "csv_import_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_sessions" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit_buckets" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "day30_reports" (
    "id" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatedBy" TEXT NOT NULL,
    "json" JSONB NOT NULL,
    "html" TEXT NOT NULL,

    CONSTRAINT "day30_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "review_ingest_runs_startedAt_idx" ON "review_ingest_runs"("startedAt");

-- CreateIndex
CREATE INDEX "review_ingest_runs_status_idx" ON "review_ingest_runs"("status");

-- CreateIndex
CREATE INDEX "content_items_processingStatus_idx" ON "content_items"("processingStatus");

-- CreateIndex
CREATE INDEX "content_items_contentHash_idx" ON "content_items"("contentHash");

-- CreateIndex
CREATE INDEX "content_items_normalizedReviewId_idx" ON "content_items"("normalizedReviewId");

-- CreateIndex
CREATE INDEX "content_items_ingestRunId_idx" ON "content_items"("ingestRunId");

-- CreateIndex
CREATE INDEX "content_items_createdAt_idx" ON "content_items"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "content_items_source_sourceId_key" ON "content_items"("source", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "normalized_reviews_dedupeKey_key" ON "normalized_reviews"("dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "normalized_reviews_slug_key" ON "normalized_reviews"("slug");

-- CreateIndex
CREATE INDEX "normalized_reviews_status_publishedAt_idx" ON "normalized_reviews"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "normalized_reviews_categorySlug_status_publishedAt_idx" ON "normalized_reviews"("categorySlug", "status", "publishedAt");

-- CreateIndex
CREATE INDEX "normalized_reviews_brandSlug_status_idx" ON "normalized_reviews"("brandSlug", "status");

-- CreateIndex
CREATE INDEX "normalized_reviews_confidence_idx" ON "normalized_reviews"("confidence");

-- CreateIndex
CREATE INDEX "normalized_reviews_dealStatus_idx" ON "normalized_reviews"("dealStatus");

-- CreateIndex
CREATE INDEX "normalized_reviews_canonicalUrl_idx" ON "normalized_reviews"("canonicalUrl");

-- CreateIndex
CREATE INDEX "normalized_reviews_createdAt_idx" ON "normalized_reviews"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "normalized_reviews_source_sourceId_key" ON "normalized_reviews"("source", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "extracted_entities_normalizedReviewId_key" ON "extracted_entities"("normalizedReviewId");

-- CreateIndex
CREATE INDEX "extracted_entities_overallConfidence_idx" ON "extracted_entities"("overallConfidence");

-- CreateIndex
CREATE INDEX "category_tags_type_active_idx" ON "category_tags"("type", "active");

-- CreateIndex
CREATE UNIQUE INDEX "category_tags_type_slug_key" ON "category_tags"("type", "slug");

-- CreateIndex
CREATE INDEX "review_category_assignments_normalizedReviewId_active_idx" ON "review_category_assignments"("normalizedReviewId", "active");

-- CreateIndex
CREATE INDEX "review_category_assignments_categoryTagId_active_idx" ON "review_category_assignments"("categoryTagId", "active");

-- CreateIndex
CREATE INDEX "review_category_assignments_tagType_active_confidence_idx" ON "review_category_assignments"("tagType", "active", "confidence");

-- CreateIndex
CREATE INDEX "review_category_assignments_reviewState_idx" ON "review_category_assignments"("reviewState");

-- CreateIndex
CREATE INDEX "review_category_assignments_createdAt_idx" ON "review_category_assignments"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "sovrn_offers_cache_requestHash_key" ON "sovrn_offers_cache"("requestHash");

-- CreateIndex
CREATE INDEX "sovrn_offers_cache_expiresAt_idx" ON "sovrn_offers_cache"("expiresAt");

-- CreateIndex
CREATE INDEX "sovrn_offers_cache_queryKey_idx" ON "sovrn_offers_cache"("queryKey");

-- CreateIndex
CREATE INDEX "sovrn_offer_matches_normalizedReviewId_isBestOffer_idx" ON "sovrn_offer_matches"("normalizedReviewId", "isBestOffer");

-- CreateIndex
CREATE INDEX "sovrn_offer_matches_matchStatus_idx" ON "sovrn_offer_matches"("matchStatus");

-- CreateIndex
CREATE UNIQUE INDEX "sovrn_offer_matches_normalizedReviewId_offerId_key" ON "sovrn_offer_matches"("normalizedReviewId", "offerId");

-- CreateIndex
CREATE INDEX "affiliate_links_normalizedReviewId_isActive_idx" ON "affiliate_links"("normalizedReviewId", "isActive");

-- CreateIndex
CREATE INDEX "affiliate_links_verificationStatus_idx" ON "affiliate_links"("verificationStatus");

-- CreateIndex
CREATE INDEX "affiliate_links_nextVerificationAt_idx" ON "affiliate_links"("nextVerificationAt");

-- CreateIndex
CREATE INDEX "affiliate_links_lastVerifiedAt_idx" ON "affiliate_links"("lastVerifiedAt");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_links_normalizedReviewId_sovrnOfferId_key" ON "affiliate_links"("normalizedReviewId", "sovrnOfferId");

-- CreateIndex
CREATE INDEX "image_assets_normalizedReviewId_isPrimary_idx" ON "image_assets"("normalizedReviewId", "isPrimary");

-- CreateIndex
CREATE INDEX "image_assets_enrichmentStatus_idx" ON "image_assets"("enrichmentStatus");

-- CreateIndex
CREATE INDEX "image_assets_licenseState_idx" ON "image_assets"("licenseState");

-- CreateIndex
CREATE UNIQUE INDEX "page_render_models_normalizedReviewId_key" ON "page_render_models"("normalizedReviewId");

-- CreateIndex
CREATE INDEX "publish_jobs_normalizedReviewId_createdAt_idx" ON "publish_jobs"("normalizedReviewId", "createdAt");

-- CreateIndex
CREATE INDEX "publish_jobs_status_createdAt_idx" ON "publish_jobs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "revalidation_runs_type_startedAt_idx" ON "revalidation_runs"("type", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "pipeline_failures_fingerprint_key" ON "pipeline_failures"("fingerprint");

-- CreateIndex
CREATE INDEX "pipeline_failures_stage_errorCode_idx" ON "pipeline_failures"("stage", "errorCode");

-- CreateIndex
CREATE INDEX "pipeline_failures_resolvedAt_kind_nextRetryAt_idx" ON "pipeline_failures"("resolvedAt", "kind", "nextRetryAt");

-- CreateIndex
CREATE INDEX "pipeline_failures_normalizedReviewId_idx" ON "pipeline_failures"("normalizedReviewId");

-- CreateIndex
CREATE INDEX "pipeline_failures_lastOccurredAt_idx" ON "pipeline_failures"("lastOccurredAt");

-- CreateIndex
CREATE INDEX "analytics_events_event_createdAt_idx" ON "analytics_events"("event", "createdAt");

-- CreateIndex
CREATE INDEX "analytics_events_categorySlug_event_createdAt_idx" ON "analytics_events"("categorySlug", "event", "createdAt");

-- CreateIndex
CREATE INDEX "analytics_events_normalizedReviewId_createdAt_idx" ON "analytics_events"("normalizedReviewId", "createdAt");

-- CreateIndex
CREATE INDEX "analytics_events_sessionId_createdAt_idx" ON "analytics_events"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "sponsored_placements_enabled_position_categorySlug_idx" ON "sponsored_placements"("enabled", "position", "categorySlug");

-- CreateIndex
CREATE INDEX "search_index_checks_url_checkedAt_idx" ON "search_index_checks"("url", "checkedAt");

-- CreateIndex
CREATE INDEX "search_index_checks_checkedAt_idx" ON "search_index_checks"("checkedAt");

-- CreateIndex
CREATE INDEX "csv_import_jobs_createdAt_idx" ON "csv_import_jobs"("createdAt");

-- CreateIndex
CREATE INDEX "csv_import_queue_processingStatus_idx" ON "csv_import_queue"("processingStatus");

-- CreateIndex
CREATE INDEX "csv_import_queue_normalizedReviewId_idx" ON "csv_import_queue"("normalizedReviewId");

-- CreateIndex
CREATE UNIQUE INDEX "csv_import_queue_importJobId_rowNumber_key" ON "csv_import_queue"("importJobId", "rowNumber");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "admin_sessions_expiresAt_idx" ON "admin_sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "day30_reports_generatedAt_idx" ON "day30_reports"("generatedAt");

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_ingestRunId_fkey" FOREIGN KEY ("ingestRunId") REFERENCES "review_ingest_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_normalizedReviewId_fkey" FOREIGN KEY ("normalizedReviewId") REFERENCES "normalized_reviews"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_entities" ADD CONSTRAINT "extracted_entities_normalizedReviewId_fkey" FOREIGN KEY ("normalizedReviewId") REFERENCES "normalized_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_tags" ADD CONSTRAINT "category_tags_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "category_tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_category_assignments" ADD CONSTRAINT "review_category_assignments_normalizedReviewId_fkey" FOREIGN KEY ("normalizedReviewId") REFERENCES "normalized_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_category_assignments" ADD CONSTRAINT "review_category_assignments_categoryTagId_fkey" FOREIGN KEY ("categoryTagId") REFERENCES "category_tags"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sovrn_offer_matches" ADD CONSTRAINT "sovrn_offer_matches_normalizedReviewId_fkey" FOREIGN KEY ("normalizedReviewId") REFERENCES "normalized_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sovrn_offer_matches" ADD CONSTRAINT "sovrn_offer_matches_cacheId_fkey" FOREIGN KEY ("cacheId") REFERENCES "sovrn_offers_cache"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_links" ADD CONSTRAINT "affiliate_links_normalizedReviewId_fkey" FOREIGN KEY ("normalizedReviewId") REFERENCES "normalized_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_links" ADD CONSTRAINT "affiliate_links_offerMatchId_fkey" FOREIGN KEY ("offerMatchId") REFERENCES "sovrn_offer_matches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_assets" ADD CONSTRAINT "image_assets_normalizedReviewId_fkey" FOREIGN KEY ("normalizedReviewId") REFERENCES "normalized_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_render_models" ADD CONSTRAINT "page_render_models_normalizedReviewId_fkey" FOREIGN KEY ("normalizedReviewId") REFERENCES "normalized_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_normalizedReviewId_fkey" FOREIGN KEY ("normalizedReviewId") REFERENCES "normalized_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_normalizedReviewId_fkey" FOREIGN KEY ("normalizedReviewId") REFERENCES "normalized_reviews"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_index_checks" ADD CONSTRAINT "search_index_checks_normalizedReviewId_fkey" FOREIGN KEY ("normalizedReviewId") REFERENCES "normalized_reviews"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "csv_import_queue" ADD CONSTRAINT "csv_import_queue_importJobId_fkey" FOREIGN KEY ("importJobId") REFERENCES "csv_import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "csv_import_queue" ADD CONSTRAINT "csv_import_queue_normalizedReviewId_fkey" FOREIGN KEY ("normalizedReviewId") REFERENCES "normalized_reviews"("id") ON DELETE SET NULL ON UPDATE CASCADE;

