-- Exact-title uniqueness for AI posts is per post type: an ARTICLE and a GUIDE may share a title,
-- two posts of the same type may not. Replaces the all-types index. Idempotent.
DROP INDEX IF EXISTS "normalized_reviews_ai_guide_title_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "normalized_reviews_ai_title_type_unique"
  ON "normalized_reviews" (lower("canonicalTitle"), (COALESCE("generationMeta"->>'articleType', 'GUIDE')))
  WHERE "kind" = 'AI_GUIDE';
