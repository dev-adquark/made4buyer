-- NormalizedReview: per-review AI-rewrite tracking (lib/pipeline/rewrite.ts).
-- Once contentRewritten, the review's body is Made4Buyers' own original wording (facts preserved)
-- and lib/pipeline/render-model.ts treats it as FULL rights with no third-party attribution.
ALTER TABLE "normalized_reviews" ADD COLUMN "contentRewritten" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "normalized_reviews" ADD COLUMN "rewriteAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "normalized_reviews" ADD COLUMN "rewrittenAt" TIMESTAMP(3);
