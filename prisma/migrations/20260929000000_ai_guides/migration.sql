-- AI-assisted buying guides: content kind, generation metadata and mandatory editor approval.
CREATE TYPE "content_kind" AS ENUM ('REVIEW', 'AI_GUIDE');
ALTER TABLE "normalized_reviews"
  ADD COLUMN "kind" "content_kind" NOT NULL DEFAULT 'REVIEW',
  ADD COLUMN "generationMeta" JSONB,
  ADD COLUMN "editorApprovedAt" TIMESTAMP(3),
  ADD COLUMN "editorApprovedBy" TEXT;
CREATE INDEX "normalized_reviews_kind_status_idx" ON "normalized_reviews"("kind", "status");
