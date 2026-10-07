# Content API contract

The ingestion adapter (`lib/pipeline/content-source.ts` + `lib/pipeline/validate.ts`) accepts
any JSON feed that matches the following contract. Field names in parentheses are accepted
aliases, and the first non-empty value wins.

## Request

```
GET $CONTENT_API_URL
Accept: application/json
Authorization: Bearer $CONTENT_API_KEY        # or  $CONTENT_API_AUTH_HEADER: $CONTENT_API_KEY
```

Configuration (server-side env, set in Vercel → Production):

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `CONTENT_API_URL` | yes | — | First page URL (https). Without it the `ingest` job is SKIPPED and Admin → Integrations shows BLOCKED_BY_ENVIRONMENT |
| `CONTENT_API_KEY` | if the feed needs auth | — | Sent only server-side |
| `CONTENT_API_AUTH_HEADER` | no | `Authorization` | Any header name, e.g. `X-API-Key` (then the raw key is sent) |
| `CONTENT_API_AUTH_SCHEME` | no | `Bearer` | Prefix used only when the header is `Authorization` |
| `CONTENT_API_SOURCE_NAME` | no | API host | Stable source id stored with every item |
| `CONTENT_API_SCHEMA_VERSION` | no | `1` | Contract major version the feed must declare (when it declares one) |
| `CONTENT_API_MAX_PAGES` / `CONTENT_API_TIMEOUT_MS` / `CONTENT_API_MAX_RETRIES` | no | 5 / 15000 / 3 | Pagination and retry bounds |

Verify a feed before (or after) enabling it: `npx tsx scripts/verify-content-api.ts` fetches one
page, validates it and prints counts only.

## Versioning (contract v1)

The adapter implements contract **version 1**. A feed MAY declare its version in the body
(`schemaVersion`, `schema_version`, `apiVersion`, `version`, or `meta.schemaVersion`) or in a
header (`X-Schema-Version`, `Api-Version`, `X-Api-Version`); a leading `v` is ignored and only
the major number is compared. Minor versions (`1.x`) may add fields and are accepted.

The whole run is rejected with `CONTENT_API_SCHEMA_MISMATCH` (not retried; shown in Admin →
Ingestion runs, Admin → Failures and Admin → Integrations) when:

- the declared major version differs from `CONTENT_API_SCHEMA_VERSION` (default `1`), or
- a page has items but **none** of them has an id and a title under any accepted alias (the
  error lists the field names received, never their values).

Individual malformed items on an otherwise valid page are isolated as `CONTENT_SCHEMA_INVALID`
and never abort the batch. A response without an item array is `CONTENT_API_RESPONSE_INVALID`
(the error lists the top-level keys received).

## Response

Either an array of items, or an object containing one of `items`, `results`, `data`,
`reviews`, `articles` or `content`. For pagination, return `next`, `nextPage`, `next_page` or
`links.next` as an absolute or relative URL on the same origin.

## Item fields

| Field | Required | Notes |
|---|---|---|
| `id` (`sourceId`, `source_id`, `guid`, `uuid`) | yes | Stable per item; used for idempotent re-fetches |
| `title` (`headline`, `name`) | yes | 8–300 characters |
| `body` (`content`, `content.text`, `text`, `html`, `articleBody`) | yes | HTML is converted to plain text; ≥ 120 characters |
| `summary` (`excerpt`, `description`, `dek`, `subtitle`) | no | Derived from the first sentences of the body when missing |
| `url` (`sourceUrl`, `source_url`, `link`, `permalink`) | no | Absolute http(s) URL |
| `canonicalUrl` (`canonical_url`, `canonical`) | no | Used for dedupe; defaults to `url` |
| `publishedAt` (`published_at`, `datePublished`, `pubDate`, `date`, `published`) | required to publish a review | ISO-8601 or epoch; drives the dedupe date bucket, "latest" ordering and the date shown on pages. A value that can't be parsed, is more than 24 h in the future, or is before 1990 isolates the item as `CONTENT_SCHEMA_INVALID`. A review without it is held in QA (`PUBLICATION_DATE_MISSING`); we never guess a date. |
| `productName` (`product_name`, `product.name`, `product`) | recommended | Raises entity confidence to 0.95 |
| `brand` (`product.brand`, `manufacturer`) | recommended | |
| `category` (`section`, `product.category`) | recommended | Matched against the taxonomy aliases |
| `subcategory`, `tags` (`keywords`, `topics`) | no | Array or comma-separated string |
| `price` (`product.price`, `msrp`) | no | Number, `"$1,299"`, or `{ "amount": 1299, "currency": "USD" }` |
| `currency` | no | ISO-4217 |
| `modelNumber` (`model_number`, `model`, `product.model`, `sku`, `mpn`) | no | |
| `platform` (`os`, `operatingSystem`) | no | |
| `imageUrl` (`image_url`, `image.url`, `image`, `thumbnail`, `featuredImage`) | no | Probed before use |
| `imageLicense`, `imageAttribution`, `imageLicenseVerified` | no | License state is only `VERIFIED` with `imageLicenseVerified: true` |
| `author` (`author.name`, `byline`), `publisher` (`publisher.name`, `source`, `site`) | no | |
| `rating`, `ratingScale` (`bestRating`) | no | Review schema is emitted only when a rating is supplied |

## Example

```json
{
  "items": [
    {
      "id": "rev-123",
      "title": "Dell XPS 14 review: a premium Windows laptop",
      "summary": "Dell's 14-inch XPS pairs an OLED screen with strong performance.",
      "body": "<p>The XPS 14 is a premium Windows 11 laptop…</p>",
      "url": "https://publisher.example.com/reviews/dell-xps-14",
      "publishedAt": "2026-09-04T09:00:00Z",
      "productName": "Dell XPS 14",
      "brand": "Dell",
      "category": "Laptops",
      "price": 1699,
      "currency": "USD",
      "modelNumber": "9440",
      "imageUrl": "https://images.publisher.example.com/xps14.jpg",
      "imageLicense": "Editorial use licensed to Made4Buyers",
      "author": "Jane Doe",
      "publisher": "Publisher"
    }
  ],
  "next": "/v1/reviews?page=2"
}
```

A complete sample feed (SAMPLE data, fictional text) is in
[`fixtures/sample-content.json`](../fixtures/sample-content.json).
