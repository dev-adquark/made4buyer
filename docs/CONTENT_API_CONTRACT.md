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
| `publishedAt` (`published_at`, `datePublished`, `pubDate`, `date`, `published`) | no | ISO-8601 or epoch; drives the dedupe date bucket |
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
