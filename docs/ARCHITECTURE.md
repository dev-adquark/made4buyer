# Architecture & data flow

```
Content API ──► ContentItem ──► NormalizedReview ──► ExtractedEntities ──► CategoryTagSet
                (raw snapshot)   (canonical review)    (per-field confidence)  (review_category_assignments)
                                                                                     │
PublishJob ◄── PageRenderModel ◄── AffiliateLinkSet ◄── MatchedSovrnOfferSet ◄── ImageAsset
(publish_jobs) (page_render_models) (affiliate_links)    (sovrn_offer_matches)   (image_assets)
```

Every stage name below is the value of the `PipelineStage` enum. The same name appears in the
`stage` field of every structured log line and in `pipeline_failures.stage`, so a log line, a
failure row and a database record can always be joined.

Run the whole flow locally without a database or network:

```bash
npm run pipeline:dry-run                  # uses fixtures/sample-content.json
npm run pipeline:dry-run -- my-items.json # your own Content API sample
```

It prints a summary table and writes every stage's input and output to
[`docs/dry-run/sample-output.json`](dry-run/sample-output.json).

## Code map

| Concern | Module |
|---|---|
| Content API adapter | `lib/pipeline/content-source.ts` |
| Validation (schema, field aliases) | `lib/pipeline/validate.ts` |
| Normalization, canonical title, dedupe key, content hash | `lib/pipeline/normalize.ts` |
| Entity extraction | `lib/pipeline/entities.ts`, `lib/pipeline/brands.ts` |
| Taxonomy definitions / classifier / persistence | `lib/taxonomy/*` |
| Image enrichment | `lib/pipeline/images.ts` |
| Sovrn adapter, cache, scoring | `lib/sovrn/client.ts`, `lib/sovrn/offers.ts` |
| Affiliate link generation | `lib/sovrn/affiliate.ts` |
| Link verification | `lib/pipeline/verify-link.ts` on top of `lib/net/safe-fetch.ts` (SSRF-safe) |
| Stage runners (persist + failures) | `lib/pipeline/stages.ts` |
| Per-review orchestration | `lib/pipeline/process.ts` |
| Ingestion run orchestration | `lib/pipeline/ingest.ts` |
| PageRenderModel | `lib/pipeline/render-model.ts` |
| QA gates / publish / unpublish / reject / restore | `lib/pipeline/publish.ts` |
| Failure log | `lib/pipeline/failures.ts` |
| Jobs, locks, revalidation | `lib/jobs/*` |
| CSV overrides | `lib/csv/*`, `lib/admin/overrides.ts` |
| Metrics, CTR, Day-30 report | `lib/analytics/metrics.ts`, `lib/reports/*` |

## Stages

### 1. `CONTENT_FETCH`
- **Input:** `CONTENT_API_URL`. The response is either an array or an object with an `items`, `results`, `data`, `reviews`, `articles` or `content` array. `next` / `nextPage` / `links.next` pagination is followed on the same origin, up to `CONTENT_API_MAX_PAGES` pages.
- **Output:** the raw items.
- **Record:** `review_ingest_runs` (one row per run: counts, status, `failureReasonSummary`, `duplicateItems`).
- **Failure states:** `CONTENT_API_NOT_CONFIGURED` (BLOCKED_BY_ENVIRONMENT), `CONTENT_API_TIMEOUT`, `CONTENT_API_HTTP_ERROR`, `CONTENT_API_RESPONSE_INVALID`. The run ends `FAILED`, and items left over from earlier runs are still processed.
- **Retry:** timeouts, 408, 425, 429 and 5xx responses are retried with bounded exponential backoff (`CONTENT_API_MAX_RETRIES`). The next scheduled run retries the fetch.
- **Metrics:** `totalFetched`. An `ingestion` analytics event is recorded per run.
- **Logs:** `content page fetched`, `ingestion run started` / `completed` / `fetch failed`.

