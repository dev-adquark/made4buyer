import { db } from "@/lib/db";

const TABLES = [
  "csv_import_queue", "csv_import_jobs", "affiliate_links", "sovrn_offer_matches", "sovrn_offers_cache", "image_assets", "page_render_models", "publish_jobs",
  "review_category_assignments", "extracted_entities", "search_index_checks", "analytics_events", "content_items", "normalized_reviews", "review_ingest_runs",
  "revalidation_runs", "pipeline_failures", "job_locks", "sponsored_placements", "audit_logs", "admin_sessions", "rate_limit_buckets", "day30_reports",
];

/** Empties all data tables (keeps the seeded taxonomy). */
export async function resetDb() {
  await db.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
}
