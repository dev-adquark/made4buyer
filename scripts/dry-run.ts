/**
 * Pipeline dry-run: executes every pure stage over SAMPLE JSON with no database and no
 * network, printing the input/output of each stage under the same stage names used in logs
 * and in the PipelineStage enum. Output is written to docs/dry-run/sample-output.json.
 *
 *   npm run pipeline:dry-run                       # fixtures/sample-content.json
 *   npm run pipeline:dry-run -- path/to/items.json # your own Content API sample
 *
 * Offers come from the commerce engine's stored observations (database), so OFFER_MATCHING is
 * reported as SKIPPED_DRY_RUN; image probing needs the network and is skipped too.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import { extractEntities, lowConfidenceFields } from "@/lib/pipeline/entities";
import { normalizeContent } from "@/lib/pipeline/normalize";
import { composeRenderModel } from "@/lib/pipeline/render-model";
import { validateContentItem } from "@/lib/pipeline/validate";
import { classify } from "@/lib/taxonomy/classify";
import { CATEGORIES, INTENTS, PLATFORMS, PRICE_TIERS } from "@/lib/taxonomy/definitions";
import { slugify } from "@/lib/util/text";

const file = process.argv[2] ?? "fixtures/sample-content.json";
const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
const items = Array.isArray(raw) ? raw : ((raw as { items?: unknown[] }).items ?? []);
const tagName = (type: string, slug: string) =>
  (type === "CATEGORY" ? CATEGORIES : type === "SUBCATEGORY" ? CATEGORIES.flatMap((c) => c.subcategories) : type === "INTENT" ? INTENTS : type === "PLATFORM" ? PLATFORMS : PRICE_TIERS).find((t) => t.slug === slug)?.name ?? slug;

const seenKeys = new Map<string, string>();
const seenUrls = new Map<string, string>();
const results: unknown[] = [];
const summary: Array<Record<string, string>> = [];
const source = "sample-fixture";
const fetchedAt = new Date("2026-09-25T00:00:00Z");

for (const [index, item] of items.entries()) {
  const stages: Record<string, unknown> = { CONTENT_FETCH: { source, index } };
  const v = validateContentItem(JSON.parse(JSON.stringify(item).split("{BASE}").join("https://images.sample.example")));
  if (!v.ok) {
    stages.VALIDATION = { outcome: "PERMANENT_FAILURE", errorCode: "CONTENT_SCHEMA_INVALID", issues: v.issues, contentItemStatus: "FAILED" };
    results.push({ input: item, stages });
    summary.push({ item: v.sourceId ?? `#${index}`, status: "FAILED", reason: "CONTENT_SCHEMA_INVALID" });
    continue;
  }
  stages.VALIDATION = { outcome: "SUCCESS", validated: { ...v.value, body: `${v.value.body.slice(0, 80)}…` } };
  const n = normalizeContent(v.value, { source, fetchedAt });
  stages.NORMALIZATION = { outcome: "SUCCESS", record: "normalized_reviews", canonicalTitle: n.canonicalTitle, slug: n.slugBase, productIdentity: n.productIdentity, contentHash: n.contentHash, summary: n.summary };

  const dupOf = seenKeys.get(n.dedupeKey) ?? (n.canonicalUrl ? seenUrls.get(n.canonicalUrl) : undefined);
  if (dupOf) {
    stages.DEDUPE = { outcome: "DUPLICATE", errorCode: "DUPLICATE_REVIEW", dedupeKey: n.dedupeKey, duplicateOf: dupOf, contentItemStatus: "DUPLICATE" };
    results.push({ input: item, stages });
    summary.push({ item: v.value.sourceId, status: "DUPLICATE", reason: `duplicate of ${dupOf}` });
    continue;
  }
  seenKeys.set(n.dedupeKey, v.value.sourceId);
  if (n.canonicalUrl) seenUrls.set(n.canonicalUrl, v.value.sourceId);
  stages.DEDUPE = { outcome: "SUCCESS", dedupeKey: n.dedupeKey };

  const e = extractEntities(v.value, n);
  const low = lowConfidenceFields(e, config.entities.lowConfidenceThreshold());
  stages.ENTITY_EXTRACTION = { outcome: low.length ? "SUCCESS (low confidence → QA)" : "SUCCESS", record: "extracted_entities", entities: { ...e, lowConfidenceFields: low } };

  const c = classify({ title: n.canonicalTitle, productName: e.productName, summary: n.summary, body: n.body, sourceCategory: v.value.category, sourceTags: v.value.tags, deviceType: e.deviceType, price: e.price });
  const autoAccept = (c.category?.confidence ?? 0) >= config.taxonomy.autoAcceptThreshold();
  stages.TAXONOMY = { outcome: !c.category ? "PERMANENT_FAILURE (NO_CATEGORY_MATCH)" : autoAccept ? "SUCCESS (auto-accepted)" : "SUCCESS (CATEGORY_LOW_CONFIDENCE → QA)", record: "review_category_assignments", categoryTagSet: c };

  stages.IMAGE_ENRICHMENT = v.value.imageUrl
    ? { outcome: "SKIPPED_DRY_RUN", wouldTry: ["CONTENT_API", "ENRICHMENT_SERVICE", "PLACEHOLDER"], contentApiImage: v.value.imageUrl, licenseEvidence: v.value.imageLicense ?? "none (would be LICENSE_UNVERIFIED)" }
    : { outcome: "FALLBACK", record: "image_assets", sourceType: "PLACEHOLDER", sourceUrl: `/placeholders/${c.category?.slug ?? "general"}.svg`, licenseState: "OWNED_PLACEHOLDER" };

  stages.OFFER_MATCHING = { outcome: "SKIPPED_DRY_RUN", note: "Prices and seller links come from the commerce engine's stored observations (commerce_offers); no provider is queried and links stay plain unless an affiliate provider is configured." };

  const slug = n.slugBase;
  const model = composeRenderModel({
    review: { id: `dry-${v.value.sourceId}`, slug, canonicalTitle: n.canonicalTitle, summary: n.summary, body: n.body, productName: e.productName, brand: e.brand ?? null, brandSlug: e.brand ? slugify(e.brand, 60) : null, categorySlug: c.category?.slug ?? null, subcategorySlug: c.subcategory?.slug ?? null, source, sourceUrl: v.value.url ?? null, author: v.value.author ?? null, sourcePublishedAt: v.value.publishedAt ?? null, publishedAt: null, updatedAt: fetchedAt },
    entities: { brand: e.brand ?? null, productName: e.productName, modelNumber: e.modelNumber ?? null, deviceType: e.deviceType ?? null, platform: e.platform ?? null, useCase: e.useCase ?? null, rating: e.rating ?? null, ratingScale: e.ratingScale ?? null, source: e.source },
    assignments: [
      ...(c.category ? [{ tagType: "CATEGORY", isPrimary: true, confidence: c.category.confidence, categoryTag: { slug: c.category.slug, name: tagName("CATEGORY", c.category.slug) } }] : []),
      ...(c.subcategory ? [{ tagType: "SUBCATEGORY", isPrimary: true, confidence: c.subcategory.confidence, categoryTag: { slug: c.subcategory.slug, name: tagName("SUBCATEGORY", c.subcategory.slug) } }] : []),
      ...c.intents.map((t, i) => ({ tagType: "INTENT", isPrimary: i === 0, confidence: t.confidence, categoryTag: { slug: t.slug, name: tagName("INTENT", t.slug) } })),
      ...c.platforms.map((t, i) => ({ tagType: "PLATFORM", isPrimary: i === 0, confidence: t.confidence, categoryTag: { slug: t.slug, name: tagName("PLATFORM", t.slug) } })),
      ...(c.priceTier ? [{ tagType: "PRICE_TIER", isPrimary: true, confidence: c.priceTier.confidence, categoryTag: { slug: c.priceTier.slug, name: tagName("PRICE_TIER", c.priceTier.slug) } }] : []),
    ],
    image: null,
    offers: [],
  });
  stages.PAGE_RENDER = { outcome: "SUCCESS", record: "page_render_models", pageRenderModel: { ...model, bodyParagraphs: [`${model.bodyParagraphs.length} paragraph(s)`] }, note: "offers is empty: commerce offers are read from the database, which a dry-run does not use" };

  // Same hard rules as evaluateQa: low category/entity confidence is information only.
  const qa = [!c.category && "NO_PRIMARY_CATEGORY"].filter(Boolean);
  stages.PUBLISH = { outcome: qa.length ? "BLOCKED_BY_QA (review status NEEDS_REVIEW)" : "READY (review status QUEUED)", record: "publish_jobs", qaFailures: qa };
  results.push({ input: { ...(item as object), body: "…" }, stages });
  summary.push({ item: v.value.sourceId, status: qa.length ? "NEEDS_REVIEW" : "QUEUED", category: `${c.category?.slug ?? "-"} (${c.category?.confidence ?? 0})`, offers: "SKIPPED_DRY_RUN" });
}

const out = { generatedFrom: file, note: "Dry-run over SAMPLE data. No database, no network, no real offers.", stagesInOrder: ["CONTENT_FETCH", "VALIDATION", "NORMALIZATION", "DEDUPE", "ENTITY_EXTRACTION", "TAXONOMY", "IMAGE_ENRICHMENT", "OFFER_MATCHING", "PAGE_RENDER", "PUBLISH"], summary, results };
mkdirSync(path.resolve("docs/dry-run"), { recursive: true });
writeFileSync("docs/dry-run/sample-output.json", JSON.stringify(out, null, 2) + "\n");
console.table(summary);
console.log(`\nFull stage-by-stage output: docs/dry-run/sample-output.json (${results.length} items)`);
