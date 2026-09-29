/**
 * Pipeline dry-run: executes every pure stage over SAMPLE JSON with no database and no
 * network, printing the input/output of each stage under the same stage names used in logs
 * and in the PipelineStage enum. Output is written to docs/dry-run/sample-output.json.
 *
 *   npm run pipeline:dry-run                       # fixtures/sample-content.json
 *   npm run pipeline:dry-run -- path/to/items.json # your own Content API sample
 *
 * Offer matching uses fixtures/sample-sovrn-offers.json (SAMPLE, not real offers). Image
 * probing and link verification need the network and are reported as SKIPPED_DRY_RUN.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import { extractEntities, lowConfidenceFields } from "@/lib/pipeline/entities";
import { normalizeContent } from "@/lib/pipeline/normalize";
import { composeRenderModel } from "@/lib/pipeline/render-model";
import { validateContentItem } from "@/lib/pipeline/validate";
import { generateAffiliateUrl } from "@/lib/sovrn/affiliate";
import { buildQueryString, normalizeOffers, rankOffers, selectionReason } from "@/lib/sovrn/offers";
import { classify } from "@/lib/taxonomy/classify";
import { CATEGORIES, INTENTS, PLATFORMS, PRICE_TIERS } from "@/lib/taxonomy/definitions";
import { slugify } from "@/lib/util/text";

const SAMPLE_OFFER_BASE = "https://sample-offers.example";
const file = process.argv[2] ?? "fixtures/sample-content.json";
const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
const items = Array.isArray(raw) ? raw : ((raw as { items?: unknown[] }).items ?? []);
const sovrn = JSON.parse(readFileSync("fixtures/sample-sovrn-offers.json", "utf8")) as { responses: Record<string, unknown[]> };
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

  const query = { productName: e.productName, brand: e.brand, deviceType: e.deviceType, categorySlug: c.category?.slug, modelNumber: e.modelNumber };
  const queryKey = buildQueryString(query);
  const sample = Object.entries(sovrn.responses).find(([k]) => k.toLowerCase() === queryKey.toLowerCase())?.[1];
  const offers = normalizeOffers(JSON.parse(JSON.stringify({ offers: sample ?? [] }).split("{BASE}").join(SAMPLE_OFFER_BASE)));
  const ranked = rankOffers(query, offers, { minScore: config.sovrn.minScore(), trustedMerchants: config.sovrn.trustedMerchants() });
  const viable = ranked.filter((r) => r.viable);
  stages.OFFER_MATCHING = {
    outcome: viable.length ? "MATCHED" : "NO_MATCH (SOVRN_NO_MATCH)",
    note: "SAMPLE offers from fixtures/sample-sovrn-offers.json — not real Sovrn data",
    record: "sovrn_offer_matches",
    queryKey,
    matchedSovrnOfferSet: ranked.map((r) => ({ offerId: r.offer.offerId, title: r.offer.title, merchant: r.offer.merchantName, price: r.offer.price, viable: r.viable, score: r.breakdown.total, breakdown: r.breakdown })),
    bestOffer: viable[0] ? selectionReason(viable[0], viable[1]) : null,
  };

  const selected = viable.slice(0, 1 + config.sovrn.alternates());
  const links = selected.map((s) => ({ offerId: s.offer.offerId, ...generateAffiliateUrl(s.offer, { wrapperUrl: config.sovrn.linkWrapperUrl(), siteKey: config.sovrn.siteKey() }) }));
  stages.AFFILIATE_LINK = { outcome: links.length ? "SUCCESS" : "SKIPPED (no selected offer)", record: "affiliate_links", affiliateLinkSet: links };
  stages.LINK_VERIFICATION = { outcome: "SKIPPED_DRY_RUN", note: "Requires the network; production follows the redirect chain through the SSRF-safe client and only VERIFIED_OK links are rendered.", wouldVerify: links.length };

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
    deals: [],
  });
  stages.PAGE_RENDER = { outcome: "SUCCESS", record: "page_render_models", pageRenderModel: { ...model, bodyParagraphs: [`${model.bodyParagraphs.length} paragraph(s)`] }, note: "deals is empty: no link is VERIFIED_OK in a dry-run" };

  const qa = [!c.category && "NO_PRIMARY_CATEGORY", c.category && !autoAccept && "CATEGORY_NEEDS_REVIEW", low.length && "ENTITIES_NEED_REVIEW"].filter(Boolean);
  stages.PUBLISH = { outcome: qa.length ? "BLOCKED_BY_QA (review status NEEDS_REVIEW)" : "READY (review status QUEUED)", record: "publish_jobs", qaFailures: qa };
  results.push({ input: { ...(item as object), body: "…" }, stages });
  summary.push({ item: v.value.sourceId, status: qa.length ? "NEEDS_REVIEW" : "QUEUED", category: `${c.category?.slug ?? "-"} (${c.category?.confidence ?? 0})`, deal: viable[0]?.offer.offerId ?? "NO_MATCH" });
}

const out = { generatedFrom: file, note: "Dry-run over SAMPLE data. No database, no network, no real offers.", stagesInOrder: ["CONTENT_FETCH", "VALIDATION", "NORMALIZATION", "DEDUPE", "ENTITY_EXTRACTION", "TAXONOMY", "IMAGE_ENRICHMENT", "OFFER_MATCHING", "AFFILIATE_LINK", "LINK_VERIFICATION", "PAGE_RENDER", "PUBLISH"], summary, results };
mkdirSync(path.resolve("docs/dry-run"), { recursive: true });
writeFileSync("docs/dry-run/sample-output.json", JSON.stringify(out, null, 2) + "\n");
console.table(summary);
console.log(`\nFull stage-by-stage output: docs/dry-run/sample-output.json (${results.length} items)`);