### 2. `VALIDATION`
- **Input:** one raw item.
- **Output:** a `ValidatedContent` (canonical field names). Aliases are listed in [CONTENT_API_CONTRACT.md](CONTENT_API_CONTRACT.md).
- **Record:** `content_items` holds the raw snapshot (`rawPayload`, `contentHash`, `fetchedAt`, `lastSeenAt`), unique on `(source, sourceId)`.
- **Validation rules:** id required; title 8–300 characters; body ≥ 120 characters of text after HTML is stripped; URLs must be absolute http(s); dates must parse; price ≥ 0.
- **Failure states:** `CONTENT_SCHEMA_INVALID` sets the item to `FAILED` with `statusReason` listing the exact issues. Only that item fails; the batch continues.
- **Idempotency:** an unchanged re-fetch (same `sourceId` and `contentHash`) only updates `lastSeenAt` and counts as `unchangedCount`. Changed content is re-processed (`updatedCount`).

### 3. `NORMALIZATION`
- **Output:** a canonical title (publisher suffix stripped, product-name prefix added when missing, capped at 110 characters on a word boundary), slug, product identity, summary (source value or the first sentences of the body) and plain-text body.
- **Record:** `normalized_reviews`, unique on `(source, sourceId)`, `slug` and `dedupeKey`. The slug stays fixed once created.
- **Admin edits:** once an editor saves text, `manualEditLocked` is set, and later content updates no longer overwrite the title, summary or body.
- **Failure states:** unexpected errors set the item to `FAILED` with a retryable failure row.

### 4. `DEDUPE`
- **Dedupe key:** `<product-key>|<publisher host>|<YYYY-MM>`. The product key is the slugified product identity with any leading brand removed, so "Apple MacBook Air 13" and "MacBook Air 13" produce the same key.
- **Rules:** an item whose key or canonical URL matches a *different* review is a duplicate. It becomes `DUPLICATE` with `errorCode = DUPLICATE_REVIEW`, and `normalizedReviewId` points at the original. Duplicates are counted in the run and listed in `duplicateItems`; nothing is silently discarded.
- **Concurrency:** the database enforces the unique dedupe key. A concurrent collision (`P2002`) is retried once, and the retry then sees the duplicate.

### 5. `ENTITY_EXTRACTION`
- **Output:** `productName`, `brand`, `deviceType`, `useCase`, `platform`, `price` / `currency`, `modelNumber`, `source`, `publishDate` and `rating`, each with its own confidence.
- **Record:** `extracted_entities` (`confidences`, `overrides`, `lowConfidenceFields`, `overallConfidence`).
- **Rules:** explicit Content API fields score 0.95; brand-dictionary and product-family matches score 0.65–0.9; values derived only from text score lower. Core fields below `ENTITY_LOW_CONFIDENCE_THRESHOLD` (productName, brand, deviceType) are listed in `lowConfidenceFields` and send the review to QA.
- **Overrides:** values set in the admin UI or by CSV are kept in `overrides`, re-applied on every re-run, and scored at confidence 1. An empty override means an editor explicitly confirmed "not applicable".
- **Failure states:** `ENTITY_EXTRACTION_LOW_CONFIDENCE` (informational, resolved when fixed).

### 6. `TAXONOMY`
- **Output:** a CategoryTagSet containing a primary category, optional subcategory, intents, platforms and a price tier. Each assignment carries `confidence`, `reason`, `source` and an override flag.
- **Records:** `category_tags` (seeded from `lib/taxonomy/definitions.ts`) and `review_category_assignments`.
- **Rules:** weighted keyword signals by field (product name ×4, title ×3, source category ×3, summary ×1.5, body ×0.5 capped at 3 hits), negative signals for accessories, and a +24 bonus when the source category matches an alias. Confidence = `0.2 + 0.45·strength + 0.35·margin`, capped at 0.99. Price tier comes from the extracted price against per-category bands, otherwise from keyword evidence.
- **QA:** a confidence at or above `TAXONOMY_AUTO_ACCEPT_THRESHOLD` (0.8) skips manual review. Below it the review stays `NEEDS_REVIEW` until an editor accepts the assignment or overrides it.
- **Idempotency:** re-classification updates matching assignments in place (admin accept/reject state is kept) and never touches overrides.
- **Failure states:** `NO_CATEGORY_MATCH`, `CATEGORY_LOW_CONFIDENCE`.

