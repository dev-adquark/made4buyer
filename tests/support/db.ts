import { db } from "@/lib/db";

const TABLES = [
  "csv_import_queue", "csv_import_jobs", "product_facts", "commerce_match_logs", "commerce_coupons", "commerce_offers", "commerce_products", "commerce_raw_records", "commerce_runs", "commerce_sources", "commerce_brands", "image_assets", "page_render_models", "publish_jobs",
  "review_category_assignments", "extracted_entities", "search_index_checks", "analytics_events", "content_items", "normalized_reviews", "review_ingest_runs",
  "revalidation_runs", "pipeline_failures", "job_locks", "job_runs", "sponsored_placements", "audit_logs", "admin_sessions", "rate_limit_buckets", "day30_reports", "apify_runs", "review_sources", "content_entities", "product_entities", "content_queue", "automation_slots", "automation_settings",
];

/** Empties all data tables (keeps the seeded taxonomy). */
export async function resetDb() {
  await db.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
}
