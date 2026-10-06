# Product data enrichment

Every product fact on a public page is a value a legitimate source stated about **that exact
product**, with its source and check time. Nothing is guessed: a field no source states stays
"Not available", and a row that cannot apply (a platform for a kettle, a model for a category
guide) is not shown.

## Sources, strongest first

| Source | What it gives | How we reach it |
|---|---|---|
| Manufacturer page | identity, specs, price, availability | the product URL the review source linked, when it is on the brand's own domain |
| Structured feed | price, merchant | Sovrn price-comparison matches whose link was verified |
| Retailer page | price, availability, identifiers | the retailer page behind a verified offer, or the product URL the source linked |
| Review source | pros, cons, rating, identifiers, stated price | the review's own structured data (Apify extraction) |
| Other page | anything above | only as supporting evidence |

There is no web-search or product-database API configured, so pages are found only through URLs we
already hold for the product. Adding an approved product API means adding a source that writes
`STRUCTURED_FEED` facts (`lib/products/enrich.ts`).

## Rules

- **Exact product match first** (`lib/products/page-extract.ts` `sameProduct`): GTIN, then MPN /
  model number, else brand plus name with no differing variant words ("Barista Express" never
  takes data from "Barista Pro" or "Bambino Plus").
- **Per-field resolution** (`lib/products/facts.ts`): highest authority wins; agreement of two
  independent sites, or a manufacturer/feed fact matched by an identifier, is `VERIFIED`; a single
  other source is `SUPPORTED`; close-authority disagreement is `CONFLICTING` and not shown.
- **Freshness by volatility:** price, availability and retailer data go stale after
  `PRODUCT_PRICE_MAX_AGE_HOURS` (48 h) and are then not shown; ratings, descriptions and features
  after 30 days; identity and specs after a year. Facts are re-fetched at half their life.
- **Price tier** only from a current verified USD price against the category's published bands
  (`priceBands` in `lib/taxonomy/definitions.ts`); the methodology is stored and shown in Admin.
- **Platform** is not applicable outside tech categories.

## Operation

`enrich-products` (daily cron, Admin → Jobs, switch "Product data enrichment") enriches products on
published pages oldest-first and rebuilds their pages when the resolved data changed. Admin →
Product data shows completeness, missing, conflicting and stale fields, and every stored fact with
its source, match basis and observation time.