### 7. `IMAGE_ENRICHMENT`
- **Priority:** (1) the Content API image, (2) `IMAGE_ENRICHMENT_URL`, (3) our own category placeholder SVG.
- **Record:** `image_assets` (`sourceType`, `sourceUrl`, `cdnUrl`, `licenseState`, `license`, `attribution`, `enrichmentStatus`, `isFallback`, `verifiedAt`).
- **Rules:** every image URL is probed through the SSRF-safe client (must return `image/*`; remote SVG is rejected). `licenseState` is `VERIFIED` only when explicitly established (`imageLicenseVerified: true`, or the operator sets `CONTENT_API_IMAGES_LICENSED=true`). A license string alone gives `PROVIDER_ASSERTED`; no license gives `UNVERIFIED`. With `IMAGE_REQUIRE_LICENSE=true`, unverified images are never shown publicly and the placeholder is used instead.
- **Failure states:** `IMAGE_ENRICHMENT_FAILED`, `LICENSE_UNVERIFIED`. These never block publishing.

### 8. `OFFER_MATCHING`
- **Input:** product name, brand, device type, category and model number.
- **Records:** `sovrn_offers_cache` holds every response, including errors, with `providerStatus` and `expiresAt`; only successful responses are reused. `sovrn_offer_matches` holds viable offers plus up to three below-threshold offers for transparency, each with `score`, `scoreBreakdown`, `rank`, `isBestOffer` and `selectionReason`.
- **Scoring:** product similarity 0.35, brand 0.15, model 0.15, category fit 0.10 (accessory or replacement listings score 0), availability 0.10, price present 0.10, merchant quality 0.05. An offer is viable when its score is ≥ `SOVRN_MIN_MATCH_SCORE` and product ≥ 0.5, brand > 0 and category > 0. Ties break on availability, then lower price, then `offerId`.
- **Deal ID override:** a set `sovrnDealIdOverride` forces that offer, which must be present in the provider's results. Otherwise the stage records `SOVRN_DEAL_ID_NOT_FOUND`.
- **Review `dealStatus`:** `MATCHED`, `NO_MATCH`, `STALE` (provider failed but earlier matches exist), `FAILED`, or `UNAVAILABLE` (Sovrn not configured).
- **Failure states:** `SOVRN_NOT_CONFIGURED`, `SOVRN_NO_MATCH`, `SOVRN_TIMEOUT`, `SOVRN_PROVIDER_ERROR`, `SOVRN_RESPONSE_INVALID`, `SOVRN_DEAL_ID_NOT_FOUND`.

### 9. `AFFILIATE_LINK`
- **Output:** the AffiliateLinkSet — the best offer plus up to `SOVRN_ALTERNATE_OFFERS` alternates.
- **Record:** `affiliate_links`, unique on `(normalizedReviewId, sovrnOfferId)`, with `generationMethod`, `isBest`, `isActive` and `destinationUrl`.
- **Rules:** the link is the provider's deeplink (`PROVIDER_DEEPLINK`), or the merchant URL wrapped with `SOVRN_LINK_WRAPPER_URL?key=SOVRN_SITE_KEY&u=…` (`LINK_WRAPPER`). If neither is possible the stage fails with `AFFILIATE_URL_INVALID`; no link is ever invented. A changed URL resets verification to `PENDING`.

