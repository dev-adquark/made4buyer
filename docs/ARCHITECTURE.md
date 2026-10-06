# Architecture & data flow

```
Content API ──► ContentItem ──► NormalizedReview ──► ExtractedEntities ──► CategoryTagSet
                (raw snapshot)   (canonical review)    (per-field confidence)  (review_category_assignments)
                                                                                     │
PublishJob ◄── PageRenderModel ◄── commerce offers (read) ◄── ImageAsset
(publish_jobs) (page_render_models) (commerce_offers, fresh)   (image_assets)
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
| Public commerce offers (fresh prices, seller links) | `lib/public/offers.ts` (reads `commerce_offers` written by the commerce engine, `lib/commerce/*`) |
| Affiliate provider interface (default `none`: plain links) | `lib/affiliate/provider.ts` |
| Product URL hygiene (tracking params, affiliate redirectors) | `lib/net/product-url.ts` |
| Outbound link verification utility | `lib/pipeline/verify-link.ts` on top of `lib/net/safe-fetch.ts` (SSRF-safe) |
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
- **QA:** there is no manual review. A confidence below `TAXONOMY_AUTO_ACCEPT_THRESHOLD` (0.8) is shown in Admin as information; an editor may still accept or override an assignment, but publishing never waits for it.
- **Idempotency:** re-classification updates matching assignments in place (admin accept/reject state is kept) and never touches overrides.
- **Failure states:** `NO_CATEGORY_MATCH`, `CATEGORY_LOW_CONFIDENCE`.

### 7. `IMAGE_ENRICHMENT`
- **Priority:** (1) the Content API image, (2) `IMAGE_ENRICHMENT_URL`, (3) our own category placeholder SVG.
- **Record:** `image_assets` (`sourceType`, `sourceUrl`, `cdnUrl`, `licenseState`, `license`, `attribution`, `enrichmentStatus`, `isFallback`, `verifiedAt`).
- **Rules:** every image URL is probed through the SSRF-safe client (must return `image/*`; remote SVG is rejected). `licenseState` is `VERIFIED` only when explicitly established (`imageLicenseVerified: true`, or the operator sets `CONTENT_API_IMAGES_LICENSED=true`). A license string alone gives `PROVIDER_ASSERTED`; no license gives `UNVERIFIED`. With `IMAGE_REQUIRE_LICENSE=true`, unverified images are never shown publicly and the placeholder is used instead.
- **Failure states:** `IMAGE_ENRICHMENT_FAILED`, `LICENSE_UNVERIFIED`. These never block publishing.

### 8. `OFFER_MATCHING`
- **Input:** the review's PRIMARY product (`content_entities`, role `PRIMARY`).
- **Rule:** no provider is called. The stage reads the commerce engine's `commerce_offers` for that product (`commerce_products.productEntityId`, set only after an exact identity match) and records the review's `dealStatus`: `MATCHED` (at least one FRESH priced offer observed within `PRODUCT_PRICE_MAX_AGE_HOURS`, default 48), `STALE` (offers exist but none is fresh), `UNAVAILABLE` (no offer yet, or no primary product; reason "commerce data comes from the commerce engine"), `NO_MATCH` (comparisons and guides cover several products).
- **Links:** an offer links to the seller's own URL (`destinationUrl`). An `affiliateUrl` is used only when a real affiliate provider generated it (`lib/affiliate/provider.ts`; `AFFILIATE_PROVIDER`, only `none` is implemented). No tracking parameter is ever added by us.
- **Legacy:** the former Sovrn stages `AFFILIATE_LINK` and `LINK_VERIFICATION` were removed. Their tables (`sovrn_offers_cache`, `sovrn_offer_matches`, `affiliate_links`, `sovrn_coupons`) and historical rows are kept untouched but are no longer read or written; open failures from those stages are resolved by `retry-failed`.

### 11. `PAGE_RENDER`
- **Output:** the PageRenderModel, a complete description of the public page with no internal data (no scores, chains or reasons). Its JSON-LD is chosen from the real data: Review when a rating exists, otherwise Article, plus Product/Offer only when a fresh commerce offer has a price (no `priceValidUntil` is invented).
- **Record:** `page_render_models` (`model`, `modelHash`, `builtAt`). It is rebuilt on publish, admin edits and overrides of published reviews; the review page also reloads fresh offers at request time, so an aged-out price is never shown.

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
| `retry-failed` | `job:retry-failed` | Retry due retryable failures |
| `publish-cycle` | `job:publish-cycle` | Auto-publish QA-passing queued reviews (when enabled) |
| `cleanup-cache` | `job:cleanup-cache` | Expired sessions, rate-limit buckets, stale locks |
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
