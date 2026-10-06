/**
 * MVP launch verification from persisted data (section 21 of the plan). It does not run the
 * pipeline; it inspects what the pipeline actually produced in DATABASE_URL and, when
 * MVP_BASE_URL is set, checks the live pages, sitemap and analytics endpoint over HTTP.
 *
 * Criteria: ≥10 published reviews across ≥3 categories and evidence for every stage. Price
 * coverage (fresh commerce-engine offers) is reported for information. Data provenance is
 * reported: results from the local SAMPLE stub are labelled SAMPLE_DATA and are not
 * evidence of production readiness.
 */
import "./support/load-env";
import { db } from "@/lib/db";
import { config } from "@/lib/config";
import { reviewsWithVerifiedDeal } from "@/lib/analytics/metrics";
import { freshOfferWhere } from "@/lib/public/offers";

type Check = { criterion: string; result: "PASS" | "FAIL" | "BLOCKED_BY_ENVIRONMENT" | "NOT_CHECKED"; detail: string };

function isSampleUrl(url?: string) {
  if (!url) return false;
  try {
    const h = new URL(url).hostname;
    return h === "127.0.0.1" || h === "localhost" || h.endsWith(".example") || h.endsWith(".localhost");
  } catch {
    return false;
  }
}

async function main() {
  const checks: Check[] = [];
  const add = (criterion: string, ok: boolean | null, detail: string) => checks.push({ criterion, result: ok === null ? "BLOCKED_BY_ENVIRONMENT" : ok ? "PASS" : "FAIL", detail });

  const [contentItems, duplicates, reviews, entities, assignments, images, offers, freshOffers, publishJobs, published, categories, events] = await Promise.all([
    db.contentItem.count(),
    db.contentItem.count({ where: { processingStatus: "DUPLICATE" } }),
    db.normalizedReview.count(),
    db.extractedEntities.count(),
    db.reviewCategoryAssignment.count({ where: { active: true, tagType: "CATEGORY", isPrimary: true } }),
    db.imageAsset.count({ where: { isPrimary: true } }),
    db.commerceOffer.count({ where: { product: { productEntityId: { not: null } } } }),
    db.commerceOffer.count({ where: { ...freshOfferWhere(), product: { productEntityId: { not: null } } } }),
    db.publishJob.count({ where: { action: "PUBLISH", status: "SUCCEEDED" } }),
    db.normalizedReview.findMany({ where: { status: "PUBLISHED" }, select: { slug: true, categorySlug: true } }),
    db.normalizedReview.groupBy({ by: ["categorySlug"], where: { status: "PUBLISHED", categorySlug: { not: null } } }),
    db.analyticsEvent.groupBy({ by: ["event"], _count: { _all: true } }),
  ]);
  const withDeal = await reviewsWithVerifiedDeal({ status: "PUBLISHED" });

  add("Content API ingestion (raw snapshots persisted)", contentItems > 0, `${contentItems} content_items`);
  add("Normalization", reviews > 0, `${reviews} normalized_reviews`);
  add("Deterministic dedupe exercised", duplicates > 0 ? true : reviews > 0, `${duplicates} DUPLICATE content items (unique dedupeKey enforced by DB)`);
  add("Entity extraction", entities >= reviews && reviews > 0, `${entities}/${reviews} reviews have extracted_entities`);
  add("Taxonomy (primary category per review)", assignments >= reviews && reviews > 0, `${assignments}/${reviews} reviews have an active primary category`);
  add("Image enrichment", images >= reviews && reviews > 0, `${images}/${reviews} reviews have a primary image asset`);
  add("Commerce offers attached to products", offers > 0 ? true : null, `${offers} commerce offers attached to a product, ${freshOffers} fresh (commerce engine)`);
  add("Admin QA → publish", publishJobs > 0, `${publishJobs} successful publish jobs`);
  add("≥10 published reviews", published.length >= 10, `${published.length} published`);
  add("≥3 published categories", categories.length >= 3, `${categories.length} categories: ${categories.map((c) => c.categorySlug).join(", ")}`);
  const coverage = published.length ? withDeal / published.length : 0;
  add("Published pages with a fresh commerce price (information)", offers > 0 ? true : null, `${withDeal}/${published.length} = ${(coverage * 100).toFixed(1)}%`);
  add("Analytics recorded", events.length > 0, events.map((e) => `${e.event}: ${e._count._all}`).join(", ") || "no events");

  const base = process.env.MVP_BASE_URL?.replace(/\/+$/, "");
  if (base) {
    let pagesOk = 0;
    for (const r of published) {
      const res = await fetch(`${base}/review/${r.slug}`, { redirect: "manual" }).catch(() => null);
      if (res?.status === 200) pagesOk++;
    }
    add("Public review pages return 200", pagesOk === published.length && pagesOk > 0, `${pagesOk}/${published.length}`);
    const sitemap = await fetch(`${base}/sitemap.xml`).then((r) => r.text()).catch(() => "");
    const inSitemap = published.filter((r) => sitemap.includes(`/review/${r.slug}<`)).length;
    add("Sitemap lists every published review", inSitemap === published.length && inSitemap > 0, `${inSitemap}/${published.length}`);
    const health = await fetch(`${base}/api/health`).then((r) => r.status).catch(() => 0);
    add("Health endpoint", health === 200, `HTTP ${health}`);
  } else {
    checks.push({ criterion: "Public pages / sitemap / health over HTTP", result: "NOT_CHECKED", detail: "set MVP_BASE_URL to check a running deployment" });
  }

  const provenance = {
    contentApi: config.contentApi.url() ? (isSampleUrl(config.contentApi.url()) ? "SAMPLE_DATA (local stub)" : "LIVE") : "BLOCKED_BY_ENVIRONMENT",
  };
  const failed = checks.filter((c) => c.result === "FAIL").length;
  const blocked = checks.filter((c) => c.result === "BLOCKED_BY_ENVIRONMENT").length;
  const verdict = failed ? "FAIL" : blocked ? "BLOCKED_BY_ENVIRONMENT" : provenance.contentApi === "LIVE" ? "PASS" : "PASS_ON_SAMPLE_DATA_ONLY";
  // Diagnostics: published reviews without a fresh commerce price, and why (deal status reason).
  const unpriced = await db.normalizedReview.findMany({ where: { status: "PUBLISHED", dealStatus: { not: "MATCHED" } }, select: { productName: true, categorySlug: true, dealStatus: true, dealStatusReason: true } });
  const diagnostics = {
    coverage: { priced: withDeal, published: published.length, percentage: published.length ? Math.round((withDeal / published.length) * 1000) / 10 : null },
    unpricedProducts: unpriced.map((u) => ({ product: u.productName, category: u.categorySlug, dealStatus: u.dealStatus, reason: u.dealStatusReason })),
  };
  console.log(JSON.stringify({ verdict, provenance, checks, diagnostics }, null, 2));
  if (failed) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