### 10. `LINK_VERIFICATION`
- **Rules:** the redirect chain is followed manually through `safeFetch`: http(s) only, standard ports, every hop re-validated, private, loopback, link-local and internal hosts refused at socket-connect time (so DNS rebinding cannot bypass the check), loops detected, bounded hop count and timeout. HEAD is tried first, then a ranged GET.
- **Classification:** `VERIFIED_OK`, `REDIRECT_MISMATCH` (the final registrable domain differs from the merchant's, or a loop occurred), `FORBIDDEN`, `BLOCKED`, `UNAVAILABLE`, `TIMEOUT`, `INVALID`, `PROVIDER_ERROR`.
- **Record:** the result is written to `affiliate_links` (`verificationStatus`, `verificationReason`, `httpStatus`, `redirectChain`, `finalUrl`, `lastVerifiedAt`, `nextVerificationAt`). Each run adds a `revalidation_runs` row with checked, success and failure counts and a reason breakdown.
- **Retry:** `TIMEOUT` and `PROVIDER_ERROR` back off (1 h × 2ⁿ, at most 24 h). Healthy links are re-checked every `LINK_VERIFY_INTERVAL_HOURS`.
- **Public rule:** only `VERIFIED_OK` links on `MATCHED` offers are rendered or redirected by `/go/{id}`.

### 11. `PAGE_RENDER`
- **Output:** the PageRenderModel, a complete description of the public page with no internal data (no scores, chains or reasons). Its JSON-LD is chosen from the real data: Review when a rating exists, otherwise Article, plus Product/Offer only when a verified offer has a price.
- **Record:** `page_render_models` (`model`, `modelHash`, `builtAt`). It is rebuilt on publish, admin edits, overrides and link-status changes of published reviews.

### 12. `PUBLISH`
- **QA gates:** the review is not rejected; title, summary and body are long enough; a primary category exists; low-confidence categories have been accepted or overridden; low-confidence entities have been confirmed or overridden.
- **Record:** `publish_jobs` gets one row per publish or unpublish attempt (`SUCCEEDED` / `FAILED`, `qaFailures`, `errorCode`). Admin actions also write `audit_logs`, and a `publish` analytics event is recorded. The original `publishedAt` is kept on republish.
- **Statuses:** `NEEDS_REVIEW` → `QUEUED` → `PUBLISHED` → `UNPUBLISHED` / `REJECTED`. Restore returns the review to the queue. `AUTO_PUBLISH_ENABLED=true` publishes QA-passing `QUEUED` reviews in the publish cycle.
- **Failure states:** `PUBLISH_QA_FAILED`, `PAGE_RENDER_FAILED`.

## Failure model

`pipeline_failures` has one row per `(stage, entity, errorCode)` fingerprint, with `kind`
(`RETRYABLE_FAILURE` / `PERMANENT_FAILURE`), `message`, `retryCount`, `maxRetries`,
`nextRetryAt`, `occurrences`, `lastOccurredAt` and `resolvedAt`. When a stage succeeds, its
failures are resolved. The `retry-failed` job re-runs due retryable failures with exponential
backoff (5 min × 2ⁿ, at most 24 h). A failure is marked permanent once `maxRetries` is
exhausted. Error codes are defined in `lib/errors.ts`.

## Jobs

| Job (`/api/cron/<name>`) | Lock | Purpose |
|---|---|---|
| `ingest` | `ingestion` | Fetch, snapshot, normalize and process pending items; publish cycle |
| `verify-links` | `job:verify-links` | Re-verify due / pending affiliate links |
| `revalidate-offers` | `job:revalidate-offers` | Re-query Sovrn for stale or failed deal data |
| `retry-failed` | `job:retry-failed` | Retry due retryable failures |
| `publish-cycle` | `job:publish-cycle` | Auto-publish QA-passing queued reviews (when enabled) |
| `cleanup-cache` | `job:cleanup-cache` | Expired Sovrn cache, sessions, rate-limit buckets, stale locks |
| `inspect-index` | `job:inspect-index` | Search Console URL Inspection of published pages |

Locks are acquired atomically with `INSERT … ON CONFLICT … WHERE expiresAt < now()`. A
concurrent run gets HTTP 409, and a crashed run's lock is recovered once its TTL expires.

## Security

- Admin sessions are stored server-side (`admin_sessions`), use an HMAC-signed opaque cookie (HttpOnly, SameSite=Strict, Secure plus the `__Host-` prefix in production), expire hard, and are revoked on logout.
- Every admin mutation passes an Origin / Sec-Fetch-Site check (CSRF defence), a session check and an audit log entry. Login is rate-limited per IP and per email in the database.
- Cron endpoints require `Authorization: Bearer $CRON_SECRET`, compared in constant time.
- Every outbound fetch goes through `safeFetch` (see stage 10). `/go/{id}` redirects only to persisted, verified URLs.
- CSV uploads are checked for extension, content type, size, row limit, UTF-8 and strict headers. Exported CSVs neutralise spreadsheet formulas.
- Response headers: CSP, HSTS (production), X-Frame-Options DENY, nosniff, Referrer-Policy and Permissions-Policy. Admin pages send no-store and noindex.
- Logs redact secrets by key name and by the values of known secret environment variables.
- Review bodies are stored and rendered as plain text; JSON-LD is serialized with `<` escaped.
